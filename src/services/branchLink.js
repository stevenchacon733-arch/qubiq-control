// Modo sucursal: esta computadora no registra la asistencia por su cuenta. Lee su lector y le manda cada
// marcación a la central. Lo que no se pudo enviar (sin internet, central apagada) queda en una cola en disco
// y se reintenta solo; nada se da por enviado hasta que la central lo confirma. Ver docs/multisucursal.md.
import { db, getSetting, setSetting, audit } from '../db.js';
import { config } from '../config.js';
import { nowIso } from '../time.js';
import { getCentralLink, saveCentralLink } from './integrationConfig.js';

const BATCH_SIZE = 200;
const TICK_MS = 5000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const MIN_BACKOFF_MS = 5 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const KEY_FORMAT = /^qbq_[A-Za-z0-9_-]{40,120}$/;

let link;              // undefined = todavía no se leyó del disco; null = sin conexión configurada
let timer = null;
let running = null;    // envío en curso (uno a la vez)
let failures = 0;
let nextSendAt = 0;
let nextBeatAt = 0;
let problemSource = '';   // '' = todo bien; 'beat' = no se llega a la central; 'send' = la central no acepta la cola
const blockedDevices = new Map(); // número de serie del lector que la central rechaza → cuándo se vuelve a probar
const DEVICE_REFUSALS = new Set(['device_disabled', 'device_not_authorized', 'too_many_devices', 'bad_device']);
let deviceReporter = () => [];
let stopping = false;

