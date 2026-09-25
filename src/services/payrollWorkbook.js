import { payrollEmployees, payrollSyncRows } from './attendance.js';
import { getCompanyProfile } from './company.js';
import { MONTHS } from './textMatch.js';
import {
  buildWorkbook, columnName, createSheet, dateSerial, merge, setCell, setCol, setFormula, setRowHeight
} from './xlsxWriter.js';

const DEFAULT_DEDUCTION = 0.1083;
const HEADER_ROW = 11;
const FIRST_DATA_ROW = HEADER_ROW + 1;
const RATES_SHEET = 'Tarifas';
const RATES_FIRST_ROW = 5;
const TABLE_HEADERS = ['FECHA', 'Hora\nEntrada', 'Hora\nSalida', 'Horas\nLaboradas', 'Horas\nOrdinarias', 'Horas\nExtras', 'Horas\nDobles'];

function datesBetween(from, to) {
  const dates = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime())) throw new Error('Rango de fechas inválido.');
  if (current > end) throw new Error('La fecha inicial no puede ser mayor que la final.');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  if (dates.length > 62) throw new Error('El rango es muy amplio. Genere la planilla por quincena o por mes.');
  return dates;
}

function roundedHour(clock) {
  const [hours, minutes] = String(clock || '').split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours + (minutes >= 30 ? 1 : 0);
}

const digits = (value) => String(value || '').replace(/\D+/g, '');

function lookupKey(employee) {
  const cedula = digits(employee.cedula);
  return cedula || `COD-${employee.codigo}`;
}

