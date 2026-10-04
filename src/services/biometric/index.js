// Lectores de huella: configuración, vínculo con empleados, sincronización y registro técnico.
// Las marcaciones entran al mismo motor de asistencia que usa el QR (registerAttendance).
import { db, audit } from '../../db.js';
import { openJson, sealJson } from '../../security.js';
import { localDate, nowIso, zonedToDate } from '../../time.js';
import { activeEmployeeById, registerAttendance } from '../attendance.js';
import { queueAttendanceConfirmation } from '../mail.js';
import { licenseGate } from '../license.js';
import { ensureDefaultBranch } from '../branches.js';
import { zktecoDriver } from './zktecoDriver.js';

const drivers = new Map([[zktecoDriver.id, zktecoDriver]]);
const runtime = new Map();
let workerTimer = null;
let stopping = false;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
const MAIL_RECENT_MS = 10 * 60 * 1000;

function state(id) {
  const key = Number(id);
  if (!runtime.has(key)) runtime.set(key, { syncing: false, nextPollAt: 0, chain: Promise.resolve() });
  return runtime.get(key);
}

// Una sola sesión a la vez por lector: el sondeo automático y los botones no se pisan.
function exclusive(id, work) {
  const st = state(id);
  const run = st.chain.then(work, work);
  st.chain = run.catch(() => {});
  return run;
}

function isLanAddress(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function intInRange(value, fallback, min, max, label) {
  const number = value === '' || value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} debe estar entre ${min} y ${max}.`);
  return number;
}

function getRow(id) {
  const row = db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(Number(id));
  if (!row) throw new Error('Lector no encontrado.');
  return row;
}

function connection(row) {
  let commKey = '';
  if (row.comm_key_sealed) {
    try { commKey = openJson(row.comm_key_sealed).key || ''; } catch { commKey = ''; }
  }
  return { ip: row.ip, port: row.port, commKey, verifySerial: (serial) => checkSerial(row, serial) };
}

// Un lector se reconoce por su número de serie, no por la IP. La primera vez que responde se guarda; después,
// si en esa IP contesta otro aparato, no se le leen marcaciones: sus IDs podrían ser de otras personas.
function checkSerial(row, serial) {
  const found = clean(serial, 40);
  if (!found) return;
  const known = db.prepare('SELECT serial_number FROM biometric_devices WHERE id = ?').get(row.id)?.serial_number || '';
  if (known === found) return;
  if (known) {
    throw new Error(`En ${row.ip}:${row.port} responde otro aparato (serie ${found}); el registrado es ${known}. Si lo reemplazaste, abrí Configurar y marcá "Se cambió el aparato".`);
  }
  const other = db.prepare('SELECT name FROM biometric_devices WHERE serial_number = ? AND id <> ?').get(found, row.id);
  if (other) throw new Error(`Este aparato (serie ${found}) ya está registrado como "${other.name}". No se puede agregar dos veces.`);
  db.prepare('UPDATE biometric_devices SET serial_number = ? WHERE id = ?').run(found, row.id);
}

// Las instalaciones que venían de una sola sucursal: sus lectores quedan en la primera sucursal, y el número de
// serie que ya se conocía por el diagnóstico pasa a ser su identidad.
function adoptDevices() {
  const branchId = ensureDefaultBranch();
  if (branchId) db.prepare('UPDATE biometric_devices SET branch_id = ? WHERE branch_id IS NULL').run(branchId);
  for (const row of db.prepare("SELECT id, info_json FROM biometric_devices WHERE serial_number = ''").all()) {
    let serial = '';
    try { serial = clean(JSON.parse(row.info_json || '{}').serial, 40); } catch { serial = ''; }
    if (!serial) continue;
    try { db.prepare('UPDATE biometric_devices SET serial_number = ? WHERE id = ?').run(serial, row.id); }
    catch { /* otro lector ya tiene ese número: se resuelve cuando responda */ }
  }
}

function driverFor(row) {
  const driver = drivers.get(row.driver);
  if (!driver) throw new Error('Este tipo de lector no está soportado.');
  return driver;
}

function statusOf(row) {
  if (!row.active) return 'DISABLED';
  if (state(row.id).syncing) return 'SYNCING';
  if (row.consecutive_failures > 0) return 'DISCONNECTED';
  if (!row.last_contact_at) return 'PENDING';
  const staleMs = Math.max(row.poll_seconds * 4, 180) * 1000;
  return Date.now() - Date.parse(row.last_contact_at) > staleMs ? 'DISCONNECTED' : 'CONNECTED';
}

function publicDevice(row) {
  const today = localDate();
  let info = {};
  try { info = JSON.parse(row.info_json || '{}'); } catch { info = {}; }
  const branch = row.branch_id ? db.prepare('SELECT name, code FROM branches WHERE id = ?').get(row.branch_id) : null;
  return {
    id: row.id,
    name: row.name,
    branchId: row.branch_id ?? null,
    branchName: branch?.name || '',
    branchCode: branch?.code || '',
    serialNumber: row.serial_number || '',
    driver: row.driver,
    ip: row.ip,
    port: row.port,
    deviceNumber: row.device_number,
    hasCommKey: Boolean(row.comm_key_sealed),
    location: row.location,
    active: Boolean(row.active),
    pollSeconds: row.poll_seconds,
    minGapSeconds: row.min_gap_seconds,
    status: statusOf(row),
    lastContactAt: row.last_contact_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    consecutiveFailures: row.consecutive_failures,
    info,
    punchesToday: db.prepare('SELECT COUNT(*) AS n FROM biometric_events WHERE device_id = ? AND punched_local LIKE ?')
      .get(row.id, `${today}%`).n,
    linkedEmployees: db.prepare(`SELECT COUNT(*) AS n FROM employee_biometric_map m JOIN employees e ON e.id = m.employee_id
      WHERE m.device_id = ? AND COALESCE(e.archived, 0) = 0`).get(row.id).n,
    unlinkedEvents: db.prepare("SELECT COUNT(*) AS n FROM biometric_events WHERE device_id = ? AND status = 'UNMAPPED'").get(row.id).n
  };
}

function addLog(row, { action, result = 'OK', received = 0, imported = 0, duplicates = 0, message = '', durationMs = 0 }) {
  const inserted = db.prepare(`INSERT INTO biometric_sync_logs(device_id, device_name, action, result, received, imported,
      duplicates, message, duration_ms, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.name, action, result, received, imported, duplicates, String(message).slice(0, 500), durationMs, nowIso());
  db.prepare('DELETE FROM biometric_sync_logs WHERE id <= ?').run(Number(inserted.lastInsertRowid) - 5000);
}

