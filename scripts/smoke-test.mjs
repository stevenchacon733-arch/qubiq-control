import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';

function unzip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const uncompressed = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressed);
    const content = method === 8 ? inflateRawSync(data) : data;
    assert.equal(content.length, uncompressed, `Tamaño inesperado en ${name} del libro de Excel.`);
    files.set(name, content);
    offset = start + compressed;
  }
  return files;
}

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const dataDir = resolve(root, `.smoke-${Date.now()}`);
const port = 3237;
const licensePort = 3238;
mkdirSync(dataDir, { recursive: true });
process.env.QUBIQ_ROOT_DIR = root;
process.env.QUBIQ_DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.REQUIRE_LAN = 'true';
process.env.LICENSE_SERVER_URL = `http://127.0.0.1:${licensePort}`;

let lastLicenseRequest = null;
const licenseServer = createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      lastLicenseRequest = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ valid: true, expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), message: '' }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((resolveListen) => licenseServer.listen(licensePort, '127.0.0.1', resolveListen));

const { startServer } = await import('../src/server.js');
const { createAttendanceToken } = await import('../src/security.js');
const { db } = await import('../src/db.js');
const base = `http://127.0.0.1:${port}`;
let cookie = '';
let server;

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
  return { response, body };
}
try {
  server = await startServer({ quiet: true });
  let result = await request('/api/status');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.setupRequired, true);
  assert.match(result.response.headers.get('content-security-policy') || '', /default-src 'self'/);

  result = await request('/api/setup', {
    method: 'POST',
    body: { businessName: 'Prueba', branchName: 'Central', adminName: 'Admin', password: 'sinNumerosAqui' }
  });
  assert.equal(result.response.status, 400);

  result = await request('/api/setup', {
    method: 'POST',
    body: {
      businessName: 'Negocio de Prueba', branchName: 'Sucursal Central', adminName: 'Administrador QA',
      adminEmail: 'qa@example.com', password: 'PruebaSegura2026',
      mail: { host: 'smtp.example.com', port: 587, secure: false, user: 'asistencia@example.com', pass: 'clave-app-1234', from: 'asistencia@example.com' }
    }
  });
  assert.equal(result.response.status, 200);
  cookie = (result.response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^qubiq_session=/);

  result = await request('/api/auth/me');
  assert.equal(result.response.status, 200);
  result = await request('/api/admin/settings');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.integrations.mail.configured, true);
  assert.equal(result.body.integrations.mail.user, 'asistencia@example.com');
  assert.equal('pass' in result.body.integrations.mail, false);
  result = await request('/api/admin/schedules', {
    method: 'POST', body: { name: 'Turno raro', startTime: '10:00', endTime: '10:00', toleranceMinutes: 5 }
  });
  assert.equal(result.response.status, 400);

  result = await request('/api/admin/schedules', {
    method: 'POST', body: { name: 'Diurno', startTime: '09:00', endTime: '17:00', toleranceMinutes: 5 }
  });
  assert.equal(result.response.status, 201);
  const scheduleId = Number(result.body.id);
  assert.ok(scheduleId > 0);

  result = await request(`/api/admin/schedules/${scheduleId}`, {
    method: 'PATCH', body: { name: 'Diurno', startTime: '08:30', endTime: '16:30', toleranceMinutes: 10 }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.schedule.start, '08:30');
  assert.equal(result.body.schedule.tolerance, 10);

  // Sin licencia activada, la creación de empleados y la generación de QR quedan bloqueadas.
  result = await request('/api/admin/employees', {
    method: 'POST',
    body: { employeeCode: 'EMP001', name: 'Persona Prueba', position: 'Asistente', nationalId: '123456789',
      phone: '88887777', email: 'persona@example.com', hireDate: '2026-09-15', pin: '1234', scheduleId }
  });
  assert.equal(result.response.status, 402);

  result = await request('/api/admin/qr.png');
  assert.equal(result.response.status, 402);

  result = await request('/api/admin/license/status');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.hasKey, false);
  assert.equal(result.body.blockCreateEmployee, true);
  assert.equal(result.body.blockQrGeneration, true);

  result = await request('/api/admin/license', { method: 'POST', body: { licenseKey: 'QBQ-TEST-TEST-TEST-TEST' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.license.valid, true);
  assert.ok(result.body.license.expiresAt);
  assert.equal(lastLicenseRequest?.licenseKey, 'QBQ-TEST-TEST-TEST-TEST');
  assert.ok(lastLicenseRequest?.machineId);

  result = await request('/api/admin/employees', {
    method: 'POST',
    body: { employeeCode: 'BAD CODE!', name: 'Persona Prueba', nationalId: '123456789',
      phone: '88887777', email: 'persona@example.com', pin: '1234', scheduleId }
  });
  assert.equal(result.response.status, 400);

  result = await request('/api/admin/employees', {
    method: 'POST',
    body: { employeeCode: 'EMP001', name: 'Persona Prueba', position: 'Asistente', nationalId: '123456789',
      phone: '88887777', email: 'persona@example.com', hireDate: '2026-09-15', pin: '1234', scheduleId }
  });
  assert.equal(result.response.status, 201);

  result = await request('/api/admin/qr.png');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type') || '', /image\/png/);

  const token = createAttendanceToken();
  result = await request('/api/attendance/mark', {
    method: 'POST', body: { token, employeeCode: 'EMP001', pin: '1234' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.eventType, 'ENTRY');
  result = await request('/api/attendance/mark', {
    method: 'POST', body: { token: createAttendanceToken(), employeeCode: 'EMP001', pin: '1234' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.eventType, 'EXIT');

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  result = await request(`/api/admin/payroll?from=${today}&to=${today}`);
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body) && result.body.length === 1);

  result = await request(`/api/admin/payroll.xlsx?from=${today}&to=${today}`);
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type') || '', /spreadsheetml\.sheet/);
  assert.match(result.response.headers.get('content-disposition') || '', /filename="Planilla .+\.xlsx"/);
  const workbookFiles = unzip(Buffer.from(result.body));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(workbookFiles.has(part), `Falta ${part} en el libro de Excel.`);
  }
  const workbookXml = workbookFiles.get('xl/workbook.xml').toString('utf8');
  assert.match(workbookXml, /<sheet name="Tarifas"/);
  assert.match(workbookXml, /<sheet name="1-Persona"/);
  const ratesXml = workbookFiles.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(ratesXml, /123456789/, 'La hoja Tarifas debe listar la cédula del empleado.');
  assert.match(ratesXml, /Salario por hora/);
  const voucherXml = workbookFiles.get('xl/worksheets/sheet2.xml').toString('utf8');
  assert.match(voucherXml, /COMPROBANTE DE PAGO-CONTROL DE HORAS LABORADAS/);
  assert.match(voucherXml, /VLOOKUP\(&quot;123456789&quot;,Tarifas!\$A\$5/, 'El comprobante debe buscar la tarifa por cédula.');
  assert.match(voucherXml, /TOTAL POR QUINCENA/);
  assert.match(voucherXml, /Monto a Pagar/);
  assert.equal(/FARMACOVA/i.test(voucherXml), false);

  result = await request(`/api/admin/payroll.xlsx?from=${today}&to=2020-01-01`);
  assert.equal(result.response.status, 400);

  result = await request('/api/admin/company', { method: 'PATCH', body: { businessName: 'X' } });
  assert.equal(result.response.status, 400);

  result = await request('/api/admin/company', { method: 'PATCH', body: { businessName: 'Negocio Actualizado' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.company.businessName, 'Negocio Actualizado');
  assert.equal(Object.hasOwn(result.body.company, 'primaryColor'), false);

  result = await request('/api/branding');
  assert.equal(result.response.status, 200);
  assert.equal(Object.hasOwn(result.body, 'adminEmail'), false);
  assert.equal(Object.hasOwn(result.body, 'adminName'), false);
  assert.equal(Object.hasOwn(result.body, 'primaryColor'), false);
  assert.equal(Object.hasOwn(result.body, 'logoData'), false);

  result = await request('/api/admin/mail', { method: 'PATCH', body: { host: 'bad host!', port: 587 } });
  assert.equal(result.response.status, 400);

  result = await request('/api/admin/backup', { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);

  // Acceso de Recepción: solo puede ver el QR, nada más.
  result = await request('/api/admin/kiosk', { method: 'POST', body: { password: 'abc' } });
  assert.equal(result.response.status, 400);

  result = await request('/api/admin/kiosk', { method: 'POST', body: { password: 'recepcion123' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.kioskEnabled, true);

  result = await request('/api/status');
  assert.equal(result.body.kioskEnabled, true);

  const adminCookie = cookie;
  result = await request('/api/auth/login', { method: 'POST', body: { password: 'recepcion123', role: 'kiosk' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.role, 'kiosk');
  cookie = (result.response.headers.get('set-cookie') || '').split(';')[0];

  result = await request('/api/auth/me');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.role, 'kiosk');

  result = await request('/api/admin/qr.png');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type') || '', /image\/png/);

  result = await request('/api/admin/employees');
  assert.equal(result.response.status, 401);
  result = await request('/api/admin/settings');
  assert.equal(result.response.status, 401);
  result = await request('/api/admin/kiosk/disable', { method: 'POST' });
  assert.equal(result.response.status, 401);

  result = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(result.response.status, 200);
  cookie = adminCookie;

  result = await request('/api/auth/me');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.role, 'admin');

  result = await request('/api/admin/kiosk/disable', { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.kioskEnabled, false);

  result = await request('/api/status');
  assert.equal(result.body.kioskEnabled, false);

  const integrity = db.prepare('PRAGMA integrity_check').get();
  assert.equal(integrity.integrity_check, 'ok');
  result = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(result.response.status, 200);
  result = await request('/api/auth/me');
  assert.equal(result.response.status, 401);

  console.log('SMOKE_TEST_OK');
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await new Promise((resolveClose) => licenseServer.close(resolveClose));
  try { db.close(); } catch { /* proceso finaliza igualmente */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* limpieza no crítica */ }
}
