// Prueba de dos instalaciones de Qubiq Control hablando entre sí: una central y una sucursal, cada una con su
// propio proceso, su propia base de datos y su propio lector simulado (scripts/fake-zk-device.mjs).
// Cubre la clave de sucursal, el puerto de recepción, el envío, los duplicados, los cortes de conexión, los
// reinicios, la licencia y una jornada con entrada en una sucursal y salida en otra.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FakeZkDevice } from './fake-zk-device.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const baseDir = resolve(root, `.smoke-multi-${Date.now()}`);
const ports = { central: 3257, centralAgents: 3258, branch: 3259, branchAgents: 3260, license: 3261 };
const PASSWORD = 'PruebaSegura2026';
const TZ = 'America/Costa_Rica';

const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(minutes) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(Date.now() - minutes * 60000)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}
const two = (n) => String(n).padStart(2, '0');
const stamp = (t) => `${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}`;
const clock = (t) => `${two(t.hour)}:${two(t.minute)}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(150);
  }
  throw new Error(`Tiempo agotado esperando: ${label} (último valor: ${JSON.stringify(last)})`);
}

let licenseValid = true;
const licenseServer = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ valid: licenseValid, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      message: licenseValid ? '' : 'Suscripción vencida.' }));
  });
});

// Una instalación de Qubiq Control en su propio proceso, manejada por su panel de administración.
class Qubiq {
  constructor(name, port, agentPort) {
    this.name = name;
    this.port = port;
    this.agentPort = agentPort;
    this.dataDir = resolve(baseDir, name);
    this.base = `http://127.0.0.1:${port}`;
    this.cookie = '';
    this.child = null;
    this.output = '';
  }

  async start() {
    mkdirSync(this.dataDir, { recursive: true });
    this.child = spawn(process.execPath, ['src/server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, QUBIQ_ROOT_DIR: root, QUBIQ_DATA_DIR: this.dataDir, PORT: String(this.port), AGENT_PORT: String(this.agentPort),
      LICENSE_SERVER_URL: `http://127.0.0.1:${ports.license}`, LINK_HEARTBEAT_SECONDS: '2' } });
    this.child.stdout.on('data', (chunk) => { this.output += chunk; });
    this.child.stderr.on('data', (chunk) => { this.output += chunk; });
    await until(async () => (await fetch(`${this.base}/api/status`)).ok, `${this.name} arriba`);
    if (this.cookie) return;
    const status = await (await fetch(`${this.base}/api/status`)).json();
    const response = status.setupRequired
      ? await fetch(`${this.base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessName: 'Farmacia de Prueba', branchName: this.name, adminName: 'Admin', password: PASSWORD }) })
      : await fetch(`${this.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(response.status, 200, `${this.name}: no se pudo entrar al panel`);
    this.cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.cookie = '';
    const gone = new Promise((done) => child.once('exit', done));
    child.kill('SIGKILL'); // como un corte de luz: sin oportunidad de cerrar nada con prolijidad
    await gone;
  }

  async call(path, { method = 'GET', body, status = 200, headers = {} } = {}) {
    const response = await fetch(`${this.base}${path}`, { method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (status !== null) assert.equal(response.status, status, `${this.name} ${method} ${path} → ${response.status} ${JSON.stringify(data)}`);
    return data;
  }

  // Solo para preparar el escenario: adelantar la fecha de activación de un lector, como hacen las otras pruebas.
  sql(statement, ...args) {
    const db = new DatabaseSync(resolve(this.dataDir, 'qubiq.db'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const prepared = db.prepare(statement);
      return /^\s*select/i.test(statement) ? prepared.all(...args) : prepared.run(...args);
    } finally { db.close(); }
  }
}

const central = new Qubiq('Aguas Zarcas', ports.central, ports.centralAgents);
const branch = new Qubiq('Venecia', ports.branch, ports.branchAgents);
const agentBase = `http://127.0.0.1:${ports.centralAgents}`;
const readerCentral = new FakeZkDevice({ serial: 'CEN0001' });
const readerBranch = new FakeZkDevice({ serial: 'VEN0001' });
const readerBranch2 = new FakeZkDevice({ serial: 'VEN0002' });
const asAgent = (key, path, { method = 'GET', body, headers = {} } = {}) => fetch(`${agentBase}${path}`, { method, redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) });
const uuidFor = async (serial, userId, local) => {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha1').update(`qubiq-control/marcacion/v1|${serial}|${userId}|${local}|1|0`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
// Pedido con la cabecera Host que uno quiera, como el que llega por un túnel de TCP puro.
const withHost = (port, path, host) => new Promise((done, fail) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
  req.on('error', fail);
  req.end();
});
const rowFor = async (name, date) => (await central.call(`/api/admin/overview?date=${date}`)).rows.find((row) => row.name === name);
const dateOf = (t) => `${t.year}-${two(t.month)}-${two(t.day)}`;

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };
let failed = false;

try {
  await new Promise((done) => licenseServer.listen(ports.license, '127.0.0.1', done));
  const centralReaderPort = await readerCentral.start(0);
  const branchReaderPort = await readerBranch.start(0);

  // ----- Central: negocio, empleados y su propio lector -----
  await central.start();
  assert.equal((await central.call('/api/admin/license', { method: 'POST', body: { licenseKey: 'QBQ-TEST-TEST-TEST-TEST' } })).license.valid, true);
  const [agz] = await central.call('/api/admin/branches');
  const ven = await central.call('/api/admin/branches', { method: 'POST', body: { name: 'Venecia' } });
  const pital = await central.call('/api/admin/branches', { method: 'POST', body: { name: 'Pital' } });
  assert.equal(agz.code, 'AGZ');
  assert.equal(ven.code, 'VEN');
  const schedule = await central.call('/api/admin/schedules', { method: 'POST', status: 201, body: { name: 'Turno', startTime: '08:00', endTime: '17:00', toleranceMinutes: 5 } });
  const person = async (code, name, nationalId) => (await central.call('/api/admin/employees', { method: 'POST', status: 201,
    body: { employeeCode: code, name, nationalId, email: `${code.toLowerCase()}@example.com`, pin: '1234', scheduleId: schedule.id } })).id;
  const ana = await person('EMP001', 'Ana Prueba', '101110111');
  const beto = await person('EMP002', 'Beto Prueba', '202220222');
  const caro = await person('EMP003', 'Caro Prueba', '303330333');
  const centralReader = await central.call('/api/admin/biometric/devices', { method: 'POST',
    body: { name: 'ZK-AGZ-01', ip: '127.0.0.1', port: centralReaderPort, branchId: agz.id } });
  assert.equal((await central.call(`/api/admin/biometric/devices/${centralReader.id}/test`, { method: 'POST', body: {} })).ok, true);
  central.sql('UPDATE biometric_devices SET import_since = ? WHERE id = ?', new Date(Date.now() - 3 * 86400000).toISOString(), centralReader.id);
  await central.call('/api/admin/biometric/mappings', { method: 'PUT', body: { employeeId: ana, deviceId: centralReader.id, zkUserId: '1' } });
  await central.call('/api/admin/biometric/mappings', { method: 'PUT', body: { employeeId: beto, deviceId: centralReader.id, zkUserId: '2' } });
  await central.call('/api/admin/biometric/mappings', { method: 'PUT', body: { employeeId: caro, deviceId: centralReader.id, zkUserId: '3' } });

  // ----- Sin sucursales conectadas, el puerto de recepción ni siquiera está abierto -----
  let overview = await central.call('/api/admin/central');
  assert.equal(overview.role, 'single');
  assert.equal(overview.listener.listening, false);
  await assert.rejects(() => asAgent('', '/api/agent/hello'), 'El puerto de recepción no debe estar abierto sin sucursales conectadas.');
  ok('una instalación de una sola sucursal no abre el puerto de recepción');

  // ----- Clave de sucursal -----
  const created = await central.call('/api/admin/central/agents', { method: 'POST', body: { branchId: ven.id } });
  const key = created.key;
  assert.match(key, /^qbq_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.agent.name, 'Computadora de Venecia');
  assert.equal(created.agent.branchCode, 'VEN');
  assert.equal(created.agent.keyHint, key.slice(-4));
  // Para que la prueba no dependa de la hora en que corre: la clave "existe" desde hace tres días.
  central.sql('UPDATE branch_agents SET created_at = ? WHERE id = ?', new Date(Date.now() - 3 * 86400000).toISOString(), created.agent.id);
  overview = await central.call('/api/admin/central');
  assert.equal(overview.role, 'central');
  assert.equal(overview.listener.listening, true);
  assert.equal(JSON.stringify(overview).includes(key), false, 'La clave solo se muestra al crearla.');
  const storedAgent = central.sql('SELECT * FROM branch_agents')[0];
  assert.equal(JSON.stringify(storedAgent).includes(key), false, 'En la base solo se guarda el hash de la clave.');
  assert.match(storedAgent.key_hash, /^[0-9a-f]{64}$/);
  await central.call('/api/admin/central/agents', { method: 'POST', status: 400, body: { branchId: ven.id } });
  await central.call('/api/admin/central/agents', { method: 'POST', status: 400, body: { branchId: 9999 } });
  await central.call(`/api/admin/branches/${ven.id}/active`, { method: 'PATCH', status: 400, body: { active: false } });
  ok('clave por sucursal: se muestra una vez y solo se guarda su hash');

  // ----- El puerto de recepción no sirve el panel y exige la clave -----
  assert.equal((await asAgent('', '/api/agent/hello')).status, 401);
  assert.equal((await asAgent('qbq_' + 'x'.repeat(43), '/api/agent/hello')).status, 401);
  assert.equal((await asAgent('', '/admin.html')).status, 401);
  assert.equal((await asAgent(key, '/admin.html')).status, 404);
  assert.equal((await asAgent(key, '/api/admin/employees')).status, 404);
  assert.equal((await asAgent(key, '/api/status')).status, 404);
  const hello = await (await asAgent(key, '/api/agent/hello')).json();
  assert.equal(hello.qubiq, 'central');
  assert.deepEqual(hello.branch, { name: 'Venecia', code: 'VEN' });
  ok('el puerto de recepción solo responde a quien trae la clave, y nunca muestra el panel');

  // ----- El panel no se sirve a través de un túnel o proxy -----
  for (const header of [{ 'X-Forwarded-For': '203.0.113.9' }, { 'CF-Connecting-IP': '203.0.113.9' }, { Via: '1.1 tunel' }]) {
    assert.equal((await fetch(`${central.base}/api/status`, { headers: header })).status, 403);
    assert.equal((await fetch(`${central.base}/admin.html`, { headers: header })).status, 403);
    assert.equal((await fetch(`${central.base}/api/admin/employees`, { headers: { ...header, Cookie: central.cookie } })).status, 403);
  }
  assert.equal((await fetch(`${central.base}/api/attendance/mark`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: '{}' })).status, 403);
  // Ninguna otra forma de escribir la ruta se cuela: mayúsculas, %xx, sin extensión, barras dobles.
  for (const path of ['/API/status', '/api/STATUS', '/api/Admin/employees', '/api/AUTH/me', '/api/Setup', '/admin', '/Admin.html', '/%61dmin.html',
    '/admin%2ejs', '/central%2Ejs', '//admin.html', '/setup', '/kiosk', '/api/admin/central', '/api/google/oauth/callback']) {
    const response = await fetch(`${central.base}${path}`, { headers: { 'X-Forwarded-For': '203.0.113.9', Cookie: central.cookie } });
    assert.equal(response.status, 403, `${path} no debe responder a través de un túnel (respondió ${response.status})`);
  }
  // Un túnel de TCP puro no agrega cabeceras, pero el pedido viene dirigido a un nombre que no es el de esta computadora.
  assert.equal(await withHost(ports.central, '/admin.html', 'qubiq.ejemplo.com'), 403);
  assert.equal(await withHost(ports.central, '/api/status', '203.0.113.7:3220'), 403);
  assert.equal(await withHost(ports.central, '/api/status', `localhost:${ports.central}`), 200);
  // Lo único que sí se le atiende a otro equipo: la página para marcar con el QR.
  assert.equal((await fetch(`${central.base}/mark.html`, { headers: { 'X-Forwarded-For': '192.168.1.50' } })).status, 200);
  assert.equal(await withHost(ports.central, '/api/branding', '192.168.1.10:3220'), 200);
  ok('el panel no responde si el pedido llegó por un túnel, se escriba la ruta como se escriba');

  // ----- Sucursal: instalación nueva, sin licencia propia, que se conecta a la central -----
  await branch.start();
  await branch.call('/api/admin/central/link', { method: 'PUT', status: 400, body: { url: 'http://203.0.113.5:3221', key } });
  await branch.call('/api/admin/central/link', { method: 'PUT', status: 400, body: { url: agentBase, key: 'clave-corta' } });
  let link = await branch.call('/api/admin/central/link', { method: 'PUT', status: 502, body: { url: agentBase, key: `qbq_${'y'.repeat(43)}` } });
  assert.match(link.error, /clave/i);
  assert.equal((await branch.call('/api/admin/central')).role, 'single', 'Una clave rechazada no deja nada conectado.');
  link = await branch.call('/api/admin/central/link', { method: 'PUT', body: { url: agentBase, key } });
  assert.equal(link.connected, true);
  assert.equal(link.branchCode, 'VEN');
  assert.equal(link.keyHint, key.slice(-4));
  assert.equal(JSON.stringify(link).includes(key), false);
  assert.equal((await branch.call('/api/status')).branchMode, true);
  assert.equal((await branch.call('/api/admin/central')).role, 'branch');
  const sealed = (await import('node:fs')).readFileSync(resolve(branch.dataDir, 'integrations.enc'), 'utf8');
  assert.equal(sealed.includes(key), false, 'La clave de la sucursal se guarda cifrada.');
  await branch.call('/api/admin/central/agents', { method: 'POST', status: 400, body: { branchId: 1 } });
  await central.call('/api/admin/central/link', { method: 'PUT', status: 400, body: { url: agentBase, key } });
  await branch.call('/api/admin/qr.png', { status: 409 });
  await branch.call('/api/admin/attendance/mark', { method: 'POST', status: 409, body: { employeeCode: 'EMP001', pin: '1234' } });
  await branch.call('/api/admin/employees', { method: 'POST', status: 409, body: { employeeCode: 'X1', name: 'Nadie' } });
  ok('la sucursal se conecta con dirección y clave; una computadora es central o sucursal, no las dos');

  // ----- Lector de la sucursal y registro de huellas contra la lista de la central -----
  const branchReader = await branch.call('/api/admin/biometric/devices', { method: 'POST', body: { name: 'ZK-VEN-01', ip: '127.0.0.1', port: branchReaderPort } });
  assert.equal((await branch.call(`/api/admin/biometric/devices/${branchReader.id}/test`, { method: 'POST', body: {} })).ok, true);
  branch.sql('UPDATE biometric_devices SET import_since = ? WHERE id = ?', new Date(Date.now() - 3 * 86400000).toISOString(), branchReader.id);
  const directory = await branch.call(`/api/admin/biometric/devices/${branchReader.id}/mappings`);
  assert.deepEqual(directory.rows.map((row) => [row.name, row.zkUserId, row.sharedId]), [['Ana Prueba', '', '1'], ['Beto Prueba', '', '2'], ['Caro Prueba', '', '3']]);
  assert.equal(JSON.stringify(directory).includes('101110111'), false, 'A la sucursal no viajan cédulas ni PIN.');
  let devices = await central.call('/api/admin/biometric/devices');
  const remote = devices.find((device) => device.serialNumber === 'VEN0001');
  assert.ok(remote, 'La central registra sola el lector de la sucursal la primera vez que se reporta.');
  assert.equal(remote.remote, true);
  assert.equal(remote.name, 'ZK-VEN-01');
  assert.equal(remote.branchCode, 'VEN');
  assert.equal(remote.agentName, 'Computadora de Venecia');
  central.sql('UPDATE biometric_devices SET import_since = ? WHERE id = ?', new Date(Date.now() - 3 * 86400000).toISOString(), remote.id);
  const enrolled = await branch.call('/api/admin/biometric/enroll', { method: 'POST', body: { employeeId: ana, deviceId: branchReader.id } });
  assert.equal(enrolled.enrolled, true, enrolled.error);
  assert.equal(enrolled.zkUserId, '1', 'En la sucursal se usa el mismo ID que la persona ya tiene.');
  assert.equal(readerBranch.users.some((user) => user.userId === '1' && user.name === 'Ana Prueba'), true);
  const taken = await branch.call('/api/admin/biometric/mappings', { method: 'PUT', status: 502, body: { employeeId: beto, deviceId: branchReader.id, zkUserId: '1' } });
  assert.match(taken.error, /ya está asignado a Ana Prueba/);
  await branch.call('/api/admin/biometric/mappings', { method: 'PUT', body: { employeeId: beto, deviceId: branchReader.id, zkUserId: '2' } });
  const linked = await central.call(`/api/admin/biometric/devices/${remote.id}/mappings`);
  assert.deepEqual(linked.rows.map((row) => row.zkUserId), ['1', '2', null]);
  const fingers = await branch.call(`/api/admin/biometric/employees/${ana}`);
  assert.deepEqual(fingers.map((item) => [item.deviceName, item.zkUserId]), [['ZK-VEN-01', '1']]);
  for (const action of ['test', 'sync']) {
    const refused = await central.call(`/api/admin/biometric/devices/${remote.id}/${action}`, { method: 'POST', status: 400, body: {} });
    assert.match(refused.error, /otra sucursal/);
  }
  // Desde la central, de un lector remoto solo se cambia cómo se muestra; la huella se registra allá.
  const renamed = await central.call(`/api/admin/biometric/devices/${remote.id}`, { method: 'PATCH', body: { name: 'Lector de Venecia', minGapSeconds: 90, ip: '10.0.0.9', port: 1 } });
  assert.equal(renamed.name, 'Lector de Venecia');
  assert.equal(renamed.minGapSeconds, 90);
  assert.equal(renamed.remote, true);
  assert.equal(central.sql('SELECT ip FROM biometric_devices WHERE id = ?', remote.id)[0].ip, 'serie:VEN0001');
  await central.call(`/api/admin/biometric/devices/${remote.id}`, { method: 'PATCH', body: { name: 'ZK-VEN-01', minGapSeconds: 120 } });
  const anaReaders = await central.call(`/api/admin/biometric/employees/${ana}`);
  assert.deepEqual(anaReaders.map((item) => [item.deviceName, item.remote, item.zkUserId]), [['ZK-AGZ-01', false, '1'], ['ZK-VEN-01', true, '1']]);
  const noEnroll = await central.call('/api/admin/biometric/enroll', { method: 'POST', status: 400, body: { employeeId: ana, deviceId: remote.id } });
  assert.match(noEnroll.error, /otra sucursal/);
  ok('la huella se registra en la sucursal con la lista de empleados de la central y el mismo ID');

  // ----- Una marcación en la sucursal llega a la central -----
  const anaIn = ago(95);
  readerBranch.punch('1', anaIn);
  let sync = await branch.call(`/api/admin/biometric/devices/${branchReader.id}/sync`, { method: 'POST', body: {} });
  assert.equal(sync.queued, 1);
  await until(async () => (await rowFor('Ana Prueba', dateOf(anaIn)))?.entry === clock(anaIn), 'entrada de Ana en la central');
  let anaRow = await rowFor('Ana Prueba', dateOf(anaIn));
  assert.equal(anaRow.entryBranch, 'VEN', 'La marca queda en la sucursal donde se hizo.');
  assert.equal(anaRow.exit, null);
  assert.equal(branch.sql('SELECT COUNT(*) AS n FROM attendance')[0].n, 0, 'La sucursal no registra asistencia por su cuenta.');
  let queue = await until(async () => {
    const events = await branch.call('/api/admin/biometric/events');
    return events[0]?.status === 'SENT' ? events : null;
  }, 'confirmación de la central');
  assert.equal(queue[0].employee, 'Ana Prueba');
  assert.match(queue[0].note, /Registrada en la central: Entrada/);
  const centralEvents = await central.call('/api/admin/biometric/events');
  assert.equal(centralEvents[0].branchCode, 'VEN');
  assert.equal(centralEvents[0].status, 'APPLIED');
  assert.equal(centralEvents[0].eventUuid, await uuidFor('VEN0001', '1', stamp(anaIn)));
  ok('la marcación de la sucursal se registra en la central con su sucursal y su lector');

  // ----- Reenvíos: nunca se duplica -----
  const anaEvent = { event_uuid: await uuidFor('VEN0001', '1', stamp(anaIn)), user_id: '1', punched_at: stamp(anaIn), verify: 1, punch: 0 };
  const device = { serial: 'VEN0001', name: 'ZK-VEN-01' };
  let reply = await (await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device, events: [anaEvent, anaEvent] } })).json();
  assert.deepEqual(reply.results.map((item) => item.status), ['already_registered']);
  assert.equal(reply.results[0].outcome, 'applied');
  sync = await branch.call(`/api/admin/biometric/devices/${branchReader.id}/sync`, { method: 'POST', body: { full: true } });
  assert.equal(sync.queued, 0);
  assert.equal(central.sql('SELECT COUNT(*) AS n FROM attendance')[0].n, 1);
  assert.equal(central.sql('SELECT COUNT(*) AS n FROM biometric_events')[0].n, 1);
  ok('la misma marcación enviada otra vez responde "ya registrada" y no duplica');

  // ----- Lo que la central no acepta -----
  const other = ago(40);
  reply = await (await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device, events: [
    { ...anaEvent, punched_at: stamp(other) },
    { event_uuid: await uuidFor('VEN0001', '1', '2026-13-45 99:00:00'), user_id: '1', punched_at: '2026-13-45 99:00:00', verify: 1, punch: 0 },
    { event_uuid: 'no-es-un-uuid', user_id: '1', punched_at: stamp(other), verify: 1, punch: 0 }
  ] } })).json();
  assert.deepEqual(reply.results.map((item) => item.status), ['rejected', 'rejected', 'rejected']);
  assert.equal((await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device, events: [] } })).status, 400);
  assert.equal((await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device, events: Array.from({ length: 501 }, () => anaEvent) } })).status, 413);
  assert.equal((await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device: {}, events: [anaEvent] } })).status, 400);
  // Otra sucursal no puede enviar marcaciones en nombre de un lector que no es suyo.
  const second = await central.call('/api/admin/central/agents', { method: 'POST', body: { branchId: pital.id } });
  let stolen = await asAgent(second.key, '/api/attendance/events', { method: 'POST', body: { device, events: [anaEvent] } });
  assert.equal(stolen.status, 403);
  assert.equal((await stolen.json()).code, 'device_not_authorized');
  stolen = await asAgent(second.key, '/api/attendance/events', { method: 'POST', body: { device: { serial: 'CEN0001' }, events: [anaEvent] } });
  assert.equal(stolen.status, 403);
  assert.equal(JSON.stringify(await stolen.json()).includes('ZK-AGZ-01'), false, 'A otra sucursal no se le cuenta qué lectores tiene la central.');
  assert.equal(central.sql('SELECT COUNT(*) AS n FROM attendance')[0].n, 1);
  ok('rechaza identificadores falsos, fechas inválidas y lectores de otra sucursal');

  // ----- La central informa cómo están los lectores de las sucursales -----
  await until(async () => (await central.call('/api/admin/biometric/devices')).find((item) => item.id === remote.id)?.status === 'CONNECTED', 'lector remoto conectado');
  await readerBranch.stop();
  await branch.call(`/api/admin/biometric/devices/${branchReader.id}/test`, { method: 'POST', body: {} });
  const down = await until(async () => {
    const item = (await central.call('/api/admin/biometric/devices')).find((entry) => entry.id === remote.id);
    return item.status === 'DISCONNECTED' ? item : null;
  }, 'lector remoto desconectado');
  assert.ok(down.lastError);
  await readerBranch.start(branchReaderPort);
  await branch.call(`/api/admin/biometric/devices/${branchReader.id}/test`, { method: 'POST', body: {} });
  await until(async () => (await central.call('/api/admin/biometric/devices')).find((item) => item.id === remote.id)?.status === 'CONNECTED', 'lector remoto recuperado');
  const agents = (await central.call('/api/admin/central')).agents;
  assert.equal(agents.find((agent) => agent.branchCode === 'VEN').online, true);
  assert.deepEqual(agents.find((agent) => agent.branchCode === 'VEN').readers, ['ZK-VEN-01']);
  ok('la central ve si el lector de la sucursal está conectado o caído');

  // ----- Central apagada: la sucursal guarda en su cola, incluso si ella misma se reinicia -----
  await central.stop();
  const betoIn = ago(60);
  readerBranch.punch('2', betoIn);
  sync = await branch.call(`/api/admin/biometric/devices/${branchReader.id}/sync`, { method: 'POST', body: {} });
  assert.equal(sync.queued, 1);
  link = await until(async () => {
    const state = (await branch.call('/api/admin/central')).link;
    return state.lastError ? state : null;
  }, 'aviso de central sin conexión');
  assert.equal(link.queue.waiting, 1);
  assert.match(link.lastError, /central/i);
  queue = await branch.call('/api/admin/biometric/events');
  assert.equal(queue[0].status, 'QUEUED');
  const flushFailed = await branch.call('/api/admin/central/link/flush', { method: 'POST', status: 502, body: {} });
  assert.match(flushFailed.error, /No se pudo conectar con la central/);
  assert.equal((await branch.call('/api/admin/central')).link.queue.waiting, 1, 'Nada se da por enviado sin la confirmación de la central.');
  // Con la central apagada se agrega un segundo lector en la sucursal y alguien marca en él.
  const branchReader2Port = await readerBranch2.start(0);
  const branchReader2 = await branch.call('/api/admin/biometric/devices', { method: 'POST', body: { name: 'ZK-VEN-02', ip: '127.0.0.1', port: branchReader2Port } });
  assert.equal((await branch.call(`/api/admin/biometric/devices/${branchReader2.id}/test`, { method: 'POST', body: {} })).ok, true);
  branch.sql('UPDATE biometric_devices SET import_since = ? WHERE id = ?', new Date(Date.now() - 2 * 86400000).toISOString(), branchReader2.id);
  const caroIn = ago(30);
  readerBranch2.punch('3', caroIn);
  assert.equal((await branch.call(`/api/admin/biometric/devices/${branchReader2.id}/sync`, { method: 'POST', body: {} })).queued, 1);
  const noDirectory = await branch.call(`/api/admin/biometric/devices/${branchReader2.id}/mappings`, { status: 502 });
  assert.match(noDirectory.error, /central/i);
  await branch.stop();
  // Corte de luz justo a mitad de un envío: la marcación había quedado "enviándose".
  branch.sql("UPDATE pending_events SET status = 'syncing' WHERE status = 'pending'");
  ok('sin conexión con la central, la marcación queda en la cola de la sucursal');

  // Mientras la sucursal sigue apagada, Beto va a la central y marca ahí: la central todavía no sabe de su entrada.
  await central.start();
  const betoOut = ago(6);
  readerCentral.punch('2', betoOut);
  await central.call(`/api/admin/biometric/devices/${centralReader.id}/sync`, { method: 'POST', body: {} });
  let betoRow = await rowFor('Beto Prueba', dateOf(betoOut));
  assert.equal(betoRow.entry, clock(betoOut), 'Sin la marca de Venecia, la central la toma como entrada.');
  assert.equal(betoRow.entryBranch, 'AGZ');

  await branch.start();
  await until(async () => (await rowFor('Beto Prueba', dateOf(betoIn)))?.entry === clock(betoIn), 'entrada atrasada de Beto', 30000);
  betoRow = await rowFor('Beto Prueba', dateOf(betoIn));
  assert.equal(betoRow.entryBranch, 'VEN');
  assert.equal(betoRow.exit, clock(betoOut), 'La marca de la central pasa a ser la salida.');
  assert.equal(betoRow.exitBranch, 'AGZ');
  link = (await branch.call('/api/admin/central')).link;
  assert.equal(link.queue.waiting, 0);
  assert.equal(link.lastError, '');
  queue = await branch.call('/api/admin/biometric/events');
  const betoSent = queue.find((event) => event.zkUserId === '2');
  assert.equal(betoSent.status, 'SENT');
  assert.match(betoSent.note, /llegó tarde/);
  assert.equal(central.sql('SELECT COUNT(*) AS n FROM attendance')[0].n, 3);
  ok('al volver la conexión la cola se envía sola y la jornada entre dos sucursales queda en orden');

  // ----- El lector que la central no conocía: lo que marcó mientras estuvo apagada no se pierde -----
  const remote2 = await until(async () => (await central.call('/api/admin/biometric/devices')).find((item) => item.serialNumber === 'VEN0002'), 'segundo lector en la central');
  assert.equal(remote2.branchCode, 'VEN');
  const waitingLink = await until(async () => {
    const event = (await central.call(`/api/admin/biometric/events?deviceId=${remote2.id}`))[0];
    return event?.status === 'UNMAPPED' ? event : null;
  }, 'marcación del lector nuevo guardada en la central');
  assert.equal(waitingLink.punchedLocal, stamp(caroIn), 'No se descarta por ser anterior al momento en que la central conoció el lector.');
  const caroLink = await central.call('/api/admin/biometric/mappings', { method: 'PUT', body: { employeeId: caro, deviceId: remote2.id, zkUserId: '3' } });
  assert.equal(caroLink.reprocessed, 1);
  const caroRow = await rowFor('Caro Prueba', dateOf(caroIn));
  assert.equal(caroRow.entry, clock(caroIn));
  assert.equal(caroRow.entryBranch, 'VEN');
  ok('un lector agregado con la central apagada: sus marcaciones entran cuando la central vuelve');

  // ----- Reloj del lector adelantado: la marca se ve como inválida y no tapa a las que vienen después -----
  readerBranch2.punch('3', ago(-10 * 24 * 60));
  assert.equal((await branch.call(`/api/admin/biometric/devices/${branchReader2.id}/sync`, { method: 'POST', body: {} })).queued, 1);
  const future = await until(async () => {
    const event = (await branch.call(`/api/admin/biometric/events?deviceId=${branchReader2.id}`))[0];
    return event?.status === 'SENT_PENDING' ? event : null;
  }, 'aviso de fecha futura');
  assert.match(future.note, /reloj del lector/);

  // ----- Un lector rechazado por la central no frena a los demás lectores de la sucursal -----
  await central.call(`/api/admin/biometric/devices/${remote.id}/active`, { method: 'PATCH', body: { active: false } });
  const caroOut = ago(4);
  readerBranch.punch('2', ago(2));
  readerBranch2.punch('3', caroOut);
  assert.equal((await branch.call(`/api/admin/biometric/devices/${branchReader.id}/sync`, { method: 'POST', body: {} })).queued, 1);
  assert.equal((await branch.call(`/api/admin/biometric/devices/${branchReader2.id}/sync`, { method: 'POST', body: {} })).queued, 1,
    'Después de una marca con fecha futura, las marcas reales siguen saliendo.');
  await until(async () => (await rowFor('Caro Prueba', dateOf(caroIn)))?.exit === clock(caroOut), 'salida de Caro por el lector que sí está activo');
  link = await until(async () => {
    const state = (await branch.call('/api/admin/central')).link;
    return /desactivado/.test(state.lastError) && state.queue.waiting === 1 ? state : null;
  }, 'aviso del lector desactivado en la central');
  await central.call(`/api/admin/biometric/devices/${remote.id}/active`, { method: 'PATCH', body: { active: true } });
  const released = await branch.call('/api/admin/central/link/flush', { method: 'POST', body: {} });
  assert.equal(released.sent, 1);
  link = (await branch.call('/api/admin/central')).link;
  assert.equal(link.queue.waiting, 0);
  assert.equal(link.lastError, '');
  ok('un lector rechazado por la central espera su turno sin frenar a los otros; una fecha futura no tapa las marcas siguientes');

  // ----- Licencia de la central vencida: las marcaciones esperan en la sucursal -----
  licenseValid = false;
  await central.call('/api/admin/license/recheck', { method: 'POST', body: {} });
  const anaOut = ago(3);
  readerBranch.punch('1', anaOut);
  await branch.call(`/api/admin/biometric/devices/${branchReader.id}/sync`, { method: 'POST', body: {} });
  link = await until(async () => {
    const state = (await branch.call('/api/admin/central')).link;
    return /licencia|vencida/i.test(state.lastError) ? state : null;
  }, 'aviso de licencia');
  assert.equal(link.queue.waiting, 1);
  assert.equal((await rowFor('Ana Prueba', dateOf(anaIn))).exit, null);
  licenseValid = true;
  await central.call('/api/admin/license/recheck', { method: 'POST', body: {} });
  const flushed = await branch.call('/api/admin/central/link/flush', { method: 'POST', body: {} });
  assert.equal(flushed.registered, 1);
  anaRow = await rowFor('Ana Prueba', dateOf(anaIn));
  assert.equal(anaRow.exit, clock(anaOut));
  assert.equal(anaRow.exitBranch, 'VEN');
  ok('con la licencia de la central vencida nada se pierde: espera en la cola y entra al reactivarla');

  // ----- Lector de la sucursal desactivado en la central -----
  await central.call(`/api/admin/biometric/devices/${remote.id}/active`, { method: 'PATCH', body: { active: false } });
  const off = await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device, events: [anaEvent] } });
  assert.equal(off.status, 403);
  assert.equal((await off.json()).code, 'device_disabled');
  await central.call(`/api/admin/biometric/devices/${remote.id}/active`, { method: 'PATCH', body: { active: true } });

  // ----- Un lector que se muda de sucursal, y el tope de lectores por sucursal -----
  const many = Array.from({ length: 12 }, (_, index) => ({ serial: `PIT00${String(index + 1).padStart(2, '0')}`, name: `ZK-PIT-${index + 1}`, lastContactAt: new Date().toISOString() }));
  const beat = await (await asAgent(second.key, '/api/agent/heartbeat', { method: 'POST', body: { devices: many } })).json();
  assert.equal(beat.devices.filter((item) => !item.error).length, 10);
  assert.match(beat.devices[11].error, /10 lectores/);
  assert.equal(central.sql('SELECT COUNT(*) AS n FROM biometric_devices WHERE agent_id = ?', second.agent.id)[0].n, 10, 'Una sucursal no puede llenar la central de lectores.');
  const moving = { serial: 'PIT0001', name: 'ZK-PIT-1' };
  assert.equal((await asAgent(key, '/api/agent/employees', { method: 'POST', body: { device: moving } })).status, 403);
  const movingRow = central.sql("SELECT id FROM biometric_devices WHERE serial_number = 'PIT0001'")[0];
  await central.call(`/api/admin/biometric/devices/${movingRow.id}/active`, { method: 'PATCH', body: { active: false } });
  assert.equal((await asAgent(key, '/api/agent/employees', { method: 'POST', body: { device: moving } })).status, 200);
  const movedRows = central.sql("SELECT b.code, d.agent_id FROM biometric_devices d JOIN branches b ON b.id = d.branch_id WHERE d.serial_number = 'PIT0001'");
  assert.deepEqual(movedRows.map((row) => [row.code, row.agent_id]), [['VEN', created.agent.id]], 'Desactivado en la central, el lector se puede registrar desde su nueva sucursal.');
  ok('un lector solo cambia de sucursal si la central lo suelta, y cada sucursal tiene un tope de lectores');

  // ----- Sucursal desactivada, clave creada por error y clave nueva -----
  const agentId = created.agent.id;
  await central.call(`/api/admin/central/agents/${agentId}/active`, { method: 'PATCH', body: { active: false } });
  let refused = await asAgent(key, '/api/agent/hello');
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'agent_disabled');
  assert.equal((await asAgent(key, '/api/attendance/events', { method: 'POST', body: { device, events: [anaEvent] } })).status, 403);
  const draft = await central.call('/api/admin/central/agents', { method: 'POST', body: { branchId: agz.id, name: 'Clave por error' } });
  assert.equal(draft.agent.removable, true);
  await central.call(`/api/admin/central/agents/${draft.agent.id}`, { method: 'DELETE' });
  assert.equal((await asAgent(draft.key, '/api/agent/hello')).status, 401);
  await central.call(`/api/admin/central/agents/${agentId}`, { method: 'DELETE', status: 400 });
  // Con todas desactivadas el puerto se cierra, pero la lista sigue a la vista para poder reactivarlas.
  await central.call(`/api/admin/central/agents/${second.agent.id}/active`, { method: 'PATCH', body: { active: false } });
  overview = await central.call('/api/admin/central');
  assert.equal(overview.role, 'central');
  assert.equal(overview.listener.listening, false);
  assert.equal(overview.agents.length, 2);
  await assert.rejects(() => asAgent(key, '/api/agent/hello'));
  await central.call(`/api/admin/central/agents/${agentId}/active`, { method: 'PATCH', body: { active: true } });
  assert.equal((await central.call('/api/admin/central')).listener.listening, true);
  const rotated = await central.call(`/api/admin/central/agents/${agentId}/key`, { method: 'POST', body: {} });
  assert.notEqual(rotated.key, key);
  assert.equal((await asAgent(key, '/api/agent/hello')).status, 401, 'La clave anterior deja de servir en el acto.');
  assert.equal((await asAgent(rotated.key, '/api/agent/hello')).status, 200);
  const audited = central.sql("SELECT details_json FROM audit_log WHERE entity_type = 'BRANCH_AGENT'").map((row) => row.details_json).join(' ');
  assert.equal(audited.includes(key) || audited.includes(rotated.key), false, 'La bitácora nunca guarda claves.');
  ok('una sucursal desactivada no puede enviar, y una clave nueva anula la anterior');

  // ----- Desconectar la sucursal -----
  readerBranch.punch('2', ago(1));
  await branch.call(`/api/admin/biometric/devices/${branchReader.id}/sync`, { method: 'POST', body: {} });
  const pendingStop = await branch.call('/api/admin/central/link', { method: 'DELETE', status: 409 });
  assert.equal(pendingStop.code, 'confirm');
  await branch.call('/api/admin/central/link?force=true', { method: 'DELETE' });
  assert.equal((await branch.call('/api/status')).branchMode, false);
  assert.equal((await branch.call('/api/admin/central')).role, 'single');
  ok('desconectar avisa si quedan marcaciones sin enviar');

  console.log(`MULTIBRANCH_TEST_OK ${passed} grupos`);
} catch (error) {
  failed = true;
  console.error(error);
  for (const instance of [central, branch]) {
    if (instance.output.trim()) console.error(`--- salida de ${instance.name} ---\n${instance.output.trim().split('\n').slice(-25).join('\n')}`);
  }
  process.exitCode = 1;
} finally {
  await Promise.all([central.stop(), branch.stop()]);
  await Promise.all([readerCentral.stop(), readerBranch.stop(), readerBranch2.stop()]);
  licenseServer.close();
  if (!failed) rmSync(baseDir, { recursive: true, force: true });
  else console.error(`Datos de la prueba conservados en ${baseDir}`);
}