function markContact(row) {
  db.prepare(`UPDATE biometric_devices SET last_contact_at = ?, consecutive_failures = 0, last_error = '' WHERE id = ?`)
    .run(nowIso(), row.id);
}

function markFailure(row, error) {
  const message = String(error?.message || error).slice(0, 300);
  db.prepare(`UPDATE biometric_devices SET consecutive_failures = consecutive_failures + 1, last_error = ?, last_error_at = ?
              WHERE id = ?`).run(message, nowIso(), row.id);
  return message;
}

export function listDevices() {
  adoptDevices();
  return db.prepare('SELECT * FROM biometric_devices ORDER BY active DESC, name').all().map(publicDevice);
}

export function biometricSummary() {
  const devices = listDevices().filter((device) => device.active);
  return {
    devices: devices.length,
    connected: devices.filter((device) => ['CONNECTED', 'SYNCING'].includes(device.status)).length,
    disconnected: devices.filter((device) => device.status === 'DISCONNECTED').length
  };
}

function normalizeDevice(input, current = null) {
  const name = clean(input.name ?? current?.name, 80);
  const ip = clean(input.ip ?? current?.ip, 15);
  const location = clean(input.location ?? current?.location, 120);
  if (name.length < 2) throw new Error('Indique un nombre para el lector.');
  if (!isLanAddress(ip)) throw new Error('La IP debe ser una dirección de la red local (por ejemplo 192.168.1.202).');
  const port = intInRange(input.port, current?.port ?? 4370, 1, 65535, 'El puerto');
  const deviceNumber = intInRange(input.deviceNumber, current?.device_number ?? 1, 1, 254, 'El número de dispositivo');
  const pollSeconds = intInRange(input.pollSeconds, current?.poll_seconds ?? 30, 10, 3600, 'El intervalo de sincronización');
  const minGapSeconds = intInRange(input.minGapSeconds, current?.min_gap_seconds ?? 120, 0, 3600, 'El tiempo anti-doble marcación');
  let sealed = current?.comm_key_sealed || '';
  const suppliedKey = String(input.commKey ?? '').trim();
  if (input.clearCommKey === true) sealed = '';
  else if (suppliedKey) {
    if (!/^\d{1,9}$/.test(suppliedKey)) throw new Error('La clave de comunicación del lector debe ser numérica.');
    sealed = Number(suppliedKey) === 0 ? '' : sealJson({ key: suppliedKey });
  }
  // Sucursal: la que se elija, la que ya tenía, o la primera si la instalación todavía tiene una sola.
  const wantedBranch = input.branchId === undefined || input.branchId === '' || input.branchId === null
    ? (current?.branch_id ?? ensureDefaultBranch())
    : Number(input.branchId);
  let branchId = null;
  if (wantedBranch != null) {
    const branch = db.prepare('SELECT id, active FROM branches WHERE id = ?').get(wantedBranch);
    if (!branch) throw new Error('La sucursal elegida no existe.');
    if (!branch.active && branch.id !== current?.branch_id) throw new Error('La sucursal elegida está inactiva.');
    branchId = branch.id;
  }
  return { name, ip, port, deviceNumber, pollSeconds, minGapSeconds, location, sealed, branchId };
}

