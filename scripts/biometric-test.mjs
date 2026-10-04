// Pruebas del lector de huella contra un terminal ZKTeco simulado (scripts/fake-zk-device.mjs).
// Cubre conexión, caída, timeout, vínculos, duplicados, reconexión, datos inválidos, licencia y reinicios.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeZkDevice } from './fake-zk-device.mjs';

const self = fileURLToPath(import.meta.url);
const root = resolve(self, '..', '..');
const restartMode = process.argv[2] === '--after-restart';
const migrationMode = process.argv[2] === '--migration';
const dataDir = restartMode || migrationMode ? process.argv[3] : resolve(root, `.smoke-bio-${Date.now()}`);
const port = 3247;
const licensePort = 3248;
mkdirSync(dataDir, { recursive: true });
process.env.QUBIQ_ROOT_DIR = root;
process.env.QUBIQ_DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.LICENSE_SERVER_URL = `http://127.0.0.1:${licensePort}`;

const TZ = 'America/Costa_Rica';
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function localParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}
const ago = (minutes) => localParts(new Date(Date.now() - minutes * 60000));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Tiempo agotado esperando: ${label}`);
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
await new Promise((done) => licenseServer.listen(licensePort, '127.0.0.1', done));

const { db } = await import('../src/db.js');
const bio = await import('../src/services/biometric/index.js');
const branches = await import('../src/services/branches.js');
const attendance = await import('../src/services/attendance.js');
const license = await import('../src/services/license.js');
const { zktecoDriver } = await import('../src/services/biometric/zktecoDriver.js');

const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const attendanceOf = (employeeId) => db.prepare('SELECT event_type, source, status, local_time, work_date FROM attendance WHERE employee_id = ? ORDER BY occurred_at').all(employeeId);
const fake = new FakeZkDevice();
let server = null;
let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

try {
  if (restartMode) {
    // ----- Proceso nuevo sobre los mismos datos: equivale a reiniciar Windows y que Qubiq arranque solo -----
    const state = JSON.parse(readFileSync(resolve(dataDir, 'restart-state.json'), 'utf8'));
    for (const record of state.records) fake.punch(record.userId, record.time);
    fake.users = state.users;
    await fake.start(state.port);
    const before = count('SELECT COUNT(*) AS n FROM attendance');
    const eventsBefore = count('SELECT COUNT(*) AS n FROM biometric_events');
    assert.equal(bio.listDevices().length, 3, 'Los lectores configurados deben sobrevivir al reinicio.');
    assert.equal(bio.listDevices()[0].branchCode, 'AGZ');
    bio.startBiometricWorker();
    await until(() => bio.listDevices()[0].status === 'CONNECTED' && Boolean(bio.listDevices()[0].lastSyncAt
      && Date.parse(bio.listDevices()[0].lastSyncAt) > state.stoppedAt), 'sincronización automática tras el reinicio');
    assert.equal(count('SELECT COUNT(*) AS n FROM attendance'), before, 'El reinicio no debe duplicar asistencia.');
    assert.equal(count('SELECT COUNT(*) AS n FROM biometric_events'), eventsBefore, 'El reinicio no debe duplicar eventos.');
    bio.stopBiometricWorker();
    console.log('BIOMETRIC_RESTART_OK');
  } else if (migrationMode) {
    // ----- Base de datos de una versión anterior: el lector que ya existía queda en la sucursal que ya había -----
    const migrated = bio.listDevices();
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].name, 'Lector Antiguo');
    assert.equal(migrated[0].branchName, 'Sucursal Vieja');
    assert.equal(migrated[0].branchCode, 'SUV');
    assert.equal(migrated[0].serialNumber, 'OLD123', 'El número de serie ya conocido pasa a ser su identidad.');
    assert.equal(branches.listBranches().length, 1);
    console.log('BIOMETRIC_MIGRATION_OK');
  } else {
    await license.saveLicenseKey('QBQ-TEST-TEST-TEST-TEST');
    assert.equal(license.licenseStatus().valid, true);

    const scheduleId = attendance.createSchedule({ name: 'Turno prueba', startTime: '09:00', endTime: '17:00', toleranceMinutes: 5 });
    const person = (code, name, nationalId) => attendance.createEmployee({ employeeCode: code, name, nationalId,
      email: `${code.toLowerCase()}@example.com`, pin: '1234', scheduleId });
    const agz = branches.createBranch({ name: 'Aguas Zarcas' });
    const ven = branches.createBranch({ name: 'Venecia' });
    assert.equal(agz.code, 'AGZ');
    const ana = person('EMP001', 'Ana Prueba', '101110111');
    const beto = person('EMP002', 'Beto Prueba', '202220222');
    const caro = person('EMP003', 'Carolina Ñandú', '303330333');

    const devicePort = await fake.start(0);

    // ----- Configuración y seguridad -----
    assert.throws(() => bio.createDevice({ name: 'Internet', ip: '8.8.8.8', port: 4370 }), /red local/);
    assert.throws(() => bio.createDevice({ name: 'Malo', ip: '192.168.1.999', port: 4370 }), /red local/);
    assert.throws(() => bio.createDevice({ name: 'Puerto', ip: '192.168.1.202', port: 70000 }), /puerto/i);
    assert.throws(() => bio.createDevice({ name: 'Clave', ip: '192.168.1.202', port: 4370, commKey: 'abc' }), /numérica/);
    assert.throws(() => bio.createDevice({ name: 'Sin sucursal', ip: '192.168.1.50', port: 4370, branchId: 9999 }), /sucursal elegida no existe/);
    const device = bio.createDevice({ name: 'Lector Principal', ip: '127.0.0.1', port: devicePort, commKey: '54321', location: 'Entrada', branchId: agz.id });
    assert.equal(device.branchCode, 'AGZ');
    assert.equal(device.branchName, 'Aguas Zarcas');
    assert.equal(device.serialNumber, '', 'El número de serie se toma del propio lector la primera vez que responde.');
    assert.equal(device.hasCommKey, true);
    assert.equal(JSON.stringify(device).includes('54321'), false, 'La clave nunca se devuelve.');
    const stored = db.prepare('SELECT comm_key_sealed FROM biometric_devices WHERE id = ?').get(device.id).comm_key_sealed;
    assert.equal(stored.includes('54321'), false, 'La clave no se guarda en texto plano.');
    assert.throws(() => bio.createDevice({ name: 'Otro', ip: '127.0.0.1', port: devicePort }), /IP y puerto/);
    // Las pruebas usan marcaciones de las últimas horas: se adelanta la fecha de activación.
    db.prepare('UPDATE biometric_devices SET import_since = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86400000).toISOString(), device.id);
    ok('configuración validada, IP solo de red local y clave cifrada');

    // ----- Clave de comunicación -----
    fake.commKey = 99999;
    let test = await bio.testConnection(device.id);
    assert.equal(test.ok, false);
    assert.match(test.error, /clave de comunicación/);
    fake.commKey = 54321;
    test = await bio.testConnection(device.id);
    assert.equal(test.ok, true, test.error);
    assert.equal(bio.listDevices()[0].status, 'CONNECTED');
    assert.equal(bio.listDevices()[0].serialNumber, 'SIM0001');
    ok('conexión correcta con clave de comunicación; clave incorrecta rechazada');

    // ----- Dispositivo desconectado -----
    await fake.stop();
    test = await bio.testConnection(device.id);
    assert.equal(test.ok, false);
    assert.equal(bio.listDevices()[0].status, 'DISCONNECTED');
    assert.equal(bio.listDevices()[0].consecutiveFailures, 1);
    assert.ok(bio.listDevices()[0].lastError.length > 0);
    ok('dispositivo desconectado: Qubiq no falla y guarda el último error');

    // ----- Timeout -----
    await fake.start(devicePort);
    fake.silent = true;
    const started = Date.now();
    await assert.rejects(zktecoDriver.testConnection({ ip: '127.0.0.1', port: devicePort, commKey: '54321', timeoutMs: 400 }), /no respondió a tiempo/);
    assert.ok(Date.now() - started < 3000, 'El timeout debe cortar rápido.');
    fake.silent = false;
    ok('timeout: un lector que no responde no cuelga la aplicación');

    // ----- Licencia: misma regla que el QR -----
    licenseValid = false;
    await license.checkLicense();
    fake.punch('1', ago(180));
    await assert.rejects(bio.syncDevice(device.id, { manual: true }), /vencida|licencia/i);
    assert.equal(count('SELECT COUNT(*) AS n FROM biometric_events'), 0);
    licenseValid = true;
    await license.checkLicense();
    ok('licencia vencida: no se registran marcaciones (quedan guardadas en el lector)');

    // ----- ID no vinculado -----
    let sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.imported, 1);
    assert.equal(sync.unmapped, 1);
    assert.equal(count('SELECT COUNT(*) AS n FROM attendance'), 0);
    ok('ID del lector no vinculado: se guarda el evento, no se crea asistencia');

    // ----- Vínculos únicos -----
    assert.throws(() => bio.setMapping({ employeeId: ana, deviceId: device.id, zkUserId: 'abc' }), /número/);
    assert.throws(() => bio.setMapping({ employeeId: 9999, deviceId: device.id, zkUserId: '5' }), /no encontrado/);
    let link = bio.setMapping({ employeeId: ana, deviceId: device.id, zkUserId: '1' });
    assert.equal(link.reprocessed, 1);
    assert.throws(() => bio.setMapping({ employeeId: beto, deviceId: device.id, zkUserId: '1' }), /ya está asignado a Ana Prueba/);
    assert.throws(() => db.prepare('INSERT INTO employee_biometric_map(employee_id, device_id, zk_user_id, created_at) VALUES(?, ?, ?, ?)')
      .run(beto, device.id, '1', new Date().toISOString()), /UNIQUE/);
    ok('vínculo único por lector (validación en código y en base de datos)');

    // ----- Empleado existente: la marcación pendiente entra al motor de asistencia -----
    let rows = attendanceOf(ana);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'ENTRY');
    assert.equal(rows[0].source, 'BIO');
    assert.ok(['ON_TIME', 'LATE'].includes(rows[0].status));
    ok('empleado existente: la huella genera la ENTRADA con las reglas de horario');

    // ----- Marcación duplicada y sincronizaciones consecutivas -----
    for (let i = 0; i < 3; i += 1) {
      sync = await bio.syncDevice(device.id, { manual: true, full: true });
      assert.equal(sync.imported, 0);
      assert.equal(sync.duplicates, 1);
    }
    assert.equal(attendanceOf(ana).length, 1, 'Descargar la misma marcación varias veces crea exactamente un registro.');
    assert.equal(count('SELECT COUNT(*) AS n FROM biometric_events'), 1);
    assert.throws(() => db.prepare(`INSERT INTO biometric_events(device_id, zk_user_id, punched_local, verify_status, punch_state, status, received_at)
      SELECT device_id, zk_user_id, punched_local, verify_status, punch_state, 'INVALID', received_at FROM biometric_events LIMIT 1`).run(), /UNIQUE/);
    ok('marcación duplicada: exactamente un registro (restricción en base de datos)');

    // ----- Doble toque del dedo -----
    const first = ago(180);
    fake.punch('1', localParts(new Date(Date.now() - 180 * 60000 + 20000)));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.imported, 1);
    assert.equal(attendanceOf(ana).length, 1, 'Un segundo toque a los pocos segundos no debe cerrar la jornada.');
    assert.equal(db.prepare("SELECT status FROM biometric_events ORDER BY id DESC LIMIT 1").get().status, 'IGNORED');
    ok('doble toque en segundos: se ignora y se conserva la entrada');

    // ----- Marcación nueva: salida -----
    fake.punch('1', ago(30));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.applied, 1);
    rows = attendanceOf(ana);
    assert.deepEqual(rows.map((row) => row.event_type), ['ENTRY', 'EXIT']);
    const payroll = attendance.payrollRows(rows[0].work_date, rows[0].work_date);
    assert.equal(payroll.length, 1);
    assert.ok(payroll[0].entrada && payroll[0].salida);
    assert.equal(payroll[0].horasTrabajadas, attendance.countedHours(payroll[0].entrada, payroll[0].salida),
      'Las horas salen de redondear entrada y salida a la hora, igual que el libro de Excel.');
    assert.ok(payroll[0].horasTrabajadas === 2 || payroll[0].horasTrabajadas === 3);
    ok('marcación nueva: SALIDA y horas trabajadas en la pre-planilla');

    // ----- Jornada cerrada -----
    fake.punch('1', ago(10));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.rejected, 1);
    assert.equal(attendanceOf(ana).length, 2);
    ok('jornada ya cerrada: la regla existente rechaza una tercera marcación');

    // ----- Horas extra: lo trabajado después del horario se cuenta y se separa -----
    const fabio = person('EMP009', 'Fabio Prueba', '909990999');
    bio.setMapping({ employeeId: fabio, deviceId: device.id, zkUserId: '9' });
    fake.punch('9', ago(640));
    fake.punch('9', ago(10));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.applied, 2);
    const longDay = attendanceOf(fabio)[0].work_date;
    const extraRow = attendance.payrollRows(longDay, longDay).find((row) => row.codigo === 'EMP009');
    const longHours = attendance.countedHours(extraRow.entrada, extraRow.salida);
    assert.ok(longHours === 10 || longHours === 11, 'Unas 10 h 30 min se cuentan completas, sin tope por horario.');
    assert.equal(extraRow.horasTrabajadas, longHours);
    assert.equal(extraRow.horasOrdinarias, 8, 'La jornada del horario (09:00 a 17:00) son 8 h ordinarias.');
    assert.equal(extraRow.horasExtra, longHours - 8);
    const overview = attendance.dailyOverview(longDay).rows.find((row) => row.employee_code === 'EMP009');
    assert.equal(overview.workedMinutes, longHours * 60);
    assert.equal(overview.extraMinutes, (longHours - 8) * 60);
    assert.equal(overview.workDate, longDay);
    const { rowValues } = await import('../src/services/googleSheets.js');
    assert.deepEqual(rowValues(null, 1, extraRow).slice(2), [longHours, 8, longHours - 8, 0], 'Google Sheets: laboradas, ordinarias, extras, dobles.');
    const shortHours = payroll[0].horasTrabajadas;
    assert.deepEqual(rowValues(null, 1, { ...payroll[0] }).slice(2), [shortHours, shortHours, 0, 0], 'Una jornada corta no genera extras.');
    ok('horas extra: se cuenta todo lo trabajado y se separa ordinario de extra');

    // ----- Olvido de salida: la marca del día siguiente abre una jornada nueva -----
    const gil = person('EMP011', 'Gil Prueba', '111101111');
    bio.setMapping({ employeeId: gil, deviceId: device.id, zkUserId: '11' });
    fake.punch('11', ago(30 * 60));
    fake.punch('11', ago(6));
    fake.punch('11', ago(1));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.applied, 3, 'Ninguna marca queda rechazada ni bloquea al empleado.');
    let gilRows = attendanceOf(gil);
    assert.deepEqual(gilRows.map((row) => row.event_type), ['ENTRY', 'ENTRY', 'EXIT']);
    assert.notEqual(gilRows[0].work_date, gilRows[1].work_date, 'La marca de 30 horas después no cierra la jornada vieja.');
    assert.equal(gilRows[2].work_date, gilRows[1].work_date);
    const forgotten = attendance.payrollRows(gilRows[0].work_date, gilRows[0].work_date).find((row) => row.codigo === 'EMP011');
    assert.equal(forgotten.salida, '');
    assert.equal(forgotten.horasTrabajadas, '', 'Una jornada sin salida no suma horas.');
    // El administrador la corrige a mano.
    const entryClock = gilRows[0].local_time.slice(0, 5);
    const exitClock = `${String((Number(entryClock.slice(0, 2)) + 8) % 24).padStart(2, '0')}:${entryClock.slice(3)}`;
    const fixed = attendance.correctAttendanceDay({ employeeId: gil, workDate: gilRows[0].work_date, entry: entryClock, exit: exitClock });
    assert.equal(fixed.salida, exitClock);
    const repaired = attendance.payrollRows(gilRows[0].work_date, gilRows[0].work_date).find((row) => row.codigo === 'EMP011');
    assert.equal(repaired.horasTrabajadas, 8);
    gilRows = attendanceOf(gil);
    assert.equal(gilRows.find((row) => row.event_type === 'EXIT' && row.work_date === fixed.workDate).source, 'ADMIN');
    assert.equal(gilRows.find((row) => row.event_type === 'ENTRY' && row.work_date === fixed.workDate).source, 'BIO', 'La entrada que no se tocó conserva su origen.');
    // Borrar una marca que vino del lector no hace que el lector la vuelva a meter.
    attendance.correctAttendanceDay({ employeeId: gil, workDate: fixed.workDate, entry: '', exit: '' });
    sync = await bio.syncDevice(device.id, { manual: true, full: true });
    assert.equal(sync.imported, 0);
    assert.equal(attendanceOf(gil).filter((row) => row.work_date === fixed.workDate).length, 0);
    ok('olvido de salida: jornada nueva al día siguiente, la anterior queda sin salida y se corrige a mano');

    // ----- Fecha inválida y fecha futura -----
    fake.punch('1', { year: 2026, month: 2, day: 31, hour: 8, minute: 0, second: 0 });
    fake.punch('1', localParts(new Date(Date.now() + 3 * 3600000)));
    fake.records.push({ userId: 'x\u0001y', time: ago(5), status: 1, punch: 0 });
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.invalid, 3);
    assert.equal(attendanceOf(ana).length, 2);
    sync = await bio.syncDevice(device.id, { manual: true, full: true });
    assert.equal(sync.imported, 0, 'Los eventos inválidos tampoco se duplican.');
    ok('fecha inválida, fecha futura e ID corrupto: se registran como inválidos sin afectar asistencia');

    // ----- Empleado inactivo y empleado eliminado -----
    bio.setMapping({ employeeId: beto, deviceId: device.id, zkUserId: '2' });
    attendance.setEmployeeActive(beto, false);
    fake.punch('2', ago(120));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.rejected, 1);
    assert.equal(attendanceOf(beto).length, 0);
    attendance.setEmployeeActive(beto, true);
    attendance.archiveEmployee(beto);
    assert.equal(count('SELECT COUNT(*) AS n FROM employee_biometric_map WHERE employee_id = ?', beto), 0);
    fake.punch('2', ago(60));
    sync = await bio.syncDevice(device.id, { manual: true });
    assert.equal(sync.unmapped, 1);
    ok('empleado inactivo o eliminado: no genera asistencia y libera su ID');

    // ----- Reconexión después de una caída -----
    await fake.stop();
    sync = await bio.syncDevice(device.id);
    assert.equal(sync.ok, false);
    sync = await bio.syncDevice(device.id);
    assert.equal(bio.listDevices()[0].consecutiveFailures, 2);
    assert.equal(bio.listDevices()[0].status, 'DISCONNECTED');
    bio.setMapping({ employeeId: caro, deviceId: device.id, zkUserId: '3' });
    fake.punch('3', ago(100));
    fake.punch('3', ago(20));
    await fake.start(devicePort);
    sync = await bio.syncDevice(device.id);
    assert.equal(sync.ok, true);
    assert.equal(sync.applied, 2);
    assert.deepEqual(attendanceOf(caro).map((row) => row.event_type), ['ENTRY', 'EXIT']);
    assert.equal(bio.listDevices()[0].consecutiveFailures, 0);
    const logs = bio.listLogs({ deviceId: device.id });
    assert.equal(logs[0].action, 'Reconexión');
    assert.equal(logs[0].imported, 2);
    ok('reconexión: descarga lo pendiente, sin duplicar, y queda en el registro');

    // ----- Respuesta en un solo paquete (otros firmwares) -----
    fake.inlineSmall = true;
    fake.records = fake.records.slice(-2);
    db.prepare('UPDATE biometric_devices SET last_record_count = NULL WHERE id = ?').run(device.id);
    sync = await bio.syncDevice(device.id, { manual: true, full: true });
    assert.equal(sync.received, 2);
    assert.equal(sync.imported, 0);
    fake.inlineSmall = false;
    ok('lectura compatible con respuesta directa y por bloques');

    // ----- Diagnóstico -----
    fake.clockParts = () => localParts(new Date());
    const diag = await bio.diagnostics(device.id);
    assert.equal(diag.online, true);
    assert.equal(diag.serial, 'SIM0001');
    assert.equal(diag.firmware, 'Ver 6.60 Sim');
    assert.ok(Math.abs(diag.clockDriftSeconds) < 5);
    assert.equal(diag.pendingEvents, 0);
    assert.equal(typeof diag.latencyMs, 'number');
    ok('diagnóstico: modelo, firmware, latencia, reloj y pendientes');

    // ----- El lector se reconoce por su número de serie, no por la IP -----
    const eventsBeforeSwap = count('SELECT COUNT(*) AS n FROM biometric_events');
    fake.serial = 'OTRO999';
    fake.punch('1', ago(2));
    await assert.rejects(bio.syncDevice(device.id, { manual: true, full: true }), /responde otro aparato \(serie OTRO999\)/);
    assert.equal(count('SELECT COUNT(*) AS n FROM biometric_events'), eventsBeforeSwap, 'A un aparato desconocido no se le leen marcaciones.');
    test = await bio.testConnection(device.id);
    assert.equal(test.ok, false);
    assert.equal(bio.listDevices().find((item) => item.id === device.id).status, 'DISCONNECTED');
    fake.records.pop();
    // Reemplazo autorizado por el administrador.
    bio.updateDevice(device.id, { resetSerial: true });
    test = await bio.testConnection(device.id);
    assert.equal(test.ok, true, test.error);
    assert.equal(bio.listDevices().find((item) => item.id === device.id).serialNumber, 'OTRO999');
    fake.serial = 'SIM0001';
    bio.updateDevice(device.id, { resetSerial: 'on' });
    test = await bio.testConnection(device.id);
    assert.equal(test.ok, true, test.error);
    assert.equal(bio.listDevices().find((item) => item.id === device.id).serialNumber, 'SIM0001');
    // El mismo aparato no se puede registrar dos veces, aunque sea con otra IP o puerto.
    const twin = new FakeZkDevice({ serial: 'SIM0001' });
    const twinPort = await twin.start(0);
    const twinDevice = bio.createDevice({ name: 'Duplicado', ip: '127.0.0.1', port: twinPort, branchId: ven.id });
    test = await bio.testConnection(twinDevice.id);
    assert.equal(test.ok, false);
    assert.match(test.error, /ya está registrado como "Lector Principal"/);
    bio.setDeviceActive(twinDevice.id, false);
    await twin.stop();
    sync = await bio.syncDevice(device.id, { manual: true, full: true });
    assert.equal(sync.ok, true);
    ok('identidad por número de serie: aparato cambiado o repetido no entra; el reemplazo se autoriza a mano');

    // ----- Registro de huella desde Qubiq (la huella queda solo en el lector) -----
    fake.users = [{ uid: 1, userId: '77', name: 'Existente' }];
    let enroll = await bio.enrollEmployee({ employeeId: caro, deviceId: device.id });
    assert.equal(enroll.enrolled, true, enroll.error);
    assert.equal(enroll.zkUserId, '3');
    assert.deepEqual(fake.users.find((user) => user.uid === 1), { uid: 1, userId: '77', name: 'Existente' }, 'No se pisa a otro usuario del lector.');
    assert.deepEqual(fake.users.find((user) => user.userId === '3'), { uid: 2, userId: '3', name: 'Carolina Nandu' });
    assert.equal(fake.fingers, 1);
    const dana = person('EMP004', 'Dana Prueba', '404440444');
    enroll = await bio.enrollEmployee({ employeeId: dana, deviceId: device.id });
    assert.equal(enroll.enrolled, true);
    assert.equal(enroll.zkUserId, '12', 'Asigna solo el siguiente ID y nunca reutiliza uno con historial.');
    // Reutilizar a mano el ID de un empleado eliminado no le pasa sus marcaciones a la persona nueva.
    const eva = person('EMP005', 'Eva Prueba', '505550555');
    const reused = bio.setMapping({ employeeId: eva, deviceId: device.id, zkUserId: '2' });
    assert.equal(reused.reprocessed, 0);
    assert.equal(reused.discarded, 1);
    assert.equal(attendanceOf(eva).length, 0);
    assert.equal(fake.templatesDeleted || 0, 0, 'Asignar por primera vez no borra ninguna huella.');
    enroll = await bio.enrollEmployee({ employeeId: dana, deviceId: device.id, replace: true });
    assert.equal(enroll.enrolled, true);
    assert.equal(fake.templatesDeleted, 1, 'Cambiar la huella reemplaza la anterior.');
    // El lector avisa que terminó: Qubiq responde enseguida, sin esperar el minuto completo.
    let enrollStarted = Date.now();
    enroll = await bio.enrollEmployee({ employeeId: dana, deviceId: device.id, replace: true });
    assert.equal(enroll.enrolled, true);
    assert.ok(Date.now() - enrollStarted < 5000, 'Debe terminar apenas el lector confirma la huella.');
    fake.enrollResult = 5;
    const duplicate = await zktecoDriver.enrollUser({ ip: '127.0.0.1', port: devicePort, commKey: '54321' }, { userId: '3', name: 'Carolina', waitMs: 20000 });
    assert.equal(duplicate.outcome === 'DUPLICATE' || duplicate.enrolled, true);
    fake.enrollResult = 0;
    fake.enrollStyle = 'legacy';
    enrollStarted = Date.now();
    const legacy = await zktecoDriver.enrollUser({ ip: '127.0.0.1', port: devicePort, commKey: '54321' }, { userId: '3', name: 'Carolina', waitMs: 20000 });
    assert.equal(legacy.enrolled, true);
    assert.equal(legacy.touches, 3);
    assert.ok(Date.now() - enrollStarted < 5000);
    fake.enrollSilentEnd = true;
    enrollStarted = Date.now();
    const silent = await zktecoDriver.enrollUser({ ip: '127.0.0.1', port: devicePort, commKey: '54321' }, { userId: '3', name: 'Carolina', waitMs: 30000 });
    assert.equal(silent.enrolled, true, 'Sin aviso final, se confirma por el contador de huellas del lector.');
    assert.ok(Date.now() - enrollStarted < 12000);
    fake.enrollSilentEnd = false;
    fake.enrollStyle = 'modern';
    fake.enrollWorks = false;
    const slow = await zktecoDriver.enrollUser({ ip: '127.0.0.1', port: devicePort, commKey: '54321' }, { userId: '3', name: 'Carolina', waitMs: 900 });
    assert.equal(slow.enrolled, false);
    fake.enrollWorks = true;
    const tables = db.prepare("SELECT sql FROM sqlite_master WHERE name LIKE '%biometric%'").all().map((row) => row.sql).join(' ');
    assert.equal(/template|huella|finger/i.test(tables), false, 'Qubiq no guarda huellas ni plantillas.');
    ok('asignar huella: crea el usuario en el lector, pide el dedo y no guarda biometría en Qubiq');

    // ----- Formato de usuario antiguo (28 bytes) en un lector vacío -----
    const old = new FakeZkDevice({ userPacketSize: 28, serial: 'SIM0002' });
    const oldPort = await old.start(0);
    const second = bio.createDevice({ name: 'Lector Bodega', ip: '127.0.0.1', port: oldPort, location: 'Bodega', branchId: ven.id });
    assert.equal(second.branchCode, 'VEN');
    // Un empleado usa el mismo ID en todos los lectores, y un ID nunca es de dos personas.
    assert.throws(() => bio.setMapping({ employeeId: ana, deviceId: second.id, zkUserId: '15' }), /mismo ID en todos los lectores/);
    assert.throws(() => bio.setMapping({ employeeId: caro, deviceId: second.id, zkUserId: '1' }), /ya está asignado a Ana Prueba/);
    assert.equal(bio.employeeBiometrics(ana).find((item) => item.deviceId === second.id).suggestedId, '1');
    assert.equal(bio.listMappings(second.id).rows.find((row) => row.employeeId === ana).sharedId, '1');
    enroll = await bio.enrollEmployee({ employeeId: ana, deviceId: second.id });
    assert.equal(enroll.enrolled, true, enroll.error);
    assert.equal(enroll.zkUserId, '1', 'En el segundo lector se le pone el mismo ID que ya tenía.');
    assert.deepEqual(old.users.map((user) => user.userId), ['1']);
    assert.equal(bio.employeeBiometrics(ana).length, 3);
    assert.equal(bio.listDevices().find((item) => item.id === second.id).serialNumber, 'SIM0002');
    assert.throws(() => branches.setBranchActive(ven.id, false), /lectores de huella activos/);
    // La misma persona marca en una sucursal y en otra: es un solo empleado.
    old.punch('1', ago(1));
    sync = await bio.syncDevice(second.id, { manual: true });
    assert.equal(sync.imported, 1);
    const crossEvent = bio.listEvents({ deviceId: second.id })[0];
    assert.equal(crossEvent.employee, 'Ana Prueba');
    assert.equal(crossEvent.branchCode, 'VEN');
    await old.stop();
    ok('varios lectores: cada uno en su sucursal, mismo ID por empleado, formato de usuario detectado solo');

    // ----- API: solo con sesión de administrador -----
    const { startServer } = await import('../src/server.js');
    server = await startServer({ quiet: true });
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/admin/biometric/devices`);
    assert.equal(anonymous.status, 401);
    const { createAdminSession, verifyToken } = await import('../src/security.js');
    const { setSetting } = await import('../src/db.js');
    const token = createAdminSession();
    setSetting('admin_session_nonce', verifyToken(token, 'admin').nonce);
    const headers = { Cookie: `qubiq_session=${encodeURIComponent(token)}`, 'Content-Type': 'application/json' };
    const listed = await (await fetch(`http://127.0.0.1:${port}/api/admin/biometric/devices`, { headers })).json();
    assert.equal(listed.length, 3);
    assert.equal(listed.find((item) => item.name === 'Lector Principal').branchCode, 'AGZ');
    assert.equal(JSON.stringify(listed).includes('54321'), false);
    assert.equal('comm_key_sealed' in listed[0], false);
    const system = await (await fetch(`http://127.0.0.1:${port}/api/admin/system`, { headers })).json();
    assert.equal(system.biometric.devices, 2);
    const viaApi = await fetch(`http://127.0.0.1:${port}/api/admin/biometric/devices/${device.id}/test`, { method: 'POST', headers, body: '{}' });
    assert.equal((await viaApi.json()).ok, true);
    ok('API protegida por sesión de administrador; nunca expone la clave');

    // ----- Reinicio del servicio (el agente arranca con el servidor) -----
    await until(() => bio.listDevices().find((item) => item.id === device.id).status === 'CONNECTED', 'agente activo');
    const attendanceBefore = count('SELECT COUNT(*) AS n FROM attendance');
    await new Promise((done) => server.close(done));
    server = null;
    assert.equal(attendanceOf(dana).length, 0);
    fake.punch('12', ago(3));
    server = await startServer({ quiet: true });
    await until(() => attendanceOf(dana).length === 1, 'marcación tomada sola tras reiniciar el servicio');
    await sleep(700);
    assert.equal(count('SELECT COUNT(*) AS n FROM attendance'), attendanceBefore + 1);
    await new Promise((done) => server.close(done));
    server = null;
    ok('reinicio del servicio: retoma solo y sin duplicar');

    // ----- Desactivar -----
    bio.setDeviceActive(second.id, false);
    assert.equal(bio.listDevices().find((item) => item.id === second.id).status, 'DISABLED');
    assert.equal((await bio.syncDevice(second.id)).skipped, true);
    ok('lector desactivado: deja de consultarse');

    // ----- Reinicio de Windows: proceso nuevo sobre los mismos datos -----
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(dataDir, 'restart-state.json'), JSON.stringify({
      port: devicePort, records: fake.records, users: fake.users, stoppedAt: Date.now()
    }));
    await fake.stop();
    db.close();
    licenseServer.close();
    await sleep(150);
    const child = spawnSync(process.execPath, [self, '--after-restart', dataDir], { encoding: 'utf8', timeout: 30000 });
    assert.match(child.stdout, /BIOMETRIC_RESTART_OK/, child.stderr);
    ok('reinicio de Windows (proceso nuevo): conserva configuración y no duplica');

    // ----- Actualización desde una versión sin sucursales -----
    const { DatabaseSync } = await import('node:sqlite');
    const oldDir = resolve(root, `.smoke-bio-old-${Date.now()}`);
    mkdirSync(oldDir, { recursive: true });
    const oldDb = new DatabaseSync(resolve(oldDir, 'qubiq.db'));
    oldDb.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES('admin_password_hash', 'x:y'), ('company_branchName', 'Sucursal Vieja');
      CREATE TABLE biometric_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'zkteco',
        ip TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 4370 CHECK(port BETWEEN 1 AND 65535),
        device_number INTEGER NOT NULL DEFAULT 1, comm_key_sealed TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1, poll_seconds INTEGER NOT NULL DEFAULT 30, min_gap_seconds INTEGER NOT NULL DEFAULT 120,
        import_since TEXT NOT NULL, last_contact_at TEXT, last_sync_at TEXT, last_error TEXT NOT NULL DEFAULT '',
        last_error_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_record_count INTEGER, last_event_local TEXT,
        info_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(ip, port));
      INSERT INTO biometric_devices(name, ip, port, import_since, info_json, created_at, updated_at)
        VALUES('Lector Antiguo', '192.168.1.202', 4370, '2026-10-01T06:00:00.000Z', '{"serial":"OLD123"}',
               '2026-10-01T06:00:00.000Z', '2026-10-01T06:00:00.000Z');`);
    oldDb.close();
    const migration = spawnSync(process.execPath, [self, '--migration', oldDir], { encoding: 'utf8', timeout: 30000 });
    try { rmSync(oldDir, { recursive: true, force: true }); } catch { /* limpieza no crítica */ }
    assert.match(migration.stdout, /BIOMETRIC_MIGRATION_OK/, migration.stderr);
    ok('actualización: el lector que ya existía queda en la sucursal que ya había, con su número de serie');

    console.log(`BIOMETRIC_TEST_OK ${passed} grupos de pruebas`);
  }
} finally {
  if (server) await new Promise((done) => server.close(done));
  await fake.stop();
  licenseServer.close();
  try { db.close(); } catch { /* ya cerrada */ }
  if (!restartMode) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* limpieza no crítica */ } }
}
