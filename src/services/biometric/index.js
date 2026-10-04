// Lectores de huella: configuración, vínculo con empleados, sincronización y registro técnico.
// Las marcaciones entran al mismo motor de asistencia que usa el QR (registerAttendance).
import { createHash } from 'node:crypto';
import { db, audit } from '../../db.js';
import { openJson, sealJson } from '../../security.js';
import { localDate, nowIso, zonedToDate } from '../../time.js';
import { activeEmployeeById, registerAttendance } from '../attendance.js';
import { queueAttendanceConfirmation } from '../mail.js';
import { licenseGate } from '../license.js';
import { ensureDefaultBranch } from '../branches.js';
import { centralRequest, enqueueEvent, isAgentMode, kickLink, listQueue, setDeviceReporter } from '../branchLink.js';
import { zktecoDriver } from './zktecoDriver.js';

const drivers = new Map([[zktecoDriver.id, zktecoDriver]]);
const runtime = new Map();
let workerTimer = null;
let stopping = false;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
// Hasta cuánto atraso se acepta reordenar una jornada sola. Más viejo que eso puede caer en una planilla ya
// cerrada, así que se deja para corregir a mano.
const LATE_REORDER_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAIL_RECENT_MS = 10 * 60 * 1000;
// Lector de otra sucursal (llega a través de la computadora de esa sucursal): cuánto silencio se tolera.
const REMOTE_AGENT_SILENT_MS = 3 * 60 * 1000;
const MAX_READERS_PER_AGENT = 10;
const REMOTE_ONLY = 'Este lector está en otra sucursal: se maneja desde la computadora de esa sucursal.';
const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });

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

function assertLocal(row) {
  if (row.agent_id) throw new Error(REMOTE_ONLY);
}

const agentOf = (row) => (row.agent_id
  ? db.prepare('SELECT id, name, active, last_seen_at FROM branch_agents WHERE id = ?').get(row.agent_id) || null
  : null);
const agentSilent = (agent) => !agent?.last_seen_at || Date.now() - Date.parse(agent.last_seen_at) > REMOTE_AGENT_SILENT_MS;

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
  const other = db.prepare('SELECT id, name, agent_id, active FROM biometric_devices WHERE serial_number = ? AND id <> ?').get(found, row.id);
  if (other && !releaseSerial(other, row.name)) {
    throw new Error(`Este aparato (serie ${found}) ya está registrado como "${other.name}"${other.agent_id ? ', en otra sucursal. Si se mudó, primero desactivá ese lector.' : '. No se puede agregar dos veces.'}`);
  }
  db.prepare('UPDATE biometric_devices SET serial_number = ? WHERE id = ?').run(found, row.id);
}

// Un lector de otra sucursal que el administrador desactivó suelta su número de serie: así el aparato se puede
// mudar a otra sucursal o conectarse directo a la central. Sus marcaciones ya registradas quedan como estaban.
function releaseSerial(holder, claimedBy) {
  if (!holder.agent_id || holder.active) return false;
  db.prepare("UPDATE biometric_devices SET serial_number = '', ip = ? WHERE id = ?").run(`liberado:${holder.id}`, holder.id);
  audit('SYSTEM', 'BIOMETRIC_DEVICE_RELEASED', 'BIOMETRIC_DEVICE', holder.id, { name: holder.name, claimedBy });
  return true;
}