function friendlyUnique(error) {
  const text = String(error.message);
  if (!text.includes('UNIQUE')) return error;
  if (text.includes('serial_number')) return new Error('Ese aparato ya está registrado (mismo número de serie).');
  return new Error(text.includes('.name') ? 'Ya existe un lector con ese nombre.' : 'Ya existe un lector con esa IP y puerto.');
}

export function createDevice(input) {
  const device = normalizeDevice(input);
  const now = nowIso();
  const since = zonedToDate(`${localDate()} 00:00:00`).toISOString();
  try {
    const result = db.prepare(`INSERT INTO biometric_devices(name, ip, port, device_number, comm_key_sealed, location,
        poll_seconds, min_gap_seconds, import_since, branch_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(device.name, device.ip, device.port, device.deviceNumber, device.sealed, device.location,
        device.pollSeconds, device.minGapSeconds, since, device.branchId, now, now);
    audit('ADMIN', 'CREATE', 'BIOMETRIC_DEVICE', result.lastInsertRowid, { name: device.name, ip: device.ip, port: device.port, branchId: device.branchId });
    return publicDevice(getRow(result.lastInsertRowid));
  } catch (error) { throw friendlyUnique(error); }
}

export function updateDevice(id, input) {
  const current = getRow(id);
  const device = normalizeDevice(input, current);
  const moved = device.ip !== current.ip || device.port !== current.port;
  try {
    db.prepare(`UPDATE biometric_devices SET name = ?, ip = ?, port = ?, device_number = ?, comm_key_sealed = ?,
        location = ?, poll_seconds = ?, min_gap_seconds = ?, branch_id = ?, updated_at = ? WHERE id = ?`)
      .run(device.name, device.ip, device.port, device.deviceNumber, device.sealed, device.location,
        device.pollSeconds, device.minGapSeconds, device.branchId, nowIso(), current.id);
  } catch (error) { throw friendlyUnique(error); }
  // "Se cambió el aparato": se olvida el número de serie y el próximo que responda pasa a ser el registrado.
  const replaced = input.resetSerial === true || input.resetSerial === 'true' || input.resetSerial === 'on';
  if (replaced) {
    db.prepare("UPDATE biometric_devices SET serial_number = '', info_json = '{}', consecutive_failures = 0, last_error = '' WHERE id = ?").run(current.id);
    audit('ADMIN', 'BIOMETRIC_DEVICE_REPLACED', 'BIOMETRIC_DEVICE', current.id, { previousSerial: current.serial_number });
  }
  if (moved || replaced) db.prepare('UPDATE biometric_devices SET last_record_count = NULL WHERE id = ?').run(current.id);
  state(current.id).nextPollAt = 0;
  audit('ADMIN', 'UPDATE', 'BIOMETRIC_DEVICE', current.id, { name: device.name, ip: device.ip, port: device.port,
    commKeyChanged: device.sealed !== current.comm_key_sealed });
  return publicDevice(getRow(current.id));
}

export function setDeviceActive(id, active) {
  const row = getRow(id);
  db.prepare(`UPDATE biometric_devices SET active = ?, consecutive_failures = 0, last_error = '', updated_at = ? WHERE id = ?`)
    .run(active ? 1 : 0, nowIso(), row.id);
  state(row.id).nextPollAt = 0;
  audit('ADMIN', active ? 'ACTIVATE' : 'DEACTIVATE', 'BIOMETRIC_DEVICE', row.id);
  return publicDevice(getRow(row.id));
}

// ---------- Vínculo empleado ↔ ID del lector ----------

export function listMappings(deviceId) {
  const device = getRow(deviceId);
  const rows = db.prepare(`SELECT e.id AS employeeId, e.employee_code AS employeeCode, e.name, e.active,
        m.zk_user_id AS zkUserId
      FROM employees e LEFT JOIN employee_biometric_map m ON m.employee_id = e.id AND m.device_id = ?
      WHERE COALESCE(e.archived, 0) = 0 ORDER BY e.active DESC, e.name`).all(device.id);
  for (const row of rows) row.sharedId = row.zkUserId ? '' : (idOnOtherReaders(row.employeeId, device.id)?.id || '');
  return { deviceId: device.id, deviceName: device.name, suggestedId: nextFreeId(), rows };
}

// El ID biométrico es de la persona, no del lector: un empleado usa el mismo ID en todos los lectores y un ID
// nunca es de dos personas. Tampoco se sugiere uno que ya se usó (aunque el empleado se haya eliminado), para
// que marcaciones viejas de esa huella no se le atribuyan a alguien nuevo.
function nextFreeId() {
  const seen = [
    ...db.prepare('SELECT zk_user_id AS id FROM employee_biometric_map').all(),
    ...db.prepare('SELECT DISTINCT zk_user_id AS id FROM biometric_events').all()
  ].map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0 && id < 999999999);
  return String(seen.length ? Math.max(...seen) + 1 : 1);
}

function idOnOtherReaders(employeeId, deviceId) {
  return db.prepare(`SELECT m.zk_user_id AS id, d.name AS device FROM employee_biometric_map m
      JOIN biometric_devices d ON d.id = m.device_id
      WHERE m.employee_id = ? AND m.device_id <> ? ORDER BY m.id LIMIT 1`).get(employeeId, deviceId) || null;
}

export function setMapping({ employeeId, deviceId, zkUserId }) {
  const device = getRow(deviceId);
  const employee = db.prepare('SELECT id, name FROM employees WHERE id = ? AND COALESCE(archived, 0) = 0').get(Number(employeeId));
  if (!employee) throw new Error('Empleado no encontrado.');
  const value = String(zkUserId ?? '').trim();
  if (!value) {
    db.prepare('DELETE FROM employee_biometric_map WHERE employee_id = ? AND device_id = ?').run(employee.id, device.id);
    audit('ADMIN', 'BIOMETRIC_UNLINK', 'EMPLOYEE', employee.id, { deviceId: device.id });
    return { zkUserId: '', reprocessed: 0 };
  }
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new Error('El ID biométrico debe ser un número entre 1 y 999999999.');
  const owner = db.prepare(`SELECT e.name, d.name AS device FROM employee_biometric_map m
      JOIN employees e ON e.id = m.employee_id JOIN biometric_devices d ON d.id = m.device_id
      WHERE m.zk_user_id = ? AND m.employee_id <> ? ORDER BY (m.device_id = ?) DESC LIMIT 1`).get(value, employee.id, device.id);
  if (owner) throw new Error(`El ID biométrico ${value} ya está asignado a ${owner.name} (${owner.device}). Cada persona tiene su propio ID en todos los lectores.`);
  const elsewhere = idOnOtherReaders(employee.id, device.id);
  if (elsewhere && elsewhere.id !== value) {
    throw new Error(`${employee.name} ya usa el ID ${elsewhere.id} en ${elsewhere.device}. Tiene que usar el mismo ID en todos los lectores.`);
  }
  db.prepare(`INSERT INTO employee_biometric_map(employee_id, device_id, zk_user_id, created_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(device_id, employee_id) DO UPDATE SET zk_user_id = excluded.zk_user_id`)
    .run(employee.id, device.id, value, nowIso());
  audit('ADMIN', 'BIOMETRIC_LINK', 'EMPLOYEE', employee.id, { deviceId: device.id, zkUserId: value });

  const waiting = db.prepare(`SELECT id FROM biometric_events WHERE device_id = ? AND zk_user_id = ? AND status = 'UNMAPPED'
      ORDER BY punched_local`).all(device.id, value);
  const usedByOther = db.prepare(`SELECT 1 FROM biometric_events WHERE device_id = ? AND zk_user_id = ?
      AND employee_id IS NOT NULL AND employee_id <> ? LIMIT 1`).get(device.id, value, employee.id);
  if (usedByOther) {
    // Ese ID perteneció a otra persona: sus marcaciones sueltas no se le atribuyen al nuevo dueño.
    db.prepare(`UPDATE biometric_events SET status = 'IGNORED', note = 'El ID fue reasignado a otro empleado.', processed_at = ?
        WHERE device_id = ? AND zk_user_id = ? AND status = 'UNMAPPED'`).run(nowIso(), device.id, value);
    return { zkUserId: value, reprocessed: 0, discarded: waiting.length };
  }
  for (const event of waiting) processStoredEvent(event.id, device);
  return { zkUserId: value, reprocessed: waiting.length, discarded: 0 };
}

export function employeeBiometrics(employeeId) {
  return db.prepare(`SELECT d.id AS deviceId, d.name AS deviceName, d.active, m.zk_user_id AS zkUserId
      FROM biometric_devices d LEFT JOIN employee_biometric_map m ON m.device_id = d.id AND m.employee_id = ?
      ORDER BY d.active DESC, d.name`).all(Number(employeeId))
    .map((row) => ({ ...row, active: Boolean(row.active),
      suggestedId: row.zkUserId || idOnOtherReaders(Number(employeeId), row.deviceId)?.id || nextFreeId() }));
}

// ---------- Ingreso de marcaciones (idempotente) ----------

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function decide(event, device) {
  const occurred = zonedToDate(event.punched_local);
  if (!occurred) return { status: 'INVALID', note: 'Fecha u hora inválida recibida del lector.' };
  if (occurred.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    return { status: 'INVALID', note: 'Fecha futura: revise el reloj del lector.', occurred };
  }
  if (occurred.getTime() < Date.parse(device.import_since)) {
    return { status: 'IGNORED', note: 'Anterior a la activación del lector en Qubiq.', occurred };
  }
  const mapping = db.prepare('SELECT employee_id FROM employee_biometric_map WHERE device_id = ? AND zk_user_id = ?')
    .get(device.id, event.zk_user_id);
  if (!mapping) return { status: 'UNMAPPED', note: 'ID del lector sin empleado vinculado.', occurred };
  const employee = activeEmployeeById(mapping.employee_id);
  if (!employee) return { status: 'REJECTED', note: 'Empleado inactivo o eliminado.', occurred, employeeId: mapping.employee_id };
  try {
    const result = registerAttendance(employee, { at: occurred, source: 'BIO', minGapSeconds: device.min_gap_seconds });
    return { status: 'APPLIED', note: result.eventType === 'ENTRY' ? 'Entrada' : 'Salida', occurred, employeeId: employee.id, result };
  } catch (error) {
    const unique = String(error.message).includes('UNIQUE');
    return {
      status: error.code === 'REPEATED' ? 'IGNORED' : 'REJECTED',
      note: unique ? 'Ya existe una marcación equivalente para esa jornada.' : String(error.message).slice(0, 300),
      occurred,
      employeeId: employee.id
    };
  }
}

function applyDecision(eventId, decision) {
  db.prepare(`UPDATE biometric_events SET status = ?, note = ?, occurred_at = ?, employee_id = ?, attendance_id = ?,
      processed_at = ? WHERE id = ?`)
    .run(decision.status, decision.note, decision.occurred ? decision.occurred.toISOString() : null,
      decision.employeeId ?? null, decision.result?.attendanceId ?? null, nowIso(), eventId);
}

function notify(decision) {
  const result = decision.result;
  if (!result?.notificationEmail || Date.now() - decision.occurred.getTime() > MAIL_RECENT_MS) return;
  try {
    queueAttendanceConfirmation({ to: result.notificationEmail, employee: result.employee,
      eventType: result.eventType, date: result.date, time: result.time });
  } catch { /* el correo nunca bloquea la asistencia */ }
}

function processStoredEvent(eventId, device) {
  const decision = transaction(() => {
    const event = db.prepare('SELECT * FROM biometric_events WHERE id = ?').get(eventId);
    const outcome = decide(event, device);
    applyDecision(event.id, outcome);
    return outcome;
  });
  notify(decision);
  return decision;
}

const rawStamp = (t) => `!${t?.year}-${t?.month}-${t?.day} ${t?.hour}:${t?.minute}:${t?.second}`;

export function ingestEvents(deviceId, events, { full = false } = {}) {
  const device = getRow(deviceId);
  const summary = { received: events.length, imported: 0, duplicates: 0, applied: 0, unmapped: 0, rejected: 0, invalid: 0 };
  const watermark = !full && device.last_event_local
    ? new Date(Date.parse(`${device.last_event_local.replace(' ', 'T')}Z`) - 48 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  const ordered = [...events].sort((a, b) => String(a.localStamp || '').localeCompare(String(b.localStamp || '')));
  const insert = db.prepare(`INSERT INTO biometric_events(device_id, zk_user_id, punched_local, verify_status, punch_state,
      status, note, received_at) VALUES(?, ?, ?, ?, ?, 'INVALID', '', ?) ON CONFLICT DO NOTHING`);
  let newest = device.last_event_local || '';

  for (const event of ordered) {
    const userId = String(event.userId ?? '').replace(/[^\x21-\x7E]/g, '').slice(0, 24) || '?';
    const local = event.valid && event.localStamp ? event.localStamp : rawStamp(event.time);
    if (event.valid && watermark && local < watermark) { summary.duplicates += 1; continue; }
    const decision = transaction(() => {
      const inserted = insert.run(device.id, userId, local, Number(event.verifyStatus) || 0, Number(event.punchState) || 0, nowIso());
      if (!inserted.changes) return null;
      const outcome = event.valid
        ? decide({ zk_user_id: userId, punched_local: local }, device)
        : { status: 'INVALID', note: 'Dato inválido recibido del lector (fecha o ID).' };
      applyDecision(Number(inserted.lastInsertRowid), outcome);
      return outcome;
    });
    if (!decision) { summary.duplicates += 1; continue; }
    summary.imported += 1;
    if (decision.status === 'APPLIED') summary.applied += 1;
    else if (decision.status === 'UNMAPPED') summary.unmapped += 1;
    else if (decision.status === 'INVALID') summary.invalid += 1;
    else summary.rejected += 1;
    if (decision.status !== 'INVALID' && local > newest) newest = local;
    notify(decision);
  }
  if (newest && newest !== device.last_event_local) {
    db.prepare('UPDATE biometric_devices SET last_event_local = ? WHERE id = ?').run(newest, device.id);
  }
  return summary;
}

function describe(summary) {
  const parts = [`${summary.received} eventos recibidos`, `${summary.imported} nuevos`, `${summary.duplicates} existentes`];
  if (summary.unmapped) parts.push(`${summary.unmapped} sin empleado vinculado`);
  if (summary.rejected) parts.push(`${summary.rejected} no aplicados`);
  if (summary.invalid) parts.push(`${summary.invalid} inválidos`);
  return parts.join(' · ');
}

// ---------- Operaciones contra el lector ----------

export function syncDevice(id, { full = false, manual = false, action = 'Sincronización' } = {}) {
  return exclusive(id, async () => {
    const row = getRow(id);
    if (!row.active && !manual) return { skipped: true };
    const st = state(row.id);
    // Misma regla que el QR: con la licencia bloqueada no se registran marcaciones. Las huellas quedan
    // guardadas en el lector y entran solas cuando la licencia vuelve a estar activa.
    const gate = licenseGate();
    if (gate.blockQrGeneration) {
      st.nextPollAt = Date.now() + 60 * 1000;
      const message = gate.banner?.text || 'La licencia no está activa.';
      if (manual) throw Object.assign(new Error(message), { status: 402 });
      return { ok: false, paused: true, error: message };
    }
    const driver = driverFor(row);
    const started = Date.now();
    const recovering = row.consecutive_failures > 0;
    const everything = full || recovering || row.last_record_count == null;
    // Respaldo: aunque el contador del lector no cambie, se descarga al menos cada 10 minutos.
    const periodic = Date.now() - (st.lastDownloadAt || 0) > 10 * 60 * 1000;
    st.syncing = true;
    try {
      if (!everything && !periodic) {
        const peek = await driver.peek(connection(row));
        checkSerial(row, peek.serial);
        if (peek.sizes.records === row.last_record_count) {
          markContact(row);
          if (manual) addLog(row, { action, message: 'Sin marcaciones nuevas en el lector.', durationMs: Date.now() - started });
          return { ok: true, received: 0, imported: 0, duplicates: 0, upToDate: true };
        }
      }
      const data = await driver.readAttendance(connection(row));
      st.lastDownloadAt = Date.now();
      const summary = ingestEvents(row.id, data.events, { full: everything });
      db.prepare(`UPDATE biometric_devices SET last_contact_at = ?, last_sync_at = ?, consecutive_failures = 0, last_error = '',
          last_record_count = ? WHERE id = ?`).run(nowIso(), nowIso(), data.sizes.records, row.id);
      if (manual || recovering || summary.imported > 0 || row.last_record_count == null) {
        addLog(row, { action: recovering ? 'Reconexión' : action, received: summary.received, imported: summary.imported,
          duplicates: summary.duplicates, message: describe(summary), durationMs: Date.now() - started });
      }
      return { ok: true, ...summary };
    } catch (error) {
      const message = markFailure(row, error);
      if (manual || !recovering) addLog(row, { action, result: 'ERROR', message, durationMs: Date.now() - started });
      if (manual) throw new Error(message);
      return { ok: false, error: message };
    } finally {
      st.syncing = false;
      const fresh = db.prepare('SELECT poll_seconds, consecutive_failures FROM biometric_devices WHERE id = ?').get(row.id);
      const backoff = fresh ? Math.min(fresh.poll_seconds * 2 ** Math.min(fresh.consecutive_failures, 3), 300) : 30;
      st.nextPollAt = Date.now() + Math.max(fresh?.poll_seconds || 30, backoff) * 1000;
    }
  });
}

export function testConnection(id) {
  return exclusive(id, async () => {
    const row = getRow(id);
    const started = Date.now();
    try {
      const result = await driverFor(row).testConnection(connection(row));
      checkSerial(row, result.serial);
      markContact(row);
      addLog(row, { action: 'Prueba de conexión', message: `Responde en ${result.latencyMs} ms`, durationMs: Date.now() - started });
      if (row.consecutive_failures > 0) state(row.id).nextPollAt = 0;
      return { ok: true, latencyMs: result.latencyMs, address: `${row.ip}:${row.port}` };
    } catch (error) {
      const message = markFailure(row, error);
      addLog(row, { action: 'Prueba de conexión', result: 'ERROR', message, durationMs: Date.now() - started });
      return { ok: false, error: message, address: `${row.ip}:${row.port}` };
    }
  });
}

export function diagnostics(id) {
  return exclusive(id, async () => {
    const row = getRow(id);
    const started = Date.now();
    const base = { address: `${row.ip}:${row.port}`, checkedAt: nowIso() };
    try {
      const info = await driverFor(row).diagnostics(connection(row));
      checkSerial(row, info.serial);
      const deviceInstant = info.deviceTime ? zonedToDate(info.deviceTime) : null;
      const stored = { serial: info.serial || '', model: info.model || '', platform: info.platform || '',
        firmware: info.firmware || '', mac: info.mac || '' };
      db.prepare('UPDATE biometric_devices SET info_json = ? WHERE id = ?').run(JSON.stringify(stored), row.id);
      markContact(row);
      addLog(row, { action: 'Diagnóstico', message: `Responde en ${info.latencyMs} ms`, durationMs: Date.now() - started });
      return {
        ...base, online: true, latencyMs: info.latencyMs, ...stored,
        deviceTime: info.deviceTime,
        clockDriftSeconds: deviceInstant ? Math.round((deviceInstant.getTime() - Date.now()) / 1000) : null,
        records: info.sizes.records, recordsCapacity: info.sizes.recordsCapacity,
        users: info.sizes.users, fingers: info.sizes.fingers,
        pendingEvents: row.last_record_count == null ? null : Math.max(0, info.sizes.records - row.last_record_count),
        device: publicDevice(getRow(row.id))
      };
    } catch (error) {
      const message = markFailure(row, error);
      addLog(row, { action: 'Diagnóstico', result: 'ERROR', message, durationMs: Date.now() - started });
      return { ...base, online: false, error: message, device: publicDevice(getRow(row.id)) };
    }
  });
}

const asciiName = (name) => String(name).normalize('NFD').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 23);

// Asigna el ID, crea el usuario en el lector y lo deja pidiendo el dedo.
export async function enrollEmployee({ employeeId, deviceId, zkUserId, replace = false }) {
  const device = getRow(deviceId);
  if (!device.active) throw new Error('Este lector está desactivado.');
  const employee = db.prepare('SELECT id, name FROM employees WHERE id = ? AND COALESCE(archived, 0) = 0').get(Number(employeeId));
  if (!employee) throw new Error('Empleado no encontrado.');
  const current = db.prepare('SELECT zk_user_id FROM employee_biometric_map WHERE employee_id = ? AND device_id = ?')
    .get(employee.id, device.id)?.zk_user_id;
  const wanted = String(zkUserId ?? '').trim() || current || idOnOtherReaders(employee.id, device.id)?.id || nextFreeId();
  if (wanted !== current) setMapping({ employeeId: employee.id, deviceId: device.id, zkUserId: wanted });

  return exclusive(device.id, async () => {
    const started = Date.now();
    const st = state(device.id);
    st.syncing = true;
    try {
      const result = await driverFor(device).enrollUser(connection(device), {
        userId: wanted, name: asciiName(employee.name), replace: replace === true || replace === 'true' });
      markContact(device);
      addLog(device, { action: 'Registro de huella', result: result.enrolled ? 'OK' : 'ERROR',
        message: result.enrolled ? `Huella registrada para ${employee.name} (ID ${wanted})`
          : `No se completó el registro de ${employee.name} (ID ${wanted})`, durationMs: Date.now() - started });
      audit('ADMIN', 'BIOMETRIC_ENROLL', 'EMPLOYEE', employee.id, { deviceId: device.id, zkUserId: wanted, enrolled: result.enrolled });
      return { zkUserId: wanted, enrolled: result.enrolled, outcome: result.outcome, userCreated: result.created };
    } catch (error) {
      const message = String(error.message).slice(0, 300);
      addLog(device, { action: 'Registro de huella', result: 'ERROR', message, durationMs: Date.now() - started });
      return { zkUserId: wanted, enrolled: false, outcome: 'ERROR', error: message };
    } finally {
      st.syncing = false;
    }
  });
}

export function listLogs({ deviceId = null, limit = 100 } = {}) {
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  return deviceId
    ? db.prepare('SELECT * FROM biometric_sync_logs WHERE device_id = ? ORDER BY id DESC LIMIT ?').all(Number(deviceId), max)
    : db.prepare('SELECT * FROM biometric_sync_logs ORDER BY id DESC LIMIT ?').all(max);
}

export function listEvents({ deviceId = null, limit = 100 } = {}) {
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  const sql = `SELECT b.id, b.device_id AS deviceId, d.name AS deviceName, br.code AS branchCode, br.name AS branchName,
      b.zk_user_id AS zkUserId, b.punched_local AS punchedLocal, b.status, b.note, e.name AS employee
    FROM biometric_events b JOIN biometric_devices d ON d.id = b.device_id
    LEFT JOIN branches br ON br.id = d.branch_id
    LEFT JOIN employees e ON e.id = b.employee_id`;
  return deviceId
    ? db.prepare(`${sql} WHERE b.device_id = ? ORDER BY b.id DESC LIMIT ?`).all(Number(deviceId), max)
    : db.prepare(`${sql} ORDER BY b.id DESC LIMIT ?`).all(max);
}

// ---------- Agente en segundo plano ----------

function tick() {
  if (stopping) return;
  let rows = [];
  try { rows = db.prepare('SELECT id FROM biometric_devices WHERE active = 1').all(); }
  catch { return; } // la base se está cerrando
  for (const row of rows) {
    const st = state(row.id);
    if (st.syncing || Date.now() < st.nextPollAt) continue;
    st.nextPollAt = Date.now() + 15000;
    syncDevice(row.id).catch((error) => { if (!stopping) console.error('Lector biométrico:', error.message); });
  }
}

export function startBiometricWorker() {
  stopping = false;
  try { adoptDevices(); } catch { /* se reintenta al abrir la pantalla de lectores */ }
  if (workerTimer) return;
  workerTimer = setInterval(tick, 3000);
  workerTimer.unref?.();
  setTimeout(tick, 500).unref?.();
}

export function stopBiometricWorker() {
  stopping = true;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  runtime.clear();
}
