// Central: las computadoras de las otras sucursales ("agentes") que pueden enviarle marcaciones.
// Cada una tiene su propia clave. La clave se muestra una sola vez, al crearla; acá solo se guarda su hash, así
// que ni leyendo la base de datos se puede recuperar. Ver docs/multisucursal.md.
import { createHash, randomBytes } from 'node:crypto';
import { db, audit } from '../db.js';
import { nowIso, zonedToDate } from '../time.js';
import { config } from '../config.js';
import { getCompanyProfile } from './company.js';
import { licenseGate } from './license.js';
import { isAgentMode } from './branchLink.js';
import {
  eventUuid, ingestRemoteEvents, listMappings, reportRemoteDevices, resolveRemoteDevice, setMapping
} from './biometric/index.js';

const ONLINE_MS = 3 * 60 * 1000;
const MAX_EVENTS_PER_REQUEST = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const USER_ID = /^[\x21-\x7E]{1,24}$/;
const KEY = /^Bearer\s+(qbq_[A-Za-z0-9_-]{40,120})$/;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const hashKey = (key) => createHash('sha256').update(`qubiq-control/sucursal/v1|${key}`).digest('hex');
const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });

function getRow(id) {
  const row = db.prepare('SELECT * FROM branch_agents WHERE id = ?').get(Number(id));
  if (!row) throw new Error('Sucursal conectada no encontrada.');
  return row;
}

function publicAgent(row) {
  const branch = db.prepare('SELECT name, code, active FROM branches WHERE id = ?').get(row.branch_id);
  const readers = db.prepare('SELECT name FROM biometric_devices WHERE agent_id = ? ORDER BY name').all(row.id).map((item) => item.name);
  return {
    id: row.id,
    name: row.name,
    branchId: row.branch_id,
    branchName: branch?.name || '',
    branchCode: branch?.code || '',
    active: Boolean(row.active),
    keyHint: row.key_hint,
    online: Boolean(row.active && row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < ONLINE_MS),
    lastSeenAt: row.last_seen_at,
    lastIp: row.last_ip,
    appVersion: row.app_version,
    queuePending: row.queue_pending,
    eventsReceived: row.events_received,
    lastEventAt: row.last_event_at,
    readers,
    removable: row.events_received === 0 && readers.length === 0,
    createdAt: row.created_at
  };
}

function activeBranch(branchId) {
  const branch = db.prepare('SELECT id, name, code, active FROM branches WHERE id = ?').get(Number(branchId));
  if (!branch) throw new Error('La sucursal elegida no existe.');
  if (!branch.active) throw new Error('La sucursal elegida está inactiva.');
  return branch;
}

function friendly(error) {
  return String(error.message).includes('UNIQUE') ? new Error('Ya existe una sucursal conectada con ese nombre.') : error;
}

