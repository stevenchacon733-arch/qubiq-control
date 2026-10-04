// Puerto de recepción de la central. Es lo único que se publica hacia afuera (por el túnel): por acá las otras
// sucursales envían sus marcaciones. No sirve el panel, ni archivos, ni ninguna ruta de administración, y todo
// pedido tiene que traer la clave de una sucursal conectada.
import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { audit } from './db.js';
import {
  agentDirectory, agentHeartbeat, agentHello, agentSetMapping, authenticateAgent, hasActiveAgents, receiveEvents, touchAgent
} from './services/central.js';

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_LIMIT = 30;
const failures = new Map();
let listener = null;
const state = { listening: false, port: config.agentPort, error: '' };

// Detrás del túnel todos los pedidos llegan desde esta misma computadora; la dirección real viene en la cabecera
// que agrega el túnel. Solo se usa para el registro y para frenar a quien prueba claves.
function clientAddress(req) {
  const socketIp = String(req.socket.remoteAddress || '').replace('::ffff:', '');
  if (socketIp === '127.0.0.1' || socketIp === '::1') {
    const forwarded = String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim();
    if (/^[0-9A-Fa-f:.]{3,45}$/.test(forwarded)) return forwarded;
  }
  return socketIp;
}

function rejectedTooOften(address) {
  const entry = failures.get(address);
  if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) return false;
  return entry.count >= FAILURE_LIMIT;
}

// Quien manda claves incorrectas no puede llenar la bitácora: se anota a lo sumo un aviso por minuto, con la
// cuenta de intentos desde el aviso anterior. La dirección que figura es la que dice traer el pedido, y detrás de
// un túnel eso lo puede inventar quien llama; por eso no se usa para nada más que este registro y el freno.
let lastAuditAt = 0;
let rejectedSinceAudit = 0;
function noteFailure(address) {
  rejectedSinceAudit += 1;
  if (Date.now() - lastAuditAt >= 60 * 1000) {
    audit('SYSTEM', 'AGENT_KEY_REJECTED', 'BRANCH_AGENT', null, { address, attempts: rejectedSinceAudit });
    lastAuditAt = Date.now();
    rejectedSinceAudit = 0;
  }
  const entry = failures.get(address);
  if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) {
    if (failures.size > 5000) failures.clear();
    failures.set(address, { count: 1, since: Date.now() });
  } else entry.count += 1;
}

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// Primero la clave (solo mira cabeceras); recién después se lee el cuerpo del pedido.
app.use((req, res, next) => {
  const address = clientAddress(req);
  const agent = authenticateAgent(req.headers.authorization);
  if (!agent) {
    if (rejectedTooOften(address)) return res.status(429).json({ error: 'Demasiados intentos con una clave incorrecta. Esperá unos minutos.', code: 'too_many_attempts' });
    noteFailure(address);
    return res.status(401).json({ error: 'Clave de sucursal incorrecta o faltante.', code: 'unauthorized' });
  }
  req.agent = agent;
  req.agentAddress = address;
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {};
  if (req.agent.active) touchAgent(req.agent, { ip: req.agentAddress, version: req.headers['x-qubiq-version'], queuePending: req.body.queue?.waiting });
  next();
});

const route = (handler) => (req, res) => {
  try { res.json(handler(req)); }
  catch (error) {
    if (!error.status) console.error('Recepción de sucursales:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Error interno de la central.', code: error.code || 'error' });
  }
};

app.get('/api/agent/hello', route((req) => agentHello(req.agent)));
app.post('/api/agent/heartbeat', route((req) => agentHeartbeat(req.agent, req.body)));
app.post('/api/attendance/events', route((req) => receiveEvents(req.agent, req.body)));
app.post('/api/agent/employees', route((req) => agentDirectory(req.agent, req.body)));
app.put('/api/agent/mappings', (req, res) => {
  // Las reglas de los IDs (uno por persona, nunca compartido) devuelven mensajes para mostrarle a la persona.
  try {
    const result = agentSetMapping(req.agent, req.body);
    audit(`AGENT:${req.agent.name}`, 'BIOMETRIC_LINK', 'EMPLOYEE', req.body.employeeId ?? null, { zkUserId: result.zkUserId });
    res.json(result);
  } catch (error) {
    const internal = !error.status && /SQLITE|constraint/i.test(String(error.message));
    if (internal) console.error('Recepción de sucursales:', error);
    res.status(error.status || 400).json({ error: internal ? 'No se pudo guardar el vínculo.' : error.message, code: error.code || 'rule' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'No encontrado.', code: 'not_found' }));
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'El envío es demasiado grande.', code: 'too_large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.', code: 'bad_request' });
  console.error('Recepción de sucursales:', err);
  res.status(500).json({ error: 'Error interno de la central.', code: 'error' });
});

function start() {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.requestTimeout = 30 * 1000;
    server.headersTimeout = 15 * 1000;
    server.once('error', (error) => {
      state.listening = false;
      state.error = error.code === 'EADDRINUSE'
        ? `El puerto ${config.agentPort} ya lo está usando otro programa.`
        : `No se pudo abrir el puerto ${config.agentPort}: ${error.message}`;
      listener = null;
      resolve(false);
    });
    server.listen(config.agentPort, '0.0.0.0', () => {
      listener = server;
      state.listening = true;
      state.error = '';
      resolve(true);
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!listener) return resolve();
    const server = listener;
    listener = null;
    state.listening = false;
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

// El puerto solo está abierto mientras haya al menos una sucursal conectada activa. Una instalación de una sola
// sucursal nunca lo abre.
let pending = Promise.resolve();
export function syncAgentListener() {
  pending = pending.then(async () => {
    let wanted = false;
    try { wanted = hasActiveAgents(); } catch { wanted = false; }
    if (wanted && !listener) await start();
    else if (!wanted && listener) await stop();
  });
  return pending;
}

export function stopAgentListener() {
  pending = pending.then(stop);
  return pending;
}

export const agentListenerStatus = () => ({ ...state });