export class CentralError extends Error {
  constructor(message, { status = 0, code = 'network' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function currentLink() {
  if (link === undefined) link = getCentralLink();
  return link;
}

export const isAgentMode = () => Boolean(currentLink());

// Los lectores se le informan a la central en cada latido. El módulo de lectores registra aquí cómo listarlos.
export function setDeviceReporter(reporter) { deviceReporter = reporter; }

function isPrivateHost(host) {
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  // Red local, y 100.64.0.0/10: el rango que usan las redes privadas tipo Tailscale (ya van cifradas).
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

export function normalizeCentralUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Escribí la dirección de la central.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${isPrivateHost(text.split(/[/:]/)[0]) ? 'http' : 'https'}://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('La dirección de la central no es válida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('La dirección de la central no es válida.');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error('La dirección de la central tiene que empezar con https://. Solo se acepta http:// dentro de la red local.');
  }
  return `${url.protocol}//${url.host}`;
}

function friendlyStatus(status) {
  if (status === 401) return 'La central no reconoce la clave de esta sucursal. Generá una nueva en la central y volvé a conectar.';
  if (status === 402) return 'La licencia de la central no está activa.';
  if (status === 403) return 'La central no autoriza a esta sucursal.';
  if (status === 404) return 'En esa dirección no responde una central de Qubiq Control. Revisá la dirección.';
  if (status === 429) return 'La central pidió esperar antes de reintentar.';
  if (status >= 500) return `La central no está disponible en este momento (respuesta ${status}).`;
  return `La central respondió ${status}.`;
}

// Toda llamada a la central pasa por acá: lleva la clave de la sucursal y nunca sigue redirecciones.
export async function centralRequest(path, { method = 'GET', body = null, using = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const target = using || currentLink();
  if (!target) throw new CentralError('Esta computadora no está conectada a una central.', { code: 'not_linked' });
  let response;
  try {
    response = await fetch(`${target.url}${path}`, {
      method,
      redirect: 'manual',
      headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json', 'X-Qubiq-Version': config.version },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const slow = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new CentralError(slow ? 'La central no respondió a tiempo.' : 'No se pudo conectar con la central: sin internet, o la central está apagada.');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CentralError('La dirección de la central redirige a otro lado. Usá la dirección exacta.', { status: response.status, code: 'redirect' });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CentralError(String(data?.error || friendlyStatus(response.status)).slice(0, 300), { status: response.status, code: data?.code || 'http' });
  }
  if (!data || typeof data !== 'object') throw new CentralError('La central dio una respuesta que no se entiende.', { status: response.status, code: 'bad_response' });
  return data;
}

// ---------- Cola ----------

export function enqueueEvent(device, { uuid, userId, local, verify = 0, punch = 0 }) {
  const inserted = db.prepare(`INSERT INTO pending_events(event_uuid, device_id, device_serial, zk_user_id, punched_local,
      verify_status, punch_state, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_uuid) DO NOTHING`)
    .run(uuid, device.id, device.serial_number, userId, local, verify, punch, nowIso());
  return inserted.changes > 0;
}

export function queueStats() {
  const stats = { pending: 0, syncing: 0, synced: 0, error: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM pending_events GROUP BY status').all()) stats[row.status] = row.n;
  const oldest = db.prepare("SELECT MIN(punched_local) AS at FROM pending_events WHERE status IN ('pending','syncing')").get().at;
  const lastSynced = db.prepare("SELECT MAX(synced_at) AS at FROM pending_events WHERE status = 'synced'").get().at;
  return { ...stats, waiting: stats.pending + stats.syncing, oldestWaiting: oldest || null, lastSyncedAt: lastSynced || null };
}

export function retryErrors() {
  const changed = db.prepare("UPDATE pending_events SET status = 'pending', attempts = 0, last_error = '' WHERE status = 'error'").run().changes;
  if (changed) kickLink();
  return { retried: changed };
}

function log({ result = 'OK', received = 0, imported = 0, duplicates = 0, message = '', durationMs = 0, action = 'Envío a la central' }) {
  const inserted = db.prepare(`INSERT INTO biometric_sync_logs(device_id, device_name, action, result, received, imported,
      duplicates, message, duration_ms, created_at) VALUES(NULL, 'Central', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(action, result, received, imported, duplicates, String(message).slice(0, 500), durationMs, nowIso());
  db.prepare('DELETE FROM biometric_sync_logs WHERE id <= ?').run(Number(inserted.lastInsertRowid) - 5000);
}

// Dos relojes separados. El latido sale siempre, cada minuto: es lo que le dice a la central que esta sucursal
// sigue viva. Los envíos de la cola, cuando fallan, esperan cada vez más (de 5 s a 5 min) para no insistir a
// ciegas; un latido que sale bien los habilita de nuevo en el acto.
function noteProblem(error, source) {
  const message = String(error.message || error).slice(0, 300);
  if (!problemSource) log({ action: 'Conexión con la central', result: 'ERROR', message: `${message} Se sigue reintentando solo.` });
  problemSource = source;
  setSetting('central_link_last_error', message);
  setSetting('central_link_last_error_at', nowIso());
  return message;
}

function noteWorking(source) {
  setSetting('central_link_last_ok', nowIso());
  // Que el latido llegue no significa que la cola esté saliendo (por ejemplo, con la licencia de la central
  // vencida): un problema de envío solo se da por resuelto cuando un envío sale bien.
  if (!problemSource || (problemSource === 'send' && source === 'beat')) return;
  problemSource = '';
  setSetting('central_link_last_error', '');
  log({ action: 'Conexión con la central', message: 'Conexión recuperada.' });
}

function sendSucceeded() {
  failures = 0;
  nextSendAt = 0;
  if (!blockedDevices.size) noteWorking('send');
}

function sendFailed(error) {
  failures += 1;
  nextSendAt = Date.now() + Math.min(MIN_BACKOFF_MS * 2 ** Math.min(failures - 1, 6), MAX_BACKOFF_MS);
  return noteProblem(error, 'send');
}

function describeResult(result) {
  return JSON.stringify({
    outcome: String(result.outcome || 'applied').slice(0, 20),
    detail: String(result.detail || '').slice(0, 240),
    employee: String(result.employee || '').slice(0, 120)
  });
}

async function sendBatches(manual) {
  const started = Date.now();
  const totals = { sent: 0, registered: 0, already: 0, rejected: 0 };
  const refusedNow = new Map();
  for (;;) {
    if (!currentLink() || stopping) break;
    // Si la central rechaza a un lector en particular (desactivado allá, registrado en otra sucursal), ese lector
    // espera unos minutos y los demás siguen saliendo: uno trabado no frena a toda la sucursal.
    const skip = [...refusedNow.keys(), ...(manual ? [] : [...blockedDevices].filter(([, until]) => until > Date.now()).map(([serial]) => serial))];
    const except = skip.length ? `AND device_serial NOT IN (${skip.map(() => '?').join(',')})` : '';
    const first = db.prepare(`SELECT device_serial FROM pending_events WHERE status = 'pending' ${except} ORDER BY punched_local, id LIMIT 1`).get(...skip);
    if (!first) break;
    const batch = db.prepare(`SELECT * FROM pending_events WHERE status = 'pending' AND device_serial = ?
        ORDER BY punched_local, id LIMIT ?`).all(first.device_serial, BATCH_SIZE);
    const ids = batch.map((row) => row.id);
    const marks = ids.map(() => '?').join(',');
    // "syncing" queda escrito en disco: si la computadora se apaga a mitad del envío, al arrancar vuelve a
    // "pending" y se reenvía. La central reconoce el identificador y no la duplica.
    db.prepare(`UPDATE pending_events SET status = 'syncing', attempts = attempts + 1 WHERE id IN (${marks})`).run(...ids);
    let response;
    try {
      const device = deviceReporter().find((item) => item.serial === first.device_serial) || { serial: first.device_serial };
      response = await centralRequest('/api/attendance/events', { method: 'POST', body: {
        agentVersion: config.version,
        device,
        events: batch.map((row) => ({ event_uuid: row.event_uuid, user_id: row.zk_user_id, punched_at: row.punched_local,
          verify: row.verify_status, punch: row.punch_state }))
      } });
    } catch (error) {
      // 400/413/422 sin ser del lector: la central entendió el pedido y lo rechazó; reenviarlo igual no cambia nada.
      const aboutDevice = DEVICE_REFUSALS.has(error.code);
      const permanent = !aboutDevice && [400, 413, 422].includes(error.status);
      db.prepare(`UPDATE pending_events SET status = ?, last_error = ? WHERE id IN (${marks})`)
        .run(permanent ? 'error' : 'pending', String(error.message).slice(0, 300), ...ids);
      if (aboutDevice) {
        refusedNow.set(first.device_serial, error);
        blockedDevices.set(first.device_serial, Date.now() + MAX_BACKOFF_MS);
        noteProblem(error, 'send');
        continue;
      }
      const message = sendFailed(error);
      if (manual) throw new CentralError(message, error);
      return { ...totals, error: message };
    }
    const byUuid = new Map((Array.isArray(response.results) ? response.results : []).map((item) => [item?.event_uuid, item]));
    const synced = db.prepare("UPDATE pending_events SET status = 'synced', synced_at = ?, last_error = '', central_result = ? WHERE id = ?");
    const rejected = db.prepare("UPDATE pending_events SET status = 'error', last_error = ? WHERE id = ?");
    const again = db.prepare("UPDATE pending_events SET status = 'pending', last_error = 'La central no confirmó esta marcación.' WHERE id = ?");
    const now = { registered: 0, already: 0, rejected: 0 };
    for (const row of batch) {
      const result = byUuid.get(row.event_uuid);
      if (result?.status === 'registered' || result?.status === 'already_registered') {
        synced.run(nowIso(), describeResult(result), row.id);
        now[result.status === 'registered' ? 'registered' : 'already'] += 1;
      } else if (result?.status === 'rejected') {
        rejected.run(String(result.detail || 'La central rechazó esta marcación.').slice(0, 300), row.id);
        now.rejected += 1;
      } else again.run(row.id);
    }
    totals.sent += batch.length;
    for (const key of Object.keys(now)) totals[key] += now[key];
    blockedDevices.delete(first.device_serial);
    sendSucceeded();
    log({ received: batch.length, imported: now.registered, duplicates: now.already, durationMs: Date.now() - started,
      message: `${batch.length} enviada(s) · ${now.registered} registrada(s) · ${now.already} ya estaban${now.rejected ? ` · ${now.rejected} rechazada(s)` : ''}`,
      result: now.rejected ? 'ERROR' : 'OK' });
    // Si la central no confirmó ninguna, no se insiste en bucle: se espera al próximo intento.
    if (!now.registered && !now.already && !now.rejected) { sendFailed(new CentralError('La central no confirmó las marcaciones enviadas.')); break; }
  }
  if (refusedNow.size) {
    const error = [...refusedNow.values()][0];
    if (manual && !totals.sent) throw new CentralError(String(error.message), error);
    totals.error = String(error.message);
  }
  return totals;
}

function flush({ manual = false } = {}) {
  if (running) return running;
  running = sendBatches(manual).finally(() => { running = null; });
  return running;
}

export async function flushNow() {
  if (!currentLink()) throw new Error('Esta computadora no está conectada a una central.');
  if (running) await running.catch(() => {});
  const result = await flush({ manual: true });
  return { ...result, queue: queueStats() };
}

async function heartbeat() {
  const stats = queueStats();
  const response = await centralRequest('/api/agent/heartbeat', { method: 'POST',
    body: { agentVersion: config.version, devices: deviceReporter(), queue: { waiting: stats.waiting, error: stats.error } } });
  const saved = currentLink();
  const branchName = String(response.branch?.name || '');
  const branchCode = String(response.branch?.code || '');
  if (saved && branchName && (branchName !== saved.branchName || branchCode !== saved.branchCode)) {
    link = { ...saved, branchName, branchCode, centralName: String(response.central || saved.centralName) };
    saveCentralLink(link);
  }
}

// Un ciclo: primero el latido (si toca) y después la cola. Si el latido falla no se intenta enviar: fallaría igual.
async function cycle() {
  if (Date.now() >= nextBeatAt) {
    nextBeatAt = Date.now() + config.linkHeartbeatMs;
    try {
      await heartbeat();
      nextSendAt = 0;
      noteWorking('beat');
    } catch (error) {
      noteProblem(error, problemSource || 'beat');
      nextSendAt = Math.max(nextSendAt, nextBeatAt);
      return;
    }
  }
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM pending_events WHERE status = 'pending'").get().n;
  if (!waiting && problemSource === 'send' && Date.now() >= nextSendAt) { // ya no queda nada trabado
    blockedDevices.clear();
    noteWorking('send');
  }
  if (waiting && Date.now() >= nextSendAt) await sendBatches(false);
}

function tick() {
  if (stopping || !currentLink() || running) return;
  try { running = cycle().catch(() => {}).finally(() => { running = null; }); }
  catch { running = null; } // la base se está cerrando
}

// Aviso de que hay marcaciones nuevas en la cola: se envían ya, sin esperar al próximo ciclo.
export function kickLink() {
  if (stopping || !currentLink()) return;
  setTimeout(tick, 50).unref?.();
}

export function startLinkWorker() {
  stopping = false;
  // Lo que quedó "enviándose" cuando se apagó la computadora vuelve a la cola.
  try {
    db.prepare("UPDATE pending_events SET status = 'pending' WHERE status = 'syncing'").run();
    // Un aviso que quedó de antes de apagar se revisa con el primer latido.
    if (!problemSource && getSetting('central_link_last_error')) problemSource = 'beat';
  } catch { /* base cerrándose */ }
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setTimeout(tick, 800).unref?.();
}

export function stopLinkWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------- Conectar y desconectar ----------

export async function connectToCentral({ url, key, confirm = false } = {}) {
  const target = { url: normalizeCentralUrl(url), key: String(key ?? '').trim() };
  if (!KEY_FORMAT.test(target.key)) throw new Error('La clave de sucursal no tiene el formato esperado. Copiala completa desde la central.');
  if (db.prepare('SELECT COUNT(*) AS n FROM branch_agents').get().n > 0) {
    throw new Error('Esta computadora es la central: tiene sucursales registradas. Una computadora es central o es sucursal, no las dos.');
  }
  const employees = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE COALESCE(archived, 0) = 0').get().n;
  if (employees > 0 && confirm !== true && confirm !== 'true') {
    throw Object.assign(new Error(`Esta computadora tiene ${employees} empleado(s) registrado(s). Al conectarla como sucursal deja de registrar la asistencia por su cuenta: todo pasa a verse en la central.`),
      { status: 409, code: 'confirm' });
  }
  const hello = await centralRequest('/api/agent/hello', { using: target });
  if (hello.qubiq !== 'central') throw new Error('En esa dirección no responde una central de Qubiq Control.');
  link = { ...target, connectedAt: nowIso(), branchName: String(hello.branch?.name || ''), branchCode: String(hello.branch?.code || ''),
    centralName: String(hello.central || ''), agentName: String(hello.agent || '') };
  saveCentralLink(link);
  failures = 0;
  nextSendAt = 0;
  nextBeatAt = 0;
  problemSource = '';
  blockedDevices.clear();
  setSetting('central_link_last_ok', nowIso());
  setSetting('central_link_last_error', '');
  audit('ADMIN', 'CENTRAL_LINK', 'SETTINGS', null, { url: target.url, branch: link.branchCode });
  log({ action: 'Conexión con la central', message: `Conectada como ${link.branchName || 'sucursal'}.` });
  startLinkWorker();
  kickLink();
  return linkStatus();
}

export function disconnectFromCentral({ force = false } = {}) {
  const current = currentLink();
  if (!current) return linkStatus();
  const stats = queueStats();
  if (stats.waiting > 0 && force !== true && force !== 'true') {
    throw Object.assign(new Error(`Hay ${stats.waiting} marcación(es) que todavía no llegaron a la central. Si desconectás ahora no se envían.`),
      { status: 409, code: 'confirm' });
  }
  saveCentralLink(null);
  link = null;
  audit('ADMIN', 'CENTRAL_UNLINK', 'SETTINGS', null, { url: current.url, waiting: stats.waiting });
  log({ action: 'Conexión con la central', message: 'Desconectada de la central.' });
  return linkStatus();
}

export function linkStatus() {
  const current = currentLink();
  if (!current) return { connected: false };
  const lastError = getSetting('central_link_last_error') || '';
  return {
    connected: true,
    url: current.url,
    keyHint: current.key.slice(-4),
    branchName: current.branchName,
    branchCode: current.branchCode,
    centralName: current.centralName,
    agentName: current.agentName,
    connectedAt: current.connectedAt,
    lastOkAt: getSetting('central_link_last_ok') || null,
    lastError,
    lastErrorAt: lastError ? (getSetting('central_link_last_error_at') || null) : null,
    queue: queueStats()
  };
}

// ---------- Vista de la cola para la pantalla del lector ----------

const QUEUE_STATUS = { pending: 'QUEUED', syncing: 'QUEUED', error: 'SEND_ERROR' };
const OUTCOME_NOTE = {
  applied: 'Registrada en la central',
  unmapped: 'Llegó a la central, pero ese ID todavía no tiene empleado vinculado',
  rejected: 'Llegó a la central y no se aplicó',
  ignored: 'Llegó a la central y se ignoró',
  invalid: 'Llegó a la central con fecha inválida'
};

export function listQueue({ deviceId = null, limit = 100 } = {}) {
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  const sql = `SELECT p.id, p.event_uuid AS eventUuid, p.device_id AS deviceId, COALESCE(d.name, p.device_serial) AS deviceName,
      p.zk_user_id AS zkUserId, p.punched_local AS punchedLocal, p.status, p.last_error AS lastError, p.central_result AS centralResult
    FROM pending_events p LEFT JOIN biometric_devices d ON d.id = p.device_id`;
  const rows = deviceId
    ? db.prepare(`${sql} WHERE p.device_id = ? ORDER BY p.id DESC LIMIT ?`).all(Number(deviceId), max)
    : db.prepare(`${sql} ORDER BY p.id DESC LIMIT ?`).all(max);
  const current = currentLink();
  return rows.map((row) => {
    let central = {};
    try { central = JSON.parse(row.centralResult || '{}'); } catch { central = {}; }
    const sent = row.status === 'synced';
    return {
      id: row.id, eventUuid: row.eventUuid, deviceId: row.deviceId, deviceName: row.deviceName,
      branchCode: current?.branchCode || '', branchName: current?.branchName || '',
      zkUserId: row.zkUserId, punchedLocal: row.punchedLocal,
      status: sent ? (central.outcome === 'applied' ? 'SENT' : 'SENT_PENDING') : QUEUE_STATUS[row.status],
      note: sent
        ? `${OUTCOME_NOTE[central.outcome] || 'Enviada a la central'}${central.detail ? `: ${central.detail}` : ''}`
        : (row.lastError || 'Esperando conexión con la central'),
      employee: sent ? (central.employee || '') : ''
    };
  });
}
