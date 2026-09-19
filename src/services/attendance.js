import { db, audit } from '../db.js';
import { hashSecret, verifySecret } from '../security.js';
import { localDate, localMinutes, localTime, minutesBetween, minutesFromClock, nowIso } from '../time.js';

function scheduleMinutes(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const start = minutesFromClock(startTime);
  let end = minutesFromClock(endTime);
  if (end <= start) end += 24 * 60;
  return end - start;
}

function countedWorkMinutes(actualMinutes, startTime, endTime) {
  const actual = Math.max(0, Number(actualMinutes) || 0);
  const wholeHours = Math.floor(actual / 60);
  const remainder = actual % 60;
  const rounded = (wholeHours + (remainder >= 30 ? 1 : 0)) * 60;
  const cap = scheduleMinutes(startTime, endTime);
  return cap == null ? rounded : Math.min(rounded, cap);
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
                            e.schedule_id, e.active, s.name AS schedule_name, s.start_time, s.end_time
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
  const scheduleId = input.scheduleId === '' || input.scheduleId == null
    ? null
    : Number(input.scheduleId);
  const pin = String(input.pin || '').trim();

  if (!code || !name || !nationalId || !email) throw new Error('Código, nombre, cédula y correo son obligatorios.');
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new Error('El código debe tener entre 2 y 20 letras, números, guion o guion bajo.');
  if (name.length < 2 || name.length > 120 || !/^[\p{L}\p{M} .'-]+$/u.test(name)) throw new Error('El nombre contiene caracteres no permitidos.');
  if (position.length > 80 || (position && !/^[\p{L}\p{M}0-9 .,'()&/-]+$/u.test(position))) throw new Error('El puesto contiene caracteres no permitidos.');
  if (!/^\d{6,20}$/.test(nationalId)) throw new Error('La cédula debe contener solo números válidos.');
  if (phone && !/^\d{8,15}$/.test(phone)) throw new Error('El teléfono debe contener entre 8 y 15 dígitos.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Ingrese un correo electrónico válido.');
  if (hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) throw new Error('La fecha de ingreso no es válida.');
  if (scheduleId != null && (!Number.isInteger(scheduleId) || scheduleId < 1 || !db.prepare('SELECT 1 FROM schedules WHERE id = ? AND active = 1').get(scheduleId))) throw new Error('El horario seleccionado no es válido.');
  if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('El PIN debe tener entre 4 y 8 dígitos.');
  return { code, name, position, nationalId, phone, email, hireDate, scheduleId, pin };
}

export function createEmployee(input) {
  const employee = normalizeEmployee(input);
  if (!employee.pin) throw new Error('El PIN debe tener entre 4 y 8 dígitos.');
  const result = db.prepare(`INSERT INTO employees(employee_code, name, position, national_id, phone, email, hire_date,
                             pin_hash, schedule_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(employee.code, employee.name, employee.position, employee.nationalId, employee.phone, employee.email,
      employee.hireDate, hashSecret(employee.pin), employee.scheduleId, nowIso());
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
                             phone = ?, email = ?, hire_date = ?, pin_hash = ?, schedule_id = ? WHERE id = ?`)
    .run(employee.code, employee.name, employee.position, employee.nationalId, employee.phone, employee.email,
      employee.hireDate, pinHash, employee.scheduleId, employeeId);
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
  audit('ADMIN', 'ARCHIVE', 'EMPLOYEE', employeeId, employee);
}

export function markAttendance({ tokenPayload, employeeCode, pin }) {
  const employee = db.prepare(`SELECT e.*, s.name AS schedule_name, s.start_time, s.end_time,
                                      s.tolerance_minutes, s.work_days
                               FROM employees e LEFT JOIN schedules s ON s.id = e.schedule_id
                               WHERE e.employee_code = ? AND e.active = 1 AND COALESCE(e.archived, 0) = 0`)
    .get(String(employeeCode || '').trim().toUpperCase());
  if (!employee || !verifySecret(pin, employee.pin_hash)) throw new Error('Código o PIN incorrecto.');
  if (!employee.schedule_id) throw new Error('Este empleado no tiene un horario asignado.');

  const now = new Date();
  const openEntry = db.prepare(`SELECT a.* FROM attendance a
    WHERE a.employee_id = ? AND a.event_type = 'ENTRY'
      AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.employee_id = a.employee_id
                      AND x.work_date = a.work_date AND x.event_type = 'EXIT')
    ORDER BY a.occurred_at DESC LIMIT 1`).get(employee.id);

  let eventType = 'ENTRY';
  let date = localDate(now);
  let status = 'OK';
  let delta = 0;

  if (openEntry) {
    const ageMinutes = minutesBetween(openEntry.occurred_at, now.toISOString());
    if (ageMinutes > 20 * 60) {
      throw new Error(`Hay una entrada pendiente del ${openEntry.work_date}. El administrador debe corregirla antes de una nueva marcación.`);
    }
    eventType = 'EXIT';
    date = openEntry.work_date;
  } else {
    const closedToday = db.prepare("SELECT 1 FROM attendance WHERE employee_id = ? AND work_date = ? AND event_type = 'EXIT'").get(employee.id, date);
    if (closedToday) throw new Error('La jornada de hoy ya fue cerrada.');
    let nowMinutes = localMinutes(now);
    const startMinutes = minutesFromClock(employee.start_time);
    let scheduledDelta = nowMinutes - startMinutes;
    if (scheduledDelta < -720) scheduledDelta += 1440;
    if (scheduledDelta > 720) scheduledDelta -= 1440;
    const late = scheduledDelta - Number(employee.tolerance_minutes || 0);
    status = late > 0 ? 'LATE' : 'ON_TIME';
    delta = Math.max(0, late);
  }

  db.prepare(`INSERT INTO attendance(employee_id, work_date, event_type, occurred_at, local_time,
                                     status, minutes_delta, source, qr_nonce, created_at)
                              VALUES(?, ?, ?, ?, ?, ?, ?, 'QR', ?, ?)`)
    .run(employee.id, date, eventType, now.toISOString(), localTime(now), status, delta, tokenPayload.nonce, nowIso());

  audit(`EMPLOYEE:${employee.employee_code}`, 'MARK', 'ATTENDANCE', employee.id, { date, eventType, status, delta });
  return { employee: employee.name, employeeId: employee.id, employeeCode: employee.employee_code,
    eventType, time: localTime(now).slice(0, 5), status, lateMinutes: delta,
    notificationEmail: employee.email || '', date };
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
    const rawWorked = entry && exit ? minutesBetween(entry.occurred_at, exit.occurred_at) : 0;
    const worked = entry && exit ? countedWorkMinutes(rawWorked, emp.start_time, emp.end_time) : 0;
    return {
      ...emp,
      entry: entry?.local_time?.slice(0,5) || null,
      exit: exit?.local_time?.slice(0,5) || null,
      attendanceStatus: entry ? entry.status : 'ABSENT_OR_PENDING',
      lateMinutes: entry?.minutes_delta || 0,
      workedMinutes: worked
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

export function payrollRows(from, to) {
  return db.prepare(`SELECT a.work_date, e.employee_code, e.name, e.position, e.national_id,
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
                     ORDER BY a.work_date, e.name`).all(from, to).map(row => ({
    fecha: row.work_date,
    codigo: row.employee_code,
    cedula: row.national_id || '',
    empleado: row.name,
    puesto: row.position,
    entrada: row.entry_time?.slice(0,5) || '',
    salida: row.exit_time?.slice(0,5) || '',
    estadoEntrada: row.entry_status || '',
    tardanzaMin: row.late_minutes || 0,
    horasTrabajadas: row.entry_iso && row.exit_iso
      ? countedWorkMinutes(minutesBetween(row.entry_iso, row.exit_iso), row.start_time, row.end_time) / 60
      : '',
    horasHorario: scheduleMinutes(row.start_time, row.end_time) / 60
  }));
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