function issueKey() {
  const key = `qbq_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashKey(key), hint: key.slice(-4) };
}

export const hasActiveAgents = () => db.prepare('SELECT COUNT(*) AS n FROM branch_agents WHERE active = 1').get().n > 0;

export function listAgents() {
  return db.prepare('SELECT * FROM branch_agents ORDER BY active DESC, name COLLATE NOCASE').all().map(publicAgent);
}

export function createAgent(input = {}) {
  if (isAgentMode()) throw new Error('Esta computadora está conectada a una central como sucursal. Una computadora es central o es sucursal, no las dos.');
  const branch = activeBranch(input.branchId);
  const name = clean(input.name, 80) || `Computadora de ${branch.name}`;
  if (name.length < 2) throw new Error('Indique un nombre para la computadora de la sucursal.');
  const secret = issueKey();
  const now = nowIso();
  try {
    const created = db.prepare(`INSERT INTO branch_agents(name, branch_id, key_hash, key_hint, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?)`).run(name, branch.id, secret.hash, secret.hint, now, now);
    audit('ADMIN', 'CREATE', 'BRANCH_AGENT', created.lastInsertRowid, { name, branchId: branch.id });
    return { agent: publicAgent(getRow(created.lastInsertRowid)), key: secret.key };
  } catch (error) { throw friendly(error); }
}

export function updateAgent(id, input = {}) {
  const current = getRow(id);
  const name = clean(input.name ?? current.name, 80);
  if (name.length < 2) throw new Error('Indique un nombre para la computadora de la sucursal.');
  const branchId = input.branchId === undefined || input.branchId === '' || input.branchId === null
    ? current.branch_id
    : (Number(input.branchId) === current.branch_id ? current.branch_id : activeBranch(input.branchId).id);
  try {
    db.prepare('UPDATE branch_agents SET name = ?, branch_id = ?, updated_at = ? WHERE id = ?').run(name, branchId, nowIso(), current.id);
  } catch (error) { throw friendly(error); }
  // Sus lectores se mudan con ella. Las marcaciones ya registradas conservan la sucursal donde se hicieron.
  if (branchId !== current.branch_id) db.prepare('UPDATE biometric_devices SET branch_id = ? WHERE agent_id = ?').run(branchId, current.id);
  audit('ADMIN', 'UPDATE', 'BRANCH_AGENT', current.id, { name, branchId });
  return publicAgent(getRow(current.id));
}

export function setAgentActive(id, active) {
  const current = getRow(id);
  if (active) {
    if (isAgentMode()) throw new Error('Esta computadora está conectada a una central como sucursal.');
    activeBranch(current.branch_id);
  }
  db.prepare('UPDATE branch_agents SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowIso(), current.id);
  audit('ADMIN', active ? 'ACTIVATE' : 'DEACTIVATE', 'BRANCH_AGENT', current.id);
  return publicAgent(getRow(current.id));
}

// Una clave creada por error (o en la computadora equivocada) se puede borrar mientras no haya traído ningún
// lector ni marcación. Después ya es parte del historial y solo se desactiva.
export function deleteAgent(id) {
  const current = getRow(id);
  if (current.events_received > 0 || db.prepare('SELECT COUNT(*) AS n FROM biometric_devices WHERE agent_id = ?').get(current.id).n > 0) {
    throw new Error('Esa sucursal ya envió marcaciones o tiene lectores registrados: se puede desactivar, pero no eliminar.');
  }
  db.prepare('DELETE FROM branch_agents WHERE id = ?').run(current.id);
  audit('ADMIN', 'DELETE', 'BRANCH_AGENT', current.id, { name: current.name });
  return { ok: true };
}

// Clave nueva: la anterior deja de servir en el acto (por ejemplo, si se perdió o se cambió la computadora).
export function rotateAgentKey(id) {
  const current = getRow(id);
  const secret = issueKey();
  db.prepare('UPDATE branch_agents SET key_hash = ?, key_hint = ?, updated_at = ? WHERE id = ?').run(secret.hash, secret.hint, nowIso(), current.id);
  audit('ADMIN', 'ROTATE_KEY', 'BRANCH_AGENT', current.id);
  return { agent: publicAgent(getRow(current.id)), key: secret.key };
}

// ---------- Lo que usa el puerto de recepción ----------

export function authenticateAgent(authorization) {
  const match = KEY.exec(String(authorization || ''));
  if (!match) return null;
  return db.prepare('SELECT * FROM branch_agents WHERE key_hash = ?').get(hashKey(match[1])) || null;
}

// Una sucursal desactivada o de una sucursal inactiva no puede enviar ni consultar nada.
export function assertAgentAllowed(agent) {
  if (!agent.active) throw apiError(403, 'agent_disabled', 'Esta sucursal fue desactivada en la central.');
  const branch = db.prepare('SELECT id, name, code, active FROM branches WHERE id = ?').get(agent.branch_id);
  if (!branch || !branch.active) throw apiError(403, 'branch_inactive', 'La sucursal de esta computadora está inactiva en la central.');
  return branch;
}

export function touchAgent(agent, { ip = '', version = '', queuePending = null } = {}) {
  db.prepare(`UPDATE branch_agents SET last_seen_at = ?, last_ip = ?, app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END,
      queue_pending = COALESCE(?, queue_pending) WHERE id = ?`)
    .run(nowIso(), clean(ip, 45), clean(version, 20), clean(version, 20),
      queuePending == null ? null : Math.max(0, Math.min(Number(queuePending) || 0, 100000000)), agent.id);
}

export function agentHello(agent) {
  const branch = assertAgentAllowed(agent);
  return { qubiq: 'central', version: config.version, central: getCompanyProfile().businessName, agent: agent.name,
    branch: { name: branch.name, code: branch.code }, serverTime: nowIso() };
}

export function agentHeartbeat(agent, body = {}) {
  const hello = agentHello(agent);
  return { ...hello, devices: reportRemoteDevices(agent, body.devices) };
}

// Una fecha de calendario y una hora que existan de verdad (no "13-45 99:00").
function realStamp(local) {
  if (!STAMP.test(local)) return false;
  const [y, mo, d, h, mi, sec] = local.split(/[- :]/).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d
    && h < 24 && mi < 60 && sec < 60 && y >= 2000 && Boolean(zonedToDate(local));
}

function parseEvent(raw, serial) {
  const uuid = String(raw?.event_uuid ?? '').toLowerCase();
  const reject = (detail) => ({ rejected: { event_uuid: uuid.slice(0, 64), status: 'rejected', detail } });
  if (!UUID.test(uuid)) return reject('Identificador de marcación inválido.');
  const userId = String(raw.user_id ?? '');
  if (!USER_ID.test(userId)) return reject('ID de usuario del lector inválido.');
  const local = String(raw.punched_at ?? '');
  if (!realStamp(local)) return reject('Fecha u hora de la marcación inválida.');
  const verify = Number(raw.verify ?? 0);
  const punch = Number(raw.punch ?? 0);
  if (![verify, punch].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return reject('Datos de la marcación inválidos.');
  // El identificador se vuelve a calcular acá: tiene que salir de ese lector, esa persona y esa hora.
  if (eventUuid(serial, userId, local, verify, punch) !== uuid) return reject('El identificador no corresponde a la marcación enviada.');
  return { event: { uuid, userId, local, verify, punch } };
}

export function receiveEvents(agent, body = {}) {
  assertAgentAllowed(agent);
  // Misma regla que el QR y el lector local: con la licencia bloqueada no se registran marcaciones. La sucursal
  // las conserva en su cola y entran solas cuando la licencia vuelve a estar activa.
  const gate = licenseGate();
  if (gate.blockQrGeneration) throw apiError(402, 'license', gate.banner?.text || 'La licencia de la central no está activa.');
  if (!Array.isArray(body.events) || !body.events.length) throw apiError(400, 'bad_request', 'No se recibieron marcaciones.');
  if (body.events.length > MAX_EVENTS_PER_REQUEST) throw apiError(413, 'too_many', `Se aceptan hasta ${MAX_EVENTS_PER_REQUEST} marcaciones por envío.`);
  const device = resolveRemoteDevice(agent, body.device);
  if (!device.active) throw apiError(403, 'device_disabled', `El lector ${device.name} está desactivado en la central.`);

  const results = [];
  const valid = [];
  const seen = new Set();
  for (const raw of body.events) {
    const parsed = parseEvent(raw, device.serial_number);
    if (parsed.rejected) results.push(parsed.rejected);
    else if (!seen.has(parsed.event.uuid)) { seen.add(parsed.event.uuid); valid.push(parsed.event); }
  }
  results.push(...ingestRemoteEvents(device.id, valid));
  const fresh = results.filter((item) => item.status === 'registered').length;
  db.prepare(`UPDATE branch_agents SET events_received = events_received + ?, last_event_at = CASE WHEN ? > 0 THEN ? ELSE last_event_at END
      WHERE id = ?`).run(fresh, fresh, nowIso(), agent.id);
  return { serverTime: nowIso(), device: device.name, results };
}

// Lista de empleados para que la sucursal registre huellas en su lector con el ID correcto. Solo nombre, código
// e ID biométrico: nunca PIN, cédula ni datos de planilla.
export function agentDirectory(agent, body = {}) {
  assertAgentAllowed(agent);
  const device = resolveRemoteDevice(agent, body.device);
  const data = listMappings(device.id);
  return { suggestedId: data.suggestedId, rows: data.rows.filter((row) => row.active)
    .map((row) => ({ employeeId: row.employeeId, employeeCode: row.employeeCode, name: row.name, active: Boolean(row.active),
      zkUserId: row.zkUserId || '', sharedId: row.sharedId || '' })) };
}

export function agentSetMapping(agent, body = {}) {
  assertAgentAllowed(agent);
  const device = resolveRemoteDevice(agent, body.device);
  return setMapping({ employeeId: body.employeeId, deviceId: device.id, zkUserId: body.zkUserId });
}
