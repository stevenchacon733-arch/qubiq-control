import { db, audit } from '../db.js';
import { hashSecret, verifySecret } from '../security.js';
import { addDays, localDate, localMinutes, localTime, minutesBetween, minutesFromClock, nowIso, roundedClockHour, zonedToDate } from '../time.js';

function scheduleMinutes(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const start = minutesFromClock(startTime);
  let end = minutesFromClock(endTime);
  if (end <= start) end += 24 * 60;
  return end - start;
}

// Horas de una jornada: la hora de entrada y la de salida se redondean cada una a la hora entera y se restan.
// Es exactamente la cuenta que hace el libro de Excel, así la app, el CSV, Google Sheets y el Excel coinciden.
// Una salida "menor" que la entrada es del día siguiente (turno que cruza la medianoche).
export function countedHours(entryClock, exitClock) {
  const entry = roundedClockHour(entryClock);
  const exit = roundedClockHour(exitClock);
  if (entry == null || exit == null) return 0;
  return (exit < entry ? exit + 24 : exit) - entry;
}

// Las horas no se topan con el horario: se cuenta todo lo trabajado y lo que pasa de la jornada del horario
// se informa aparte como horas extra. Sin horario asignado no hay con qué comparar, así que todo es ordinario.
function splitWorkMinutes(entryClock, exitClock, startTime, endTime) {
  const total = entryClock && exitClock ? countedHours(entryClock, exitClock) * 60 : 0;
  const jornada = scheduleMinutes(startTime, endTime);
  const ordinary = jornada == null ? total : Math.min(total, jornada);
  return { total, ordinary, extra: total - ordinary };
}

// Margen para quedarse después de la hora. Pasado "jornada + este margen" desde la entrada, una marcación nueva
// ya no puede ser la salida de esa jornada: se trata como un olvido de salida.
const OVERTIME_MARGIN_MINUTES = 6 * 60;

function entryLateness(employee, at) {
  if (!employee.start_time) return { status: 'OK', delta: 0 };
  let scheduledDelta = localMinutes(at) - minutesFromClock(employee.start_time);
  if (scheduledDelta < -720) scheduledDelta += 1440;
  if (scheduledDelta > 720) scheduledDelta -= 1440;
  const late = scheduledDelta - Number(employee.tolerance_minutes || 0);
  return { status: late > 0 ? 'LATE' : 'ON_TIME', delta: Math.max(0, late) };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function listSchedules() {
  return db.prepare('SELECT * FROM schedules WHERE active = 1 ORDER BY name').all();
}

function normalizeSchedule(input, current = null) {
  const name = String(input.name ?? current?.name ?? '').trim();
  const start = String(input.startTime ?? current?.start_time ?? '').trim();
  const end = String(input.endTime ?? current?.end_time ?? '').trim();
  const tolerance = Number(input.toleranceMinutes ?? current?.tolerance_minutes ?? 5);

  if (name.length < 2 || name.length > 60) throw new Error('El nombre del horario debe tener entre 2 y 60 caracteres.');
  if (!TIME.test(start)) throw new Error('La hora de entrada no es válida.');
  if (!TIME.test(end)) throw new Error('La hora de salida no es válida.');
  if (start === end) throw new Error('La entrada y la salida no pueden ser la misma hora.');
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 120) throw new Error('La tolerancia debe ser un número entero entre 0 y 120 minutos.');
  return { name, start, end, tolerance };
}

export function createSchedule(input) {
  const schedule = normalizeSchedule(input);
  const workDays = '0,1,2,3,4,5,6';
  const result = db.prepare(`INSERT INTO schedules(name, start_time, end_time, tolerance_minutes, work_days, created_at)
                             VALUES(?, ?, ?, ?, ?, ?)`)
    .run(schedule.name, schedule.start, schedule.end, schedule.tolerance, workDays, nowIso());
  audit('ADMIN', 'CREATE', 'SCHEDULE', result.lastInsertRowid, { name: schedule.name, start: schedule.start, end: schedule.end });
  return result.lastInsertRowid;
}

