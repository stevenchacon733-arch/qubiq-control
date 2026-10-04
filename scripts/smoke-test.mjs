import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
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

  // El panel solo responde a esta misma computadora. Un pedido que llegó por un túnel o un proxy (cabeceras de
  // reenvío, o dirigido a otro nombre) no entra, se escriba la ruta como se escriba; la página del QR sí.
  const forwarded = { 'X-Forwarded-For': '203.0.113.9' };
  for (const path of ['/api/status', '/API/status', '/api/Admin/employees', '/api/AUTH/login', '/admin.html', '/admin', '/Admin.html',
    '/%61dmin.html', '/admin%2ejs', '//admin.html', '/setup', '/kiosk.html']) {
    const blocked = await fetch(base + path, { headers: forwarded });
    assert.equal(blocked.status, 403, `${path} no debe responder a un pedido reenviado (respondió ${blocked.status}).`);
  }
  const statusWithHost = (path, host) => new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', fail);
    req.end();
  });
  assert.equal(await statusWithHost('/admin.html', 'qubiq.ejemplo.com'), 403);
  assert.equal(await statusWithHost('/api/status', '203.0.113.7:3220'), 403);
  assert.equal(await statusWithHost('/api/status', `localhost:${port}`), 200);
  assert.equal((await fetch(`${base}/mark.html`, { headers: forwarded })).status, 200);
  assert.equal((await fetch(`${base}/app.css`, { headers: forwarded })).status, 200);
  assert.equal(await statusWithHost('/api/branding', '192.168.1.10:3220'), 200);

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

  // Marcar en la app no puede ser una forma de saltarse la licencia.
  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'EMP001', pin: '1234' } });
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
      phone: '88887777', email: 'persona@example.com', hireDate: '2026-09-15', hourlyRate: 3500, pin: '1234', scheduleId }
  });
  assert.equal(result.response.status, 201);
  const employeeId = Number(result.body.id);

  result = await request('/api/admin/employees');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.find(item => item.employee_code === 'EMP001')?.hourly_rate, 3500);

  result = await request(`/api/admin/employees/${employeeId}`, { method: 'PATCH', body: { hourlyRate: -5 } });
  assert.equal(result.response.status, 400);

  result = await request(`/api/admin/employees/${employeeId}`, { method: 'PATCH', body: { hourlyRate: 4200.5 } });
  assert.equal(result.response.status, 200);
  result = await request('/api/admin/employees');
  const patched = result.body.find(item => item.employee_code === 'EMP001');
  assert.equal(patched?.hourly_rate, 4200.5);
  assert.equal(patched?.schedule_id, scheduleId, 'Un PATCH parcial no debe borrar el horario del empleado.');

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
  assert.match(ratesXml, /<c r="E5"[^>]*><v>4200\.5<\/v><\/c>/, 'La hoja Tarifas debe traer el salario por hora guardado en la ficha.');
  const voucherXml = workbookFiles.get('xl/worksheets/sheet2.xml').toString('utf8');
  assert.match(voucherXml, /COMPROBANTE DE PAGO-CONTROL DE HORAS LABORADAS/);
  assert.match(voucherXml, /VLOOKUP\(&quot;123456789&quot;,Tarifas!\$A\$5/, 'El comprobante debe buscar la tarifa por cédula.');
  assert.match(voucherXml, /TOTAL POR QUINCENA/);
  assert.match(voucherXml, /Monto a Pagar/);
  assert.equal(/FARMACOVA/i.test(voucherXml), false);

  result = await request(`/api/admin/payroll.xlsx?from=${today}&to=2020-01-01`);
  assert.equal(result.response.status, 400);

  // Marcar en la computadora del negocio, sin celular ni QR.
  const qrSources = db.prepare(`SELECT DISTINCT a.source FROM attendance a JOIN employees e ON e.id = a.employee_id
                                WHERE e.employee_code = 'EMP001'`).all().map(row => row.source);
  assert.deepEqual(qrSources, ['QR'], 'Las marcas hechas con el QR deben quedar registradas como QR.');

  result = await request('/api/admin/employees', {
    method: 'POST',
    body: { employeeCode: 'EMP002', name: 'Otra Persona', position: 'Cajero', nationalId: '987654321',
      email: 'otra@example.com', pin: '5678', scheduleId }
  });
  assert.equal(result.response.status, 201);

  const savedCookie = cookie;
  cookie = '';
  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'EMP002', pin: '5678' } });
  assert.equal(result.response.status, 401, 'Sin sesión en la computadora no se puede marcar en la app.');
  cookie = savedCookie;

  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'EMP002', pin: '0000' } });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /Código o PIN incorrecto\. Quedan \d+ intentos\./, 'Un PIN malo en la app debe contar para el bloqueo igual que en el QR.');

  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'emp002', pin: '5678' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.eventType, 'ENTRY');
  assert.equal(result.body.employee, 'Otra Persona');
  assert.match(result.body.time, /^\d{2}:\d{2}$/);
  assert.equal('notificationEmail' in result.body, false, 'No se debe devolver el correo del empleado.');

  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'EMP002', pin: '5678' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.eventType, 'EXIT');

  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'EMP002', pin: '5678' } });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /ya fue cerrada/);

  const appRows = db.prepare(`SELECT a.source, a.qr_nonce FROM attendance a JOIN employees e ON e.id = a.employee_id
                              WHERE e.employee_code = 'EMP002' ORDER BY a.id`).all();
  assert.equal(appRows.length, 2);
  assert.ok(appRows.every(row => row.source === 'APP' && row.qr_nonce === null), 'Las marcas de la app deben quedar como APP.');
  const appAudit = db.prepare(`SELECT details_json FROM audit_log WHERE actor = 'EMPLOYEE:EMP002' AND action = 'MARK'`).all();
  assert.equal(appAudit.length, 2);
  assert.ok(appAudit.every(row => JSON.parse(row.details_json).source === 'APP'));

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

  // Recepción también puede marcar en la computadora (llega a validar el PIN: no es un 401).
  result = await request('/api/admin/attendance/mark', { method: 'POST', body: { employeeCode: 'NOEXISTE', pin: '1111' } });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /Código o PIN incorrecto/);

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

  // ----- Sucursales -----
  result = await request('/api/admin/branches');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.length, 1, 'La sucursal que ya existía pasa a ser la primera.');
  assert.equal(result.body[0].name, 'Sucursal Central');
  assert.equal(result.body[0].code, 'SUC');
  const firstBranchId = result.body[0].id;
  result = await request('/api/admin/branches', { method: 'POST', body: { name: 'Aguas Zarcas' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.code, 'AGZ');
  result = await request('/api/admin/branches', { method: 'POST', body: { name: 'Venecia' } });
  assert.equal(result.body.code, 'VEN');
  const veneciaId = result.body.id;
  result = await request('/api/admin/branches', { method: 'POST', body: { name: 'Venado', code: 'ven' } });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /código/);
  result = await request('/api/admin/branches', { method: 'POST', body: { name: 'venecia' } });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /nombre/);
  result = await request('/api/admin/branches', { method: 'POST', body: { name: 'Vendaval' } });
  assert.equal(result.body.code, 'VEN2', 'Un código repetido se resuelve solo.');
  result = await request('/api/admin/branches', { method: 'POST', body: { name: 'Otra', code: 'A B' } });
  assert.equal(result.response.status, 400);
  result = await request(`/api/admin/branches/${veneciaId}`, { method: 'PATCH', body: { name: 'Venecia Centro' } });
  assert.equal(result.body.name, 'Venecia Centro');
  assert.equal(result.body.code, 'VEN', 'Cambiar el nombre no cambia el código.');
  result = await request(`/api/admin/branches/${veneciaId}/active`, { method: 'PATCH', body: { active: false } });
  assert.equal(result.body.active, false);
  result = await request('/api/admin/branches');
  assert.equal(result.body.length, 4);
  for (const branch of result.body.filter((item) => item.active && item.id !== firstBranchId)) {
    await request(`/api/admin/branches/${branch.id}/active`, { method: 'PATCH', body: { active: false } });
  }
  result = await request(`/api/admin/branches/${firstBranchId}/active`, { method: 'PATCH', body: { active: false } });
  assert.equal(result.response.status, 400, 'No se puede quedar sin sucursales activas.');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM branches').get().n, 4, 'Las sucursales no se borran.');

  // ----- Horas: una sola regla de redondeo, igual a la del libro de Excel -----
  const { countedHours } = await import('../src/services/attendance.js');
  for (const [entry, exit, hours] of [['08:20', '17:40', 10], ['08:29', '17:29', 9], ['08:30', '17:30', 9],
    ['23:40', '07:10', 7], ['08:10', '08:20', 0], ['14:00', '21:00', 7], ['22:00', '06:00', 8]]) {
    assert.equal(countedHours(entry, exit), hours, `${entry} a ${exit}`);
  }

  // ----- Corrección manual de una jornada -----
  result = await request('/api/admin/employees', {
    method: 'POST',
    body: { employeeCode: 'EMP777', name: 'Persona Corregida', nationalId: '777000777', email: 'corregida@example.com', pin: '4321', scheduleId }
  });
  assert.equal(result.response.status, 201);
  const fixId = Number(result.body.id);
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const fix = (body) => request('/api/admin/attendance/day', { method: 'PUT', body: { employeeId: fixId, workDate: yesterday, ...body } });
  const dayRow = async () => (await request(`/api/admin/payroll?from=${yesterday}&to=${yesterday}`)).body.find((row) => row.codigo === 'EMP777');

  result = await fix({ entry: '08:20', exit: '17:40' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.entrada, '08:20');
  assert.equal(result.body.salida, '17:40');
  let fixedRow = await dayRow();
  assert.equal(fixedRow.horasTrabajadas, 10, 'Entrada 8 y salida 18: 10 horas, como en el Excel.');
  assert.equal(fixedRow.horasOrdinarias, 8);
  assert.equal(fixedRow.horasExtra, 2);
  assert.equal(fixedRow.tardanzaMin, 0);
  result = await request(`/api/admin/overview?date=${yesterday}`);
  const fixedOverview = result.body.rows.find((row) => row.employee_code === 'EMP777');
  assert.equal(fixedOverview.workedMinutes, 600);
  assert.equal(fixedOverview.extraMinutes, 120);
  assert.equal(fixedOverview.workDate, yesterday);

  // El comprobante de Excel muestra las mismas horas redondeadas que usa la app.
  result = await request(`/api/admin/payroll.xlsx?from=${yesterday}&to=${yesterday}`);
  assert.equal(result.response.status, 200);
  const fixedBook = unzip(Buffer.from(result.body));
  const fixedSheets = [...fixedBook.keys()].filter((name) => name.startsWith('xl/worksheets/')).map((name) => fixedBook.get(name).toString('utf8'));
  const fixedVoucher = fixedSheets.find((xml) => xml.includes('777000777') && xml.includes('COMPROBANTE DE PAGO'));
  assert.ok(fixedVoucher, 'El empleado corregido debe tener su comprobante.');
  assert.match(fixedVoucher, /<c r="B\d+"[^>]*><v>8<\/v><\/c><c r="C\d+"[^>]*><v>18<\/v><\/c>/, 'El Excel recibe entrada 8 y salida 18.');

  result = await fix({ entry: '09:15', exit: '17:40' });
  fixedRow = await dayRow();
  assert.equal(fixedRow.estadoEntrada, 'LATE');
  assert.equal(fixedRow.tardanzaMin, 35, 'La tardanza se recalcula con el horario (08:30 + 10 min de tolerancia).');
  assert.equal(fixedRow.horasTrabajadas, 9);

  result = await fix({ entry: '09:15', exit: '' });
  fixedRow = await dayRow();
  assert.equal(fixedRow.salida, '');
  assert.equal(fixedRow.horasTrabajadas, '');

  result = await fix({ entry: '22:00', exit: '06:00' });
  assert.equal(result.response.status, 200);
  fixedRow = await dayRow();
  assert.equal(fixedRow.horasTrabajadas, 8, 'Una salida más temprana que la entrada es del día siguiente.');
  const overnight = db.prepare("SELECT occurred_at FROM attendance WHERE employee_id = ? AND work_date = ? ORDER BY occurred_at").all(fixId, yesterday);
  assert.equal(Date.parse(overnight[1].occurred_at) - Date.parse(overnight[0].occurred_at), 8 * 60 * 60 * 1000);

  for (const bad of [{ entry: '', exit: '17:00' }, { entry: '08:00', exit: '08:00' }, { entry: '25:00', exit: '' }, { entry: '8', exit: '' }]) {
    result = await fix(bad);
    assert.equal(result.response.status, 400, JSON.stringify(bad));
  }
  result = await request('/api/admin/attendance/day', { method: 'PUT', body: { employeeId: fixId, workDate: '2999-01-01', entry: '08:00' } });
  assert.equal(result.response.status, 400);
  result = await request('/api/admin/attendance/day', { method: 'PUT', body: { employeeId: 999999, workDate: yesterday, entry: '08:00' } });
  assert.equal(result.response.status, 400);
  fixedRow = await dayRow();
  assert.equal(fixedRow.entrada, '22:00', 'Un intento inválido no cambia nada.');

  result = await fix({ entry: '', exit: '' });
  assert.equal(result.response.status, 200);
  assert.equal(await dayRow(), undefined, 'Borrar las dos marcas deja el día vacío.');
  const corrections = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'CORRECT' AND entity_type = 'ATTENDANCE'").get().n;
  assert.equal(corrections, 5, 'Cada corrección queda en la bitácora.');

  // ----- Cada marcación guarda su sucursal (las del QR y la computadora, la de esta instalación) -----
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE branch_id IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT branch_id) AS n FROM attendance').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE branch_id = ?').get(firstBranchId).n > 0, true);
  result = await request(`/api/admin/payroll.csv?from=${today}&to=${today}`);
  assert.match(Buffer.from(result.body).toString('utf8'), /"Sucursal entrada","Sucursal salida"/);
  result = await request(`/api/admin/overview?date=${today}&branchId=${firstBranchId}`);
  assert.equal(result.response.status, 200);
  assert.ok(result.body.rows.length > 0);
  assert.ok(result.body.branches.length >= 1);

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