export function periodLabel(from, to) {
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
  if (!sameMonth) return `${from} a ${to}`;
  const month = `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  if (start.getUTCDate() <= 15 && end.getUTCDate() <= 15) return `I ${month}`;
  if (start.getUTCDate() >= 16 && end.getUTCDate() >= 16) return `II ${month}`;
  return month;
}

function sheetTitle(employee, position, used) {
  const first = String(employee.empleado || 'Empleado').trim().split(/\s+/)[0] || 'Empleado';
  const base = `${position}-${first}`.replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
  let title = base;
  let suffix = 2;
  while (used.has(title.toLowerCase())) title = `${base.slice(0, 28)}-${suffix++}`;
  used.add(title.toLowerCase());
  return title;
}

function buildRatesSheet(employees, deduction) {
  const sheet = createSheet(RATES_SHEET);
  const widths = [[1, 18], [2, 12], [3, 34], [4, 24], [5, 20], [6, 20], [7, 20], [8, 22]];
  for (const [index, width] of widths) setCol(sheet, index, width);

  setRowHeight(sheet, 1, 24);
  setCell(sheet, 1, 1, 'TARIFAS Y DEDUCCIONES', 'title');
  for (let column = 2; column <= 8; column += 1) setCell(sheet, 1, column, null, 'title');
  merge(sheet, 'A1:H1');

  setRowHeight(sheet, 2, 20);
  setCell(sheet, 2, 1, 'Deducción de ley (CCSS)', 'sheetLabel');
  for (let column = 2; column <= 4; column += 1) setCell(sheet, 2, column, null, 'sheetLabel');
  merge(sheet, 'A2:D2');
  setCell(sheet, 2, 5, deduction, 'sheetPercentInput');

  setRowHeight(sheet, 3, 18);
  setCell(sheet, 3, 1, 'Escriba el salario por hora de cada persona en la columna amarilla. Las hojas de cada empleado se llenan solas: se reconocen por la cédula.', 'note');
  merge(sheet, 'A3:H3');

  const headers = ['Cédula', 'Código', 'Empleado', 'Puesto', 'Salario por hora', 'Jornada ordinaria (h)', 'Hora extra', 'Salario mensual ref.'];
  setRowHeight(sheet, 4, 30);
  headers.forEach((header, index) => setCell(sheet, 4, index + 1, header, 'sheetHead'));
  sheet.freeze = 4;

  employees.forEach((employee, index) => {
    const row = RATES_FIRST_ROW + index;
    setRowHeight(sheet, row, 18);
    setCell(sheet, row, 1, lookupKey(employee), 'sheetText', { text: true });
    setCell(sheet, row, 2, String(employee.codigo), 'sheetText', { text: true });
    setCell(sheet, row, 3, employee.empleado, 'sheetText', { text: true });
    setCell(sheet, row, 4, employee.puesto, 'sheetText', { text: true });
    setCell(sheet, row, 5, employee.salarioHora ?? 0, 'sheetMoneyInput');
    setCell(sheet, row, 6, employee.jornadaHoras, 'sheetNumberInput');
    setFormula(sheet, row, 7, `E${row}+(E${row}/2)`, 'sheetMoney');
    setFormula(sheet, row, 8, `E${row}*240`, 'sheetMoney');
  });

  return sheet;
}

function buildEmployeeSheet(employee, { title, dates, dayByDate, company, ratesRange }) {
  const sheet = createSheet(title);
  const widths = [[1, 40.13], [2, 23], [3, 10.88], [4, 16.13], [5, 18.13], [6, 18], [7, 12.5]];
  for (const [index, width] of widths) setCol(sheet, index, width);

  const key = lookupKey(employee);
  const rate = `IFERROR(VLOOKUP("${key}",${ratesRange},5,FALSE),0)`;
  const shift = `IFERROR(VLOOKUP("${key}",${ratesRange},6,FALSE),8)`;

  const header = String(company.businessName || 'Mi negocio').toUpperCase();
  const branch = String(company.branchName || '').trim();
  const fullHeader = branch && branch.toLowerCase() !== 'sucursal principal' ? `${header} ${branch.toUpperCase()}` : header;

  for (let row = 1; row <= 5; row += 1) setRowHeight(sheet, row, 20.25);
  for (let row = 6; row <= 10; row += 1) setRowHeight(sheet, row, 18.75);

  setCell(sheet, 1, 1, fullHeader, 'title');
  for (let column = 2; column <= 7; column += 1) setCell(sheet, 1, column, null, 'title');
  merge(sheet, 'A1:G1');

  setCell(sheet, 2, 1, 'COMPROBANTE DE PAGO-CONTROL DE HORAS LABORADAS', 'subtitle');
  for (let column = 2; column <= 7; column += 1) setCell(sheet, 2, column, null, 'subtitle');
  merge(sheet, 'A2:G2');

  setCell(sheet, 3, 1, dateSerial(dates[dates.length - 1]), 'headerDate');

  setCell(sheet, 4, 1, 'Nombre del Trabajador:', 'label');
  setCell(sheet, 4, 2, employee.empleado, 'identity');
  setCell(sheet, 4, 3, null, 'identity');
  setCell(sheet, 4, 4, null, 'identity');
  merge(sheet, 'B4:D4');

  setCell(sheet, 5, 1, null, 'label');
  setCell(sheet, 5, 2, digits(employee.cedula) ? `CED: ${digits(employee.cedula)}` : `CÓDIGO: ${employee.codigo}`, 'identity');
  setCell(sheet, 5, 3, null, 'identity');
  setCell(sheet, 5, 4, null, 'identity');
  merge(sheet, 'B5:D5');

  setCell(sheet, 6, 1, 'Puesto', 'label');
  setCell(sheet, 6, 2, employee.puesto, 'identity');

  setCell(sheet, 7, 1, 'Salario Mensual', 'label');
  setFormula(sheet, 7, 2, 'B8*240', 'money');

  setCell(sheet, 8, 1, 'Hora Ordinaria', 'label');
  setFormula(sheet, 8, 2, rate, 'money');

  setCell(sheet, 9, 1, 'Hora Extra', 'label');
  setFormula(sheet, 9, 2, 'B8+(B8/2)', 'money');

  setCell(sheet, 10, 1, 'Jornada Ordinaria', 'label');
  setFormula(sheet, 10, 2, shift, 'hours');

  setRowHeight(sheet, HEADER_ROW, 37.5);
  TABLE_HEADERS.forEach((text, index) => setCell(sheet, HEADER_ROW, index + 1, text, 'tableHead'));

  dates.forEach((date, index) => {
    const row = FIRST_DATA_ROW + index;
    const day = dayByDate.get(date);
    setRowHeight(sheet, row, 18.75);
    setCell(sheet, row, 1, dateSerial(date), 'cellDate');

    if (day?.descanso) {
      setCell(sheet, row, 2, 'DESCANSO', 'cellText');
      setCell(sheet, row, 3, null, 'cellText');
      merge(sheet, `B${row}:C${row}`);
    } else {
      setCell(sheet, row, 2, roundedHour(day?.entrada), 'cellNumber');
      setCell(sheet, row, 3, roundedHour(day?.salida), 'cellNumber');
    }

    setFormula(sheet, row, 4, `IF(OR(NOT(ISNUMBER(B${row})),NOT(ISNUMBER(C${row}))),"",IF(C${row}<B${row},C${row}+24,C${row})-B${row})`, 'cellNumber');
    setFormula(sheet, row, 5, `IF(D${row}="","",MIN(D${row},$B$10))`, 'cellNumber');
    setFormula(sheet, row, 6, `IF(D${row}="","",MAX(0,D${row}-E${row}))`, 'cellNumber');
    setCell(sheet, row, 7, 0, 'cellInput');
  });

  const lastDataRow = FIRST_DATA_ROW + dates.length - 1;
  const totalRow = lastDataRow + 1;
  const earnedRow = totalRow + 1;
  const grossRow = totalRow + 2;
  const deductionRow = totalRow + 3;
  const netRow = totalRow + 4;

  setRowHeight(sheet, totalRow, 21);
  setCell(sheet, totalRow, 1, 'TOTAL POR QUINCENA', 'totalLabel');
  setCell(sheet, totalRow, 2, null, 'totalLabel');
  setCell(sheet, totalRow, 3, null, 'totalLabel');
  for (let column = 4; column <= 7; column += 1) {
    const letter = columnName(column);
    setFormula(sheet, totalRow, column, `SUM(${letter}${FIRST_DATA_ROW}:${letter}${lastDataRow})`, 'totalNumber');
  }

  for (const row of [earnedRow, grossRow, deductionRow, netRow]) setRowHeight(sheet, row, 18.75);

  setCell(sheet, earnedRow, 4, 'Total', 'totalLabel');
  setFormula(sheet, earnedRow, 5, `E${totalRow}*$B$8`, 'totalMoney');
  setFormula(sheet, earnedRow, 6, `F${totalRow}*$B$9`, 'totalMoney');
  setFormula(sheet, earnedRow, 7, `G${totalRow}*$B$8`, 'totalMoney');

  setCell(sheet, grossRow, 4, 'Total Devengado', 'totalLabel');
  setFormula(sheet, grossRow, 5, `SUM(E${earnedRow}:G${earnedRow})`, 'totalMoney');

  setCell(sheet, deductionRow, 3, 'Deducción', 'totalLabelRight');
  setFormula(sheet, deductionRow, 4, `${RATES_SHEET}!$E$2`, 'percent');
  setFormula(sheet, deductionRow, 5, `E${grossRow}*D${deductionRow}`, 'totalMoney');

  setCell(sheet, netRow, 4, 'Monto a Pagar', 'totalLabel');
  setFormula(sheet, netRow, 5, `E${grossRow}-E${deductionRow}`, 'totalMoney');

  const signRow = netRow + 5;
  setRowHeight(sheet, signRow, 18.75);
  setCell(sheet, signRow, 1, 'FIRMA EMPLEADO: ____________________', 'sign');
  setCell(sheet, signRow, 3, digits(employee.cedula) ? `CÉDULA NO: ${digits(employee.cedula)}` : 'CÉDULA NO: ________________', 'sign');

  return sheet;
}

export function buildPayrollWorkbook(from, to, options = {}) {
  const dates = datesBetween(from, to);
  const company = getCompanyProfile();
  const employees = payrollEmployees();
  if (!employees.length) throw new Error('No hay empleados activos para generar la planilla.');

  const rows = payrollSyncRows(from, to);
  const byEmployee = new Map(employees.map(employee => [employee.codigo, new Map()]));
  for (const row of rows) {
    const days = byEmployee.get(row.codigo);
    if (days) days.set(row.fecha, row);
  }

  const deduction = Number.isFinite(Number(options.deduction)) ? Number(options.deduction) : DEFAULT_DEDUCTION;
  const ratesRange = `${RATES_SHEET}!$A$${RATES_FIRST_ROW}:$H$${RATES_FIRST_ROW + employees.length - 1}`;
  const used = new Set([RATES_SHEET.toLowerCase()]);

  const sheets = [buildRatesSheet(employees, deduction)];
  employees.forEach((employee, index) => {
    sheets.push(buildEmployeeSheet(employee, {
      title: sheetTitle(employee, index + 1, used),
      dates,
      dayByDate: byEmployee.get(employee.codigo) || new Map(),
      company,
      ratesRange
    }));
  });

  const period = periodLabel(from, to);
  return {
    buffer: buildWorkbook(sheets),
    fileName: `Planilla ${period}.xlsx`.replace(/[\\/:*?"<>|]/g, '-'),
    period,
    employees: employees.length,
    days: dates.length
  };
}