export function updateSchedule(id, input) {
  const scheduleId = Number(id);
  const current = db.prepare('SELECT * FROM schedules WHERE id = ? AND active = 1').get(scheduleId);
  if (!current) throw new Error('Horario no encontrado.');
  const schedule = normalizeSchedule(input, current);
  const result = db.prepare(`UPDATE schedules SET name = ?, start_time = ?, end_time = ?, tolerance_minutes = ? WHERE id = ?`)
    .run(schedule.name, schedule.start, schedule.end, schedule.tolerance, scheduleId);
  if (!result.changes) throw new Error('Horario no encontrado.');
  audit('ADMIN', 'UPDATE', 'SCHEDULE', scheduleId, { name: schedule.name, start: schedule.start, end: schedule.end });
  return schedule;
}

export function listEmployees() {
  return db.prepare(`SELECT e.id, e.employee_code, e.name, e.position, e.national_id, e.phone, e.email, e.hire_date,
                            e.hourly_rate, e.schedule_id, e.active, s.name AS schedule_name, s.start_time, s.end_time
                     FROM employees e LEFT JOIN schedules s ON s.id = e.schedule_id
                     WHERE COALESCE(e.archived, 0) = 0
                     ORDER BY e.active DESC, e.name`).all();
}

function normalizeEmployee(input, current = null) {
  const code = String(input.employeeCode ?? current?.employee_code ?? '').trim().toUpperCase();
  const name = String(input.name ?? current?.name ?? '').trim();
  const position = String(input.position ?? current?.position ?? '').trim();
  const nationalId = String(input.nationalId ?? current?.national_id ?? '').replace(/\D+/g, '');
  const phone = String(input.phone ?? current?.phone ?? '').replace(/\D+/g, '');
  const email = String(input.email ?? current?.email ?? '').trim().toLowerCase();
  const hireDate = String(input.hireDate ?? current?.hire_date ?? '').trim();
  const hourlyRate = input.hourlyRate === '' || input.hourlyRate == null
    ? Number(current?.hourly_rate ?? 0)
    : Number(input.hourlyRate);
  // Un PATCH que no menciona el horario debe conservarlo; mandar '' o null lo quita a propósito.
  const scheduleId = input.scheduleId === undefined
    ? (current?.schedule_id ?? null)
    : (input.scheduleId === '' || input.scheduleId === null ? null : Number(input.scheduleId));
  const pin = String(input.pin || '').trim();

  if (!code || !name || !nationalId || !email) throw new Error('Código, nombre, cédula y correo son obligatorios.');
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new Error('El código debe tener entre 2 y 20 letras, números, guion o guion bajo.');
  if (name.length < 2 || name.length > 120 || !/^[\p{L}\p{M} .'-]+$/u.test(name)) throw new Error('El nombre contiene caracteres no permitidos.');
  if (position.length > 80 || (position && !/^[\p{L}\p{M}0-9 .,'()&/-]+$/u.test(position))) throw new Error('El puesto contiene caracteres no permitidos.');
  if (!/^\d{6,20}$/.test(nationalId)) throw new Error('La cédula debe contener solo números válidos.');
  if (phone && !/^\d{8,15}$/.test(phone)) throw new Error('El teléfono debe contener entre 8 y 15 dígitos.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Ingrese un correo electrónico válido.');
  if (hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) throw new Error('La fecha de ingreso no es válida.');
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0 || hourlyRate > 1000000) throw new Error('El salario por hora debe ser un monto entre 0 y 1.000.000.');
  if (scheduleId != null && (!Number.isInteger(scheduleId) || scheduleId < 1 || !db.prepare('SELECT 1 FROM schedules WHERE id = ? AND active = 1').get(scheduleId))) throw new Error('El horario seleccionado no es válido.');
  if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('El PIN debe tener entre 4 y 8 dígitos.');
  return { code, name, position, nationalId, phone, email, hireDate, hourlyRate: Math.round(hourlyRate * 100) / 100, scheduleId, pin };
}

export function createEmployee(input) {
  const employee = normalizeEmployee(input);
  if (!employee.pin) throw new Error('El PIN debe tener entre 4 y 8 dígitos.');
  const result = db.prepare(`INSERT INTO employees(employee_code, name, position, national_id, phone, email, hire_date,
                             hourly_rate, pin_hash, schedule_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(employee.code, employee.name, employee.position, employee.nationalId, employee.phone, employee.email,
      employee.hireDate, employee.hourlyRate, hashSecret(employee.pin), employee.scheduleId, nowIso());
  audit('ADMIN', 'CREATE', 'EMPLOYEE', result.lastInsertRowid, {
    code: employee.code, name: employee.name, scheduleId: employee.scheduleId
  });
  return result.lastInsertRowid;
}

export function updateEmployee(id, input) {
  const employeeId = Number(id);
  const current = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!current) throw new Error('Empleado no encontrado.');

  const employee = normalizeEmployee(input, current);
  const pinHash = employee.pin ? hashSecret(employee.pin) : current.pin_hash;
  const result = db.prepare(`UPDATE employees SET employee_code = ?, name = ?, position = ?, national_id = ?,
                             phone = ?, email = ?, hire_date = ?, hourly_rate = ?, pin_hash = ?, schedule_id = ? WHERE id = ?`)
    .run(employee.code, employee.name, employee.position, employee.nationalId, employee.phone, employee.email,
      employee.hireDate, employee.hourlyRate, pinHash, employee.scheduleId, employeeId);
  if (!result.changes) throw new Error('Empleado no encontrado.');

  audit('ADMIN', 'UPDATE', 'EMPLOYEE', employeeId, {
    code: employee.code,
    name: employee.name,
    scheduleId: employee.scheduleId,
    pinChanged: Boolean(employee.pin)
  });
}

export function setEmployeeActive(id, active) {
  const result = db.prepare('UPDATE employees SET active = ? WHERE id = ? AND COALESCE(archived, 0) = 0').run(active ? 1 : 0, Number(id));
  if (!result.changes) throw new Error('Empleado no encontrado.');
  audit('ADMIN', active ? 'ACTIVATE' : 'DEACTIVATE', 'EMPLOYEE', id);
}

export function archiveEmployee(id) {
  const employeeId = Number(id);
  const employee = db.prepare('SELECT employee_code, name FROM employees WHERE id = ? AND COALESCE(archived, 0) = 0').get(employeeId);
  if (!employee) throw new Error('Empleado no encontrado.');
  db.prepare('UPDATE employees SET active = 0, archived = 1 WHERE id = ?').run(employeeId);
  db.prepare('DELETE FROM employee_biometric_map WHERE employee_id = ?').run(employeeId);
  audit('ADMIN', 'ARCHIVE', 'EMPLOYEE', employeeId, employee);
}

const MARK_SOURCES = new Set(['QR', 'APP']);
const ENGINE_SOURCES = new Set(['QR', 'APP', 'BIO']);

const ENGINE_EMPLOYEE_SQL = `SELECT e.*, s.name AS schedule_name, s.start_time, s.end_time,
                                    s.tolerance_minutes, s.work_days
                             FROM employees e LEFT JOIN schedules s ON s.id = e.schedule_id
                             WHERE e.active = 1 AND COALESCE(e.archived, 0) = 0`;

export class AttendanceRuleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function activeEmployeeById(id) {
  return db.prepare(`${ENGINE_EMPLOYEE_SQL} AND e.id = ?`).get(Number(id)) || null;
}

// Motor único de asistencia: decide entrada o salida, tardanza y jornada. El QR ('QR'), la computadora del
// negocio ('APP') y el lector de huella ('BIO') solo cambian cómo llega la marcación y a qué hora ocurrió.
export function registerAttendance(employee, { at = new Date(), source = 'QR', nonce = null, minGapSeconds = 0 } = {}) {
  if (!ENGINE_SOURCES.has(source)) throw new Error('Origen de marcación inválido.');
  if (!employee.schedule_id) throw new Error('Este empleado no tiene un horario asignado.');

  const now = at;
  const external = source === 'BIO';
  const openEntry = db.prepare(`SELECT a.* FROM attendance a
    WHERE a.employee_id = ? AND a.event_type = 'ENTRY'
      AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.employee_id = a.employee_id
                      AND x.work_date = a.work_date AND x.event_type = 'EXIT')
    ORDER BY a.occurred_at DESC LIMIT 1`).get(employee.id);

  let eventType = 'ENTRY';
  let date = localDate(now);
  let status = 'OK';
  let delta = 0;

  // Olvido de salida: una entrada abierta solo se puede cerrar el mismo día, o al día siguiente si todavía
  // cabe dentro de "jornada + margen" (turnos que cruzan la medianoche o que se alargaron). Pasado eso, la
  // marcación nueva es la entrada de una jornada nueva y la anterior queda sin salida para que el
  // administrador la corrija; ya no se bloquea al empleado ni se le suman esas horas.
  const closable = openEntry && (openEntry.work_date === date
    || minutesBetween(openEntry.occurred_at, now.toISOString())
       <= (scheduleMinutes(employee.start_time, employee.end_time) ?? 480) + OVERTIME_MARGIN_MINUTES);

  if (closable) {
    if (external) {
      // El lector puede entregar marcaciones atrasadas o repetidas (dos toques seguidos del mismo dedo).
      const sinceEntryMs = now.getTime() - Date.parse(openEntry.occurred_at);
      if (sinceEntryMs <= 0) throw new AttendanceRuleError('La marcación es anterior a una entrada ya registrada.', 'OUT_OF_ORDER');
      if (sinceEntryMs < minGapSeconds * 1000) throw new AttendanceRuleError('Marcación repetida: se conserva la entrada ya registrada.', 'REPEATED');
    }
    eventType = 'EXIT';
    date = openEntry.work_date;
  } else {
    const closedToday = db.prepare("SELECT 1 FROM attendance WHERE employee_id = ? AND work_date = ? AND event_type = 'EXIT'").get(employee.id, date);
    if (closedToday) throw new Error('La jornada de hoy ya fue cerrada.');
    ({ status, delta } = entryLateness(employee, now));
  }

  const inserted = db.prepare(`INSERT INTO attendance(employee_id, work_date, event_type, occurred_at, local_time,
                                     status, minutes_delta, source, qr_nonce, created_at)
                              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(employee.id, date, eventType, now.toISOString(), localTime(now), status, delta, source, nonce, nowIso());

  audit(`EMPLOYEE:${employee.employee_code}`, 'MARK', 'ATTENDANCE', employee.id, { date, eventType, status, delta, source });
  return { employee: employee.name, employeeId: employee.id, employeeCode: employee.employee_code,
    eventType, time: localTime(now).slice(0, 5), status, lateMinutes: delta,
    notificationEmail: employee.email || '', date, attendanceId: Number(inserted.lastInsertRowid) };
}

// source: 'QR' cuando el empleado escanea con su celular, 'APP' cuando marca en la computadora del negocio.
export function markAttendance({ tokenPayload = null, employeeCode, pin, source = 'QR' }) {
  if (!MARK_SOURCES.has(source)) throw new Error('Origen de marcación inválido.');
  const employee = db.prepare(`${ENGINE_EMPLOYEE_SQL} AND e.employee_code = ?`)
    .get(String(employeeCode || '').trim().toUpperCase());
  if (!employee || !verifySecret(pin, employee.pin_hash)) throw new Error('Código o PIN incorrecto.');
  const { attendanceId, ...result } = registerAttendance(employee, { source, nonce: tokenPayload?.nonce ?? null });
  return result;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

// Corrección manual de una jornada por el administrador: fija o borra la hora de entrada y de salida de un
// empleado en una fecha. Sirve para un olvido de salida, una marca equivocada o marcas de prueba. Una salida
// "menor" que la entrada se toma como del día siguiente. Todo queda en la bitácora con el antes y el después.
export function correctAttendanceDay({ employeeId, workDate, entry = '', exit = '' } = {}) {
  const employee = db.prepare(`SELECT e.id, e.employee_code, e.name, s.start_time, s.end_time, s.tolerance_minutes
      FROM employees e LEFT JOIN schedules s ON s.id = e.schedule_id
      WHERE e.id = ? AND COALESCE(e.archived, 0) = 0`).get(Number(employeeId));
  if (!employee) throw new Error('Empleado no encontrado.');
  const date = String(workDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !zonedToDate(`${date} 00:00:00`)) throw new Error('Fecha inválida.');
  if (date > localDate()) throw new Error('No se puede corregir una fecha futura.');
  const entryClock = String(entry || '').trim().slice(0, 5);
  const exitClock = String(exit || '').trim().slice(0, 5);
  if (entryClock && !CLOCK.test(entryClock)) throw new Error('La hora de entrada no es válida.');
  if (exitClock && !CLOCK.test(exitClock)) throw new Error('La hora de salida no es válida.');
  if (exitClock && !entryClock) throw new Error('No puede haber salida sin entrada.');
  if (exitClock && exitClock === entryClock) throw new Error('La salida no puede ser igual a la entrada.');

  const entryAt = entryClock ? zonedToDate(`${date} ${entryClock}:00`) : null;
  const exitAt = exitClock ? zonedToDate(`${exitClock < entryClock ? addDays(date, 1) : date} ${exitClock}:00`) : null;
  const limit = Date.now() + 5 * 60 * 1000;
  if ((entryAt && entryAt.getTime() > limit) || (exitAt && exitAt.getTime() > limit)) throw new Error('No se puede registrar una hora futura.');

  const current = (type) => db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? AND event_type = ?')
    .get(employee.id, date, type);
  const describe = () => ({ entrada: current('ENTRY')?.local_time?.slice(0, 5) || '', salida: current('EXIT')?.local_time?.slice(0, 5) || '' });
  const before = describe();

  const apply = (type, clock, at) => {
    const row = current(type);
    if (!clock) {
      if (!row) return;
      db.prepare('UPDATE biometric_events SET attendance_id = NULL WHERE attendance_id = ?').run(row.id);
      db.prepare('DELETE FROM attendance WHERE id = ?').run(row.id);
      return;
    }
    if (row && row.local_time.slice(0, 5) === clock) return; // sin cambios: se conserva tal como se marcó
    const { status, delta } = type === 'ENTRY' ? entryLateness(employee, at) : { status: 'OK', delta: 0 };
    if (row) {
      db.prepare(`UPDATE attendance SET occurred_at = ?, local_time = ?, status = ?, minutes_delta = ?, source = 'ADMIN',
          note = 'Corregida por el administrador' WHERE id = ?`).run(at.toISOString(), `${clock}:00`, status, delta, row.id);
    } else {
      db.prepare(`INSERT INTO attendance(employee_id, work_date, event_type, occurred_at, local_time, status,
          minutes_delta, source, note, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, 'ADMIN', 'Corregida por el administrador', ?)`)
        .run(employee.id, date, type, at.toISOString(), `${clock}:00`, status, delta, nowIso());
    }
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    // Primero la salida cuando se borra todo, para no dejar nunca una salida sin entrada a medio camino.
    if (!entryClock) { apply('EXIT', '', null); apply('ENTRY', '', null); }
    else { apply('ENTRY', entryClock, entryAt); apply('EXIT', exitClock, exitAt); }
    const after = describe();
    audit('ADMIN', 'CORRECT', 'ATTENDANCE', employee.id, { workDate: date, antes: before, despues: after });
    db.exec('COMMIT');
    return { employeeId: employee.id, employee: employee.name, workDate: date, ...after };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function dailyOverview(date = localDate()) {
  const employees = db.prepare(`SELECT e.id, e.employee_code, e.name, e.position, e.active,
                                       s.start_time, s.end_time, s.work_days
                                FROM employees e LEFT JOIN schedules s ON s.id = e.schedule_id
                                WHERE e.active = 1 AND COALESCE(e.archived, 0) = 0 ORDER BY e.name`).all();
  const rows = employees.map(emp => {
    let events = db.prepare(`SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? ORDER BY occurred_at`).all(emp.id, date);
    const overnight = emp.start_time && emp.end_time && minutesFromClock(emp.end_time) <= minutesFromClock(emp.start_time);
    if (!events.length && date === localDate() && overnight) {
      const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
      const recent = db.prepare(`SELECT work_date FROM attendance WHERE employee_id = ? AND occurred_at >= ?
                                 ORDER BY occurred_at DESC LIMIT 1`).get(emp.id, cutoff);
      if (recent?.work_date) {
        events = db.prepare(`SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? ORDER BY occurred_at`)
          .all(emp.id, recent.work_date);
      }
    }
    const entry = events.find(x => x.event_type === 'ENTRY');
    const exit = events.find(x => x.event_type === 'EXIT');
    const worked = splitWorkMinutes(exit ? entry?.local_time : null, exit?.local_time, emp.start_time, emp.end_time);
    return {
      ...emp,
      workDate: events[0]?.work_date || date,
      entry: entry?.local_time?.slice(0,5) || null,
      exit: exit?.local_time?.slice(0,5) || null,
      attendanceStatus: entry ? entry.status : 'ABSENT_OR_PENDING',
      lateMinutes: entry?.minutes_delta || 0,
      workedMinutes: worked.total,
      extraMinutes: worked.extra
    };
  });

  return {
    date,
    totals: {
      employees: rows.length,
      present: rows.filter(r => r.entry).length,
      late: rows.filter(r => r.attendanceStatus === 'LATE').length,
      completed: rows.filter(r => r.exit).length
    },
    rows
  };
}

export function payrollEmployees() {
  return db.prepare(`SELECT e.id, e.employee_code, e.name, e.position, e.national_id, e.hourly_rate,
                            s.start_time, s.end_time
                     FROM employees e LEFT JOIN schedules s ON s.id = e.schedule_id
                     WHERE e.active = 1 AND COALESCE(e.archived, 0) = 0
                     ORDER BY e.name`).all().map(row => ({
    id: row.id,
    codigo: row.employee_code,
    cedula: row.national_id || '',
    empleado: row.name,
    puesto: row.position || '',
    salarioHora: Number(row.hourly_rate) || 0,
    jornadaHoras: (scheduleMinutes(row.start_time, row.end_time) ?? 480) / 60
  }));
}

export function payrollRows(from, to) {
  return db.prepare(`SELECT a.work_date, e.id AS employee_id, e.employee_code, e.name, e.position, e.national_id,
                            MAX(CASE WHEN a.event_type='ENTRY' THEN a.local_time END) AS entry_time,
                            MAX(CASE WHEN a.event_type='EXIT' THEN a.local_time END) AS exit_time,
                            MAX(CASE WHEN a.event_type='ENTRY' THEN a.status END) AS entry_status,
                            MAX(CASE WHEN a.event_type='ENTRY' THEN a.minutes_delta ELSE 0 END) AS late_minutes,
                            MIN(CASE WHEN a.event_type='ENTRY' THEN a.occurred_at END) AS entry_iso,
                            MAX(CASE WHEN a.event_type='EXIT' THEN a.occurred_at END) AS exit_iso,
                            s.start_time, s.end_time
                     FROM attendance a JOIN employees e ON e.id = a.employee_id
                     LEFT JOIN schedules s ON s.id = e.schedule_id
                     WHERE a.work_date BETWEEN ? AND ?
                     GROUP BY a.work_date, e.id
                     ORDER BY a.work_date, e.name`).all(from, to).map(row => {
    const closed = Boolean(row.entry_time && row.exit_time);
    const worked = closed ? splitWorkMinutes(row.entry_time, row.exit_time, row.start_time, row.end_time) : null;
    return {
    fecha: row.work_date,
    employeeId: row.employee_id,
    codigo: row.employee_code,
    cedula: row.national_id || '',
    empleado: row.name,
    puesto: row.position,
    entrada: row.entry_time?.slice(0,5) || '',
    salida: row.exit_time?.slice(0,5) || '',
    estadoEntrada: row.entry_status || '',
    tardanzaMin: row.late_minutes || 0,
    horasTrabajadas: worked ? worked.total / 60 : '',
    horasOrdinarias: worked ? worked.ordinary / 60 : '',
    horasExtra: worked ? worked.extra / 60 : '',
    horasHorario: scheduleMinutes(row.start_time, row.end_time) / 60
    };
  });
}

function datesBetween(from, to) {
  const dates = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function mondayOf(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function sundayOf(date) {
  const value = new Date(`${mondayOf(date)}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 6);
  return value.toISOString().slice(0, 10);
}

export function setDayStatus(employeeId, workDate, status = 'REST', note = '') {
  const id = Number(employeeId);
  const employee = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(id);
  if (!employee) throw new Error('Empleado no encontrado.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate))) throw new Error('Fecha inválida.');
  const allowed = new Set(['REST','ABSENT','VACATION','SICK','MANUAL']);
  if (!allowed.has(status)) throw new Error('Estado de día inválido.');
  if (status === 'REST') {
    db.prepare(`DELETE FROM day_status WHERE employee_id = ? AND status = 'REST'
                AND work_date BETWEEN ? AND ? AND work_date <> ?`)
      .run(id, mondayOf(workDate), sundayOf(workDate), workDate);
  }
  db.prepare(`INSERT INTO day_status(employee_id, work_date, status, note, updated_at)
              VALUES(?, ?, ?, ?, ?)
              ON CONFLICT(employee_id, work_date) DO UPDATE SET status=excluded.status,
                note=excluded.note, updated_at=excluded.updated_at`)
    .run(id, workDate, status, String(note || ''), nowIso());
  audit('ADMIN', 'DAY_STATUS', 'EMPLOYEE', id, { workDate, status, note: String(note || '') });
}

export function payrollSyncRows(from, to) {
  const employees = db.prepare(`SELECT id, employee_code, national_id, name, position
    FROM employees WHERE active = 1 AND COALESCE(archived, 0) = 0 ORDER BY name`).all();
  const scanFrom = mondayOf(from);
  const scanTo = sundayOf(to);
  const today = localDate();
  const attendance = payrollRows(scanFrom, scanTo);
  const byKey = new Map(attendance.map(row => [`${row.codigo}|${row.fecha}`, row]));
  const statuses = db.prepare(`SELECT employee_id, work_date, status, note FROM day_status
    WHERE work_date BETWEEN ? AND ?`).all(scanFrom, scanTo);
  const statusMap = new Map(statuses.map(row => [`${row.employee_id}|${row.work_date}`, row]));
  const rows = [];
  const unresolvedWeeks = [];
  const workedSevenDays = [];
  const conflicts = [];

  for (const employee of employees) {
    for (const date of datesBetween(from, to)) {
      const marked = byKey.get(`${employee.employee_code}|${date}`);
      const day = statusMap.get(`${employee.id}|${date}`);
      if (marked) {
        rows.push({ ...marked, descanso: false });
        if (day?.status === 'REST') conflicts.push({ employeeId: employee.id, empleado: employee.name, fecha: date,
          mensaje: 'Tiene asistencia y también está marcado como descanso.' });
      } else if (day?.status === 'REST') {
        rows.push({ fecha: date, codigo: employee.employee_code, cedula: employee.national_id || '',
          empleado: employee.name, puesto: employee.position, entrada: '', salida: '', descanso: true });
      }
    }

    let weekStart = new Date(`${scanFrom}T12:00:00Z`);
    const lastWeek = new Date(`${scanTo}T12:00:00Z`);
    while (weekStart <= lastWeek) {
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      const startText = weekStart.toISOString().slice(0, 10);
      const endText = weekEnd.toISOString().slice(0, 10);
      const weekDates = datesBetween(startText, endText);
      const markedDates = weekDates.filter(date => byKey.has(`${employee.employee_code}|${date}`));
      const explicitRest = weekDates.filter(date => statusMap.get(`${employee.id}|${date}`)?.status === 'REST');
      const elapsedDates = weekDates.filter(date => date <= today);
      const unmarkedElapsed = elapsedDates.filter(date => !byKey.has(`${employee.employee_code}|${date}`));
      const weekComplete = endText <= today;

      if (explicitRest.length === 0 && weekComplete && unmarkedElapsed.length === 1) {
        const inferred = unmarkedElapsed[0];
        if (inferred >= from && inferred <= to && !rows.some(row => row.codigo === employee.employee_code && row.fecha === inferred)) {
          rows.push({ fecha: inferred, codigo: employee.employee_code, cedula: employee.national_id || '',
            empleado: employee.name, puesto: employee.position, entrada: '', salida: '', descanso: true, inferredRest: true });
        }
      } else if (explicitRest.length === 0 && unmarkedElapsed.length > 0 && (weekComplete || endText > today)) {
        const candidates = unmarkedElapsed.filter(date => date >= from && date <= to);
        if (candidates.length) unresolvedWeeks.push({ employeeId: employee.id, empleado: employee.name,
          cedula: employee.national_id || '', semana: startText, semanaFin: endText,
          semanaCompleta: weekComplete, candidatos: candidates });
      }

      if (weekComplete && markedDates.length === 7 && explicitRest.length === 0) {
        workedSevenDays.push({ employeeId: employee.id, empleado: employee.name,
          cedula: employee.national_id || '', semana: startText, semanaFin: endText });
      }
      weekStart.setUTCDate(weekStart.getUTCDate() + 7);
    }
  }
  rows.review = { unresolvedWeeks, workedSevenDays, conflicts };
  return rows;
}