// Identificador único de una marcación de huella. Se calcula con el número de serie del lector, el ID del usuario
// y la hora de la marcación, no al azar: si la misma marcación se lee o se envía otra vez (reintento sin
// internet, agente reinstalado), da el mismo valor y el central no la registra dos veces.
export function eventUuid(serial, zkUserId, punchedLocal, verifyStatus = 0, punchState = 0) {
  const hash = createHash('sha1')
    .update(`qubiq-control/marcacion/v1|${serial}|${zkUserId}|${punchedLocal}|${Number(verifyStatus) || 0}|${Number(punchState) || 0}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Completa lo que traían las versiones anteriores: sucursal y lector de cada marcación, e identificador único de
// las marcaciones de huella. Los índices parciales hacen que, cuando no queda nada por completar, no cueste nada.
function adoptMarks(defaultBranchId) {
  db.exec(`UPDATE biometric_events SET branch_id = (SELECT d.branch_id FROM biometric_devices d WHERE d.id = biometric_events.device_id)
           WHERE branch_id IS NULL AND EXISTS (SELECT 1 FROM biometric_devices d WHERE d.id = biometric_events.device_id AND d.branch_id IS NOT NULL)`);
  const pending = db.prepare(`SELECT b.id, b.zk_user_id, b.punched_local, b.verify_status, b.punch_state, d.serial_number
      FROM biometric_events b JOIN biometric_devices d ON d.id = b.device_id
      WHERE b.event_uuid IS NULL AND d.serial_number <> '' LIMIT 5000`).all();
  const setUuid = db.prepare('UPDATE OR IGNORE biometric_events SET event_uuid = ? WHERE id = ?');
  for (const row of pending) setUuid.run(eventUuid(row.serial_number, row.zk_user_id, row.punched_local, row.verify_status, row.punch_state), row.id);
  db.exec(`UPDATE attendance SET
             device_id = (SELECT b.device_id FROM biometric_events b WHERE b.attendance_id = attendance.id),
             branch_id = (SELECT b.branch_id FROM biometric_events b WHERE b.attendance_id = attendance.id)
           WHERE branch_id IS NULL AND EXISTS (SELECT 1 FROM biometric_events b WHERE b.attendance_id = attendance.id AND b.branch_id IS NOT NULL)`);
  if (defaultBranchId) db.prepare('UPDATE attendance SET branch_id = ? WHERE branch_id IS NULL').run(defaultBranchId);
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
  adoptMarks(branchId);
}

function driverFor(row) {
  const driver = drivers.get(row.driver);
  if (!driver) throw new Error('Este tipo de lector no está soportado.');
  return driver;
}

function statusOf(row) {
  if (!row.active) return 'DISABLED';
  if (row.agent_id) {
    // Lo que se sabe de un lector remoto es lo que reporta la computadora de su sucursal.
    const agent = agentOf(row);
    if (!agent?.last_seen_at || !row.last_contact_at) return 'PENDING';
    return !agent.active || agentSilent(agent) || row.consecutive_failures > 0 ? 'DISCONNECTED' : 'CONNECTED';
  }
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
  const agent = agentOf(row);
  const silent = Boolean(agent && row.active && agent.last_seen_at && (agentSilent(agent) || !agent.active));
  const forwarding = isAgentMode();
  return {
    id: row.id,
    name: row.name,
    remote: Boolean(row.agent_id),
    agentName: agent?.name || '',
    agentLastSeenAt: agent?.last_seen_at || null,
    address: row.agent_id ? clean(info.address, 60) : `${row.ip}:${row.port}`,
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
    lastError: silent
      ? `La computadora de esa sucursal (${agent.name}) dejó de reportarse: puede estar apagada o sin internet. Las marcaciones quedan guardadas allá y llegan solas cuando vuelva.`
      : row.last_error,
    lastErrorAt: row.last_error_at,
    consecutiveFailures: row.consecutive_failures,
    info,
    // En modo sucursal las marcaciones no se registran acá: se cuentan las que pasaron por la cola de envío.
    punchesToday: db.prepare(`SELECT COUNT(*) AS n FROM ${forwarding ? 'pending_events' : 'biometric_events'} WHERE device_id = ? AND punched_local LIKE ?`)
      .get(row.id, `${today}%`).n,
    queued: forwarding
      ? db.prepare("SELECT COUNT(*) AS n FROM pending_events WHERE device_id = ? AND status IN ('pending','syncing')").get(row.id).n
      : 0,
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

// De un lector remoto la central solo decide el nombre con que lo muestra y el tiempo de doble toque: la IP, el
// puerto y la clave se configuran en la computadora de su sucursal.
function updateRemoteDevice(current, input) {
  const name = clean(input.name ?? current.name, 80);
  if (name.length < 2) throw new Error('Indique un nombre para el lector.');
  const location = clean(input.location ?? current.location, 120);
  const minGapSeconds = intInRange(input.minGapSeconds, current.min_gap_seconds, 0, 3600, 'El tiempo anti-doble marcación');
  try {
    db.prepare('UPDATE biometric_devices SET name = ?, location = ?, min_gap_seconds = ?, updated_at = ? WHERE id = ?')
      .run(name, location, minGapSeconds, nowIso(), current.id);
  } catch (error) { throw friendlyUnique(error); }
  audit('ADMIN', 'UPDATE', 'BIOMETRIC_DEVICE', current.id, { name, remote: true });
  return publicDevice(getRow(current.id));
}

export function updateDevice(id, input) {
  const current = getRow(id);
  if (current.agent_id) return updateRemoteDevice(current, input);
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

// ---------- Modo sucursal: los empleados y sus IDs viven en la central ----------

function describeForCentral(row) {
  let info = {};
  try { info = JSON.parse(row.info_json || '{}'); } catch { info = {}; }
  return { serial: row.serial_number, name: row.name, address: `${row.ip}:${row.port}`, location: row.location,
    model: info.model || '', firmware: info.firmware || '', minGapSeconds: row.min_gap_seconds, importSince: row.import_since };
}

function readerForCentral(deviceId) {
  const row = getRow(deviceId);
  if (!row.serial_number) throw new Error('Todavía no se conoce el número de serie de este lector. Tocá "Probar conexión" y volvé a intentar.');
  return row;
}

async function centralDirectory(row) {
  const data = await centralRequest('/api/agent/employees', { method: 'POST', body: { device: describeForCentral(row) } });
  // Lo que llega de la central se vuelve a pasar a limpio antes de mostrarlo.
  const id = (value) => (/^[1-9]\d{0,8}$/.test(String(value ?? '')) ? String(value) : '');
  const rows = (Array.isArray(data.rows) ? data.rows : []).slice(0, 5000)
    .map((entry) => ({ employeeId: Number(entry?.employeeId) || 0, employeeCode: clean(entry?.employeeCode, 20), name: clean(entry?.name, 120),
      active: Boolean(entry?.active), zkUserId: id(entry?.zkUserId), sharedId: id(entry?.sharedId) }))
    .filter((entry) => Number.isInteger(entry.employeeId) && entry.employeeId > 0);
  return { deviceId: row.id, deviceName: row.name, suggestedId: id(data.suggestedId), rows };
}

function centralSetMapping(row, employeeId, zkUserId) {
  return centralRequest('/api/agent/mappings', { method: 'PUT',
    body: { device: describeForCentral(row), employeeId: Number(employeeId), zkUserId: String(zkUserId ?? '').trim() } });
}

async function centralEmployeeBiometrics(employeeId) {
  const list = [];
  for (const row of db.prepare('SELECT * FROM biometric_devices WHERE agent_id IS NULL ORDER BY active DESC, name').all()) {
    const item = { deviceId: row.id, deviceName: row.name, active: Boolean(row.active), remote: false, zkUserId: '', suggestedId: '' };
    if (row.serial_number) {
      const directory = await centralDirectory(row);
      const person = directory.rows.find((entry) => Number(entry.employeeId) === Number(employeeId));
      item.zkUserId = person?.zkUserId || '';
      item.suggestedId = person?.zkUserId || person?.sharedId || directory.suggestedId;
    }
    list.push(item);
  }
  return list;
}

export function listMappings(deviceId) {
  if (isAgentMode()) return centralDirectory(readerForCentral(deviceId));
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
  if (isAgentMode()) return centralSetMapping(readerForCentral(deviceId), employeeId, zkUserId);
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
  if (isAgentMode()) return centralEmployeeBiometrics(employeeId);
  return db.prepare(`SELECT d.id AS deviceId, d.name AS deviceName, d.active, m.zk_user_id AS zkUserId, d.agent_id AS agentId
      FROM biometric_devices d LEFT JOIN employee_biometric_map m ON m.device_id = d.id AND m.employee_id = ?
      ORDER BY d.active DESC, (d.agent_id IS NOT NULL), d.name`).all(Number(employeeId))
    .map(({ agentId, ...row }) => ({ ...row, active: Boolean(row.active), remote: Boolean(agentId),
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

// Marcación que llega tarde: una sucursal estuvo sin conexión y manda ahora una marca anterior a otras que ya se
// registraron. Se quitan las marcas posteriores de esa persona, se registra la que llegó tarde y se vuelven a
// pasar las posteriores por el motor en orden de hora. El resultado es el mismo que si todas hubieran llegado a
// tiempo. Si la tardía no se puede registrar, o algo falla, todo queda exactamente como estaba.
function registerLate(employee, device, occurred, later) {
  db.exec('SAVEPOINT marca_tardia');
  try {
    const findEvent = db.prepare('SELECT id FROM biometric_events WHERE attendance_id = ?');
    const removed = later.map((row) => ({ row, eventId: findEvent.get(row.id)?.id ?? null }));
    for (const item of removed) {
      if (item.eventId) db.prepare('UPDATE biometric_events SET attendance_id = NULL WHERE id = ?').run(item.eventId);
      db.prepare('DELETE FROM attendance WHERE id = ?').run(item.row.id);
    }
    const result = registerAttendance(employee, { at: occurred, source: 'BIO', minGapSeconds: device.min_gap_seconds,
      branchId: device.branch_id ?? null, deviceId: device.id });

    const gapOf = db.prepare('SELECT min_gap_seconds FROM biometric_devices WHERE id = ?');
    const moved = [];
    const dropped = [];
    for (const { row, eventId } of removed) {
      const label = `${row.work_date} ${row.local_time.slice(0, 5)} ${row.event_type === 'ENTRY' ? 'entrada' : 'salida'}`;
      try {
        const again = registerAttendance(employee, {
          at: new Date(row.occurred_at), source: row.source, nonce: row.qr_nonce,
          minGapSeconds: row.source === 'BIO' && row.device_id ? (gapOf.get(row.device_id)?.min_gap_seconds ?? 0) : 0,
          branchId: row.branch_id, deviceId: row.device_id
        });
        if (eventId) {
          db.prepare("UPDATE biometric_events SET attendance_id = ?, status = 'APPLIED', note = ?, processed_at = ? WHERE id = ?")
            .run(again.attendanceId, again.eventType === 'ENTRY' ? 'Entrada' : 'Salida', nowIso(), eventId);
        }
        if (again.eventType !== row.event_type || again.date !== row.work_date) {
          moved.push(`${label} pasó a ${again.eventType === 'ENTRY' ? 'entrada' : 'salida'} del ${again.date}`);
        }
      } catch (error) {
        dropped.push(`${label} (${row.source})`);
        if (eventId) {
          db.prepare('UPDATE biometric_events SET status = ?, note = ?, processed_at = ? WHERE id = ?')
            .run(error.code === 'REPEATED' ? 'IGNORED' : 'REJECTED',
              `${String(error.message).slice(0, 240)} (al reordenar la jornada)`, nowIso(), eventId);
        }
      }
    }
    audit('SYSTEM', 'REORDER', 'ATTENDANCE', employee.id, {
      llegoTarde: `${result.date} ${result.time}`, tipo: result.eventType, lector: device.name, reordenadas: removed.length, moved, dropped
    });
    db.exec('RELEASE marca_tardia');
    return { result, moved, dropped };
  } catch (error) {
    db.exec('ROLLBACK TO marca_tardia');
    db.exec('RELEASE marca_tardia');
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
  const later = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND occurred_at > ? ORDER BY occurred_at')
    .all(employee.id, occurred.toISOString());
  if (later.length && Date.now() - occurred.getTime() > LATE_REORDER_MAX_MS) {
    return { status: 'REJECTED', occurred, employeeId: employee.id,
      note: 'Llegó con más de 7 días de atraso y ya hay marcaciones posteriores. Corregila a mano si corresponde.' };
  }
  if (later.some((row) => row.source === 'ADMIN')) {
    return { status: 'REJECTED', occurred, employeeId: employee.id,
      note: 'Llegó tarde y esa jornada ya fue corregida a mano por el administrador.' };
  }
  try {
    if (later.length) {
      const late = registerLate(employee, device, occurred, later);
      const kind = late.result.eventType === 'ENTRY' ? 'Entrada' : 'Salida';
      return { status: 'APPLIED', note: `${kind} · llegó tarde, se reordenó la jornada`, occurred, employeeId: employee.id, result: late.result };
    }
    const result = registerAttendance(employee, { at: occurred, source: 'BIO', minGapSeconds: device.min_gap_seconds,
      branchId: device.branch_id ?? null, deviceId: device.id });
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
  if (isAgentMode()) return queueEvents(device, ordered, watermark, summary);
  const insert = db.prepare(`INSERT INTO biometric_events(device_id, zk_user_id, punched_local, verify_status, punch_state,
      status, note, received_at, event_uuid, branch_id, source) VALUES(?, ?, ?, ?, ?, 'INVALID', '', ?, ?, ?, 'biometric')
      ON CONFLICT DO NOTHING`);
  let newest = device.last_event_local || '';

  for (const event of ordered) {
    const userId = String(event.userId ?? '').replace(/[^\x21-\x7E]/g, '').slice(0, 24) || '?';
    const local = event.valid && event.localStamp ? event.localStamp : rawStamp(event.time);
    if (event.valid && watermark && local < watermark) { summary.duplicates += 1; continue; }
    const decision = transaction(() => {
      const verify = Number(event.verifyStatus) || 0;
      const punch = Number(event.punchState) || 0;
      const uuid = device.serial_number ? eventUuid(device.serial_number, userId, local, verify, punch) : null;
      const inserted = insert.run(device.id, userId, local, verify, punch, nowIso(), uuid, device.branch_id ?? null);
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

// Modo sucursal: la marcación no se registra acá. Se guarda en la cola y sale hacia la central, que es la que
// decide si es entrada o salida. Las anteriores a la activación del lector no se envían.
function queueEvents(device, ordered, watermark, summary) {
  if (!device.serial_number) throw new Error('El lector no informó su número de serie; sin eso sus marcaciones no se pueden enviar a la central.');
  const since = Date.parse(device.import_since);
  let newest = device.last_event_local || '';
  summary.queued = 0;
  for (const event of ordered) {
    const userId = String(event.userId ?? '').replace(/[^\x21-\x7E]/g, '').slice(0, 24);
    const local = event.valid && event.localStamp ? event.localStamp : '';
    const occurred = local && userId ? zonedToDate(local) : null;
    if (!occurred) { summary.invalid += 1; continue; }
    if ((watermark && local < watermark) || occurred.getTime() < since) { summary.duplicates += 1; continue; }
    const verify = Number(event.verifyStatus) || 0;
    const punch = Number(event.punchState) || 0;
    const added = enqueueEvent(device, { uuid: eventUuid(device.serial_number, userId, local, verify, punch), userId, local, verify, punch });
    if (added) { summary.imported += 1; summary.queued += 1; } else summary.duplicates += 1;
    // Una marca con fecha futura (reloj del lector adelantado) se envía para que se vea el problema, pero no
    // mueve la marca de "hasta dónde ya se leyó": si la moviera, las marcas reales de después no saldrían.
    if (local > newest && occurred.getTime() <= Date.now() + FUTURE_TOLERANCE_MS) newest = local;
  }
  if (newest && newest !== device.last_event_local) {
    db.prepare('UPDATE biometric_devices SET last_event_local = ? WHERE id = ?').run(newest, device.id);
  }
  if (summary.queued) kickLink();
  return summary;
}

function describe(summary) {
  const parts = [`${summary.received} eventos recibidos`, `${summary.imported} nuevos`, `${summary.duplicates} existentes`];
  if (summary.queued) parts.push(`${summary.queued} en cola para la central`);
  if (summary.unmapped) parts.push(`${summary.unmapped} sin empleado vinculado`);
  if (summary.rejected) parts.push(`${summary.rejected} no aplicados`);
  if (summary.invalid) parts.push(`${summary.invalid} inválidos`);
  return parts.join(' · ');
}

// ---------- Operaciones contra el lector ----------

export function syncDevice(id, { full = false, manual = false, action = 'Sincronización' } = {}) {
  return exclusive(id, async () => {
    const row = getRow(id);
    assertLocal(row);
    if (!row.active && !manual) return { skipped: true };
    const st = state(row.id);
    // Misma regla que el QR: con la licencia bloqueada no se registran marcaciones. Las huellas quedan
    // guardadas en el lector y entran solas cuando la licencia vuelve a estar activa. En modo sucursal la
    // licencia que cuenta es la de la central, que es la que registra.
    const gate = isAgentMode() ? { blockQrGeneration: false } : licenseGate();
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
    assertLocal(row);
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
    assertLocal(row);
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

// Crea el usuario en el lector y lo deja pidiendo el dedo. La huella queda solo en el lector.
function enrollOnReader(device, { userId, name, replace, employeeId }) {
  return exclusive(device.id, async () => {
    const started = Date.now();
    const st = state(device.id);
    st.syncing = true;
    try {
      const result = await driverFor(device).enrollUser(connection(device), {
        userId, name: asciiName(name), replace: replace === true || replace === 'true' });
      markContact(device);
      addLog(device, { action: 'Registro de huella', result: result.enrolled ? 'OK' : 'ERROR',
        message: result.enrolled ? `Huella registrada para ${name} (ID ${userId})`
          : `No se completó el registro de ${name} (ID ${userId})`, durationMs: Date.now() - started });
      audit('ADMIN', 'BIOMETRIC_ENROLL', 'EMPLOYEE', employeeId, { deviceId: device.id, zkUserId: userId, enrolled: result.enrolled });
      return { zkUserId: userId, enrolled: result.enrolled, outcome: result.outcome, userCreated: result.created };
    } catch (error) {
      const message = String(error.message).slice(0, 300);
      addLog(device, { action: 'Registro de huella', result: 'ERROR', message, durationMs: Date.now() - started });
      return { zkUserId: userId, enrolled: false, outcome: 'ERROR', error: message };
    } finally {
      st.syncing = false;
    }
  });
}

// Asigna el ID y registra la huella. En modo sucursal el empleado y su ID se consultan y se guardan en la central.
export async function enrollEmployee({ employeeId, deviceId, zkUserId, replace = false }) {
  const device = getRow(deviceId);
  assertLocal(device);
  if (!device.active) throw new Error('Este lector está desactivado.');
  if (isAgentMode()) {
    const directory = await centralDirectory(readerForCentral(device.id));
    const person = directory.rows.find((entry) => Number(entry.employeeId) === Number(employeeId));
    if (!person) throw new Error('Empleado no encontrado en la central.');
    const chosen = String(zkUserId ?? '').trim() || person.zkUserId || person.sharedId || directory.suggestedId;
    if (chosen !== person.zkUserId) await centralSetMapping(device, person.employeeId, chosen);
    return enrollOnReader(device, { userId: chosen, name: person.name, replace, employeeId: person.employeeId });
  }
  const employee = db.prepare('SELECT id, name FROM employees WHERE id = ? AND COALESCE(archived, 0) = 0').get(Number(employeeId));
  if (!employee) throw new Error('Empleado no encontrado.');
  const current = db.prepare('SELECT zk_user_id FROM employee_biometric_map WHERE employee_id = ? AND device_id = ?')
    .get(employee.id, device.id)?.zk_user_id;
  const wanted = String(zkUserId ?? '').trim() || current || idOnOtherReaders(employee.id, device.id)?.id || nextFreeId();
  if (wanted !== current) setMapping({ employeeId: employee.id, deviceId: device.id, zkUserId: wanted });
  return enrollOnReader(device, { userId: wanted, name: employee.name, replace, employeeId: employee.id });
}

export function listLogs({ deviceId = null, limit = 100 } = {}) {
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  return deviceId
    ? db.prepare('SELECT * FROM biometric_sync_logs WHERE device_id = ? ORDER BY id DESC LIMIT ?').all(Number(deviceId), max)
    : db.prepare('SELECT * FROM biometric_sync_logs ORDER BY id DESC LIMIT ?').all(max);
}

export function listEvents({ deviceId = null, limit = 100 } = {}) {
  if (isAgentMode()) return listQueue({ deviceId, limit });
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  const sql = `SELECT b.id, b.event_uuid AS eventUuid, b.device_id AS deviceId, d.name AS deviceName, br.code AS branchCode, br.name AS branchName,
      b.zk_user_id AS zkUserId, b.punched_local AS punchedLocal, b.status, b.note, e.name AS employee
    FROM biometric_events b JOIN biometric_devices d ON d.id = b.device_id
    LEFT JOIN branches br ON br.id = COALESCE(b.branch_id, d.branch_id)
    LEFT JOIN employees e ON e.id = b.employee_id`;
  return deviceId
    ? db.prepare(`${sql} WHERE b.device_id = ? ORDER BY b.id DESC LIMIT ?`).all(Number(deviceId), max)
    : db.prepare(`${sql} ORDER BY b.id DESC LIMIT ?`).all(max);
}

// ---------- Central: lectores de otras sucursales ----------

// Un lector de otra sucursal se reconoce por su número de serie y queda atado a la computadora (agente) que lo
// reportó primero: otra sucursal no puede enviar marcaciones en su nombre.
export function resolveRemoteDevice(agent, info = {}) {
  const serial = clean(info?.serial, 40);
  if (!/^[\x21-\x7E]{3,40}$/.test(serial)) throw apiError(400, 'bad_device', 'Falta el número de serie del lector.');
  const details = JSON.stringify({ serial, address: clean(info.address, 60), model: clean(info.model, 60), firmware: clean(info.firmware, 60) });
  const existing = db.prepare('SELECT * FROM biometric_devices WHERE serial_number = ?').get(serial);
  if (existing?.agent_id === agent.id) {
    if (existing.info_json !== details) db.prepare('UPDATE biometric_devices SET info_json = ? WHERE id = ?').run(details, existing.id);
    return existing;
  }
  if (existing && !releaseSerial(existing, agent.name)) {
    throw apiError(403, 'device_not_authorized', 'Ese lector ya está registrado en la central desde otro lugar. Si se mudó de sucursal, primero hay que desactivarlo en la central.');
  }
  if (db.prepare("SELECT COUNT(*) AS n FROM biometric_devices WHERE agent_id = ? AND serial_number <> ''").get(agent.id).n >= MAX_READERS_PER_AGENT) {
    throw apiError(403, 'too_many_devices', `Esta sucursal ya tiene ${MAX_READERS_PER_AGENT} lectores registrados en la central.`);
  }
  const branch = db.prepare('SELECT id, code FROM branches WHERE id = ?').get(agent.branch_id);
  if (!branch) throw apiError(403, 'branch_inactive', 'La sucursal de esta computadora ya no existe en la central.');
  const wanted = clean(info.name, 70).length >= 2 ? clean(info.name, 70) : `ZK-${branch.code}-01`;
  const taken = db.prepare('SELECT 1 FROM biometric_devices WHERE name = ?');
  let name = wanted;
  for (let n = 1; taken.get(name); n += 1) name = `${wanted} · ${branch.code}${n > 1 ? ` ${n}` : ''}`;
  let minGap = Number(info.minGapSeconds);
  if (!Number.isInteger(minGap) || minGap < 0 || minGap > 3600) minGap = 120;
  // Desde cuándo se aceptan sus marcaciones: desde que la sucursal activó el lector, pero nunca antes del día en
  // que se creó la clave de esa sucursal. Así, lo que quedó en cola mientras la central estuvo apagada entra.
  const floor = zonedToDate(`${localDate(new Date(agent.created_at))} 00:00:00`).getTime();
  const reported = Date.parse(info.importSince);
  const since = new Date(Math.max(floor, Number.isFinite(reported) ? Math.min(reported, Date.now()) : floor)).toISOString();
  const now = nowIso();
  const created = db.prepare(`INSERT INTO biometric_devices(name, ip, port, location, min_gap_seconds, import_since, branch_id,
      serial_number, agent_id, info_json, created_at, updated_at) VALUES(?, ?, 4370, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, `serie:${serial}`, clean(info.location, 120), minGap, since, branch.id, serial, agent.id, details, now, now);
  audit('SYSTEM', 'CREATE', 'BIOMETRIC_DEVICE', created.lastInsertRowid, { name, serial, agent: agent.name, remote: true });
  return getRow(created.lastInsertRowid);
}

// Latido de una sucursal: cómo está cada uno de sus lectores, según su propia computadora.
export function reportRemoteDevices(agent, devices) {
  if (!Array.isArray(devices)) return [];
  const report = [];
  const seen = [];
  for (const info of devices.slice(0, MAX_READERS_PER_AGENT * 2)) {
    try {
      const row = resolveRemoteDevice(agent, info);
      seen.push(row.id);
      const failures = Math.max(0, Math.min(Number(info.consecutiveFailures) || 0, 100000));
      const error = failures ? clean(info.lastError, 300) : '';
      // "Último contacto" se anota con el reloj de la central: el de la otra computadora puede estar corrido.
      const healthy = !failures && Number.isFinite(Date.parse(info.lastContactAt));
      db.prepare(`UPDATE biometric_devices SET last_contact_at = CASE WHEN ? = 1 THEN ? ELSE last_contact_at END, consecutive_failures = ?,
          last_error = ?, last_error_at = CASE WHEN ? <> '' THEN ? ELSE last_error_at END WHERE id = ?`)
        .run(healthy ? 1 : 0, nowIso(), failures, error, error, nowIso(), row.id);
      report.push({ serial: row.serial_number, name: row.name, active: Boolean(row.active) });
    } catch (error) {
      report.push({ serial: clean(info?.serial, 40), error: error.message });
    }
  }
  // Un lector que la sucursal dejó de nombrar (lo desactivó o lo quitó) no puede seguir figurando conectado.
  const others = db.prepare("SELECT id FROM biometric_devices WHERE agent_id = ? AND serial_number <> '' AND consecutive_failures = 0").all(agent.id)
    .filter((row) => !seen.includes(row.id));
  for (const row of others) {
    db.prepare('UPDATE biometric_devices SET consecutive_failures = 1, last_error = ?, last_error_at = ? WHERE id = ?')
      .run('La sucursal dejó de reportar este lector: puede estar desactivado allá.', nowIso(), row.id);
  }
  return report;
}

// Marcaciones que manda la computadora de otra sucursal. Mismo camino que las de un lector local: se guardan una
// sola vez (por identificador) y pasan por el mismo motor. Devuelve, por cada una, si se registró ahora o si ya
// estaba; la sucursal no la da por enviada hasta recibir esa respuesta.
export function ingestRemoteEvents(deviceId, events) {
  const device = getRow(deviceId);
  const insert = db.prepare(`INSERT INTO biometric_events(device_id, zk_user_id, punched_local, verify_status, punch_state,
      status, note, received_at, event_uuid, branch_id, source) VALUES(?, ?, ?, ?, ?, 'INVALID', '', ?, ?, ?, 'biometric')
      ON CONFLICT DO NOTHING`);
  const stored = db.prepare(`SELECT b.status, b.note, e.name FROM biometric_events b LEFT JOIN employees e ON e.id = b.employee_id
      WHERE b.event_uuid = ? OR (b.device_id = ? AND b.zk_user_id = ? AND b.punched_local = ? AND b.verify_status = ? AND b.punch_state = ?)
      LIMIT 1`);
  const nameOf = db.prepare('SELECT name FROM employees WHERE id = ?');
  const results = [];
  let newest = device.last_event_local || '';
  for (const event of [...events].sort((a, b) => a.local.localeCompare(b.local))) {
    const decision = transaction(() => {
      const inserted = insert.run(device.id, event.userId, event.local, event.verify, event.punch, nowIso(), event.uuid, device.branch_id ?? null);
      if (!inserted.changes) return null;
      const outcome = decide({ zk_user_id: event.userId, punched_local: event.local }, device);
      applyDecision(Number(inserted.lastInsertRowid), outcome);
      return outcome;
    });
    if (!decision) {
      const before = stored.get(event.uuid, device.id, event.userId, event.local, event.verify, event.punch);
      results.push({ event_uuid: event.uuid, status: 'already_registered', outcome: String(before?.status || 'APPLIED').toLowerCase(),
        detail: before?.note || '', employee: before?.name || '' });
      continue;
    }
    results.push({ event_uuid: event.uuid, status: 'registered', outcome: decision.status.toLowerCase(), detail: decision.note,
      employee: decision.employeeId ? (nameOf.get(decision.employeeId)?.name || '') : '' });
    if (decision.status !== 'INVALID' && event.local > newest) newest = event.local;
    notify(decision);
  }
  db.prepare('UPDATE biometric_devices SET last_sync_at = ?, last_event_local = ? WHERE id = ?').run(nowIso(), newest || null, device.id);
  return results;
}

// Lo que esta computadora, en modo sucursal, le cuenta a la central sobre sus lectores.
setDeviceReporter(() => db.prepare("SELECT * FROM biometric_devices WHERE agent_id IS NULL AND active = 1 AND serial_number <> ''").all()
  .map((row) => ({ ...describeForCentral(row), lastContactAt: row.last_contact_at, lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures })));

// ---------- Agente en segundo plano ----------

function tick() {
  if (stopping) return;
  let rows = [];
  try { rows = db.prepare('SELECT id FROM biometric_devices WHERE active = 1 AND agent_id IS NULL').all(); }
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
