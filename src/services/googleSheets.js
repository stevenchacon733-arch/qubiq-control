import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';
import { config } from '../config.js';
import { getGoogleOAuthClient, googleOAuthStatus } from './googleAuth.js';
import { ensureBackupFolder, ensurePayrollSpreadsheet } from './sheetFactory.js';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const IGNORED_TABS = /PRUEBA|VACACIONES/i;

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function normalizeId(value = '') {
  return String(value).replace(/\D+/g, '');
}

function extractCedula(values) {
  for (const row of values.slice(0, 10)) {
    for (const cell of row || []) {
      const text = String(cell || '');
      if (!/CED/i.test(text)) continue;
      const match = text.match(/CED(?:ULA)?\.?\s*:?\s*([0-9-]+)/i);
      if (match) return normalizeId(match[1]);
    }
  }
  return '';
}

function quincenaSpec(from, to) {
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new Error('Rango de fechas inválido.');
  if (a.getUTCFullYear() !== b.getUTCFullYear() || a.getUTCMonth() !== b.getUTCMonth())
    throw new Error('La sincronización debe pertenecer al mismo mes.');
  const firstHalf = a.getUTCDate() <= 15 && b.getUTCDate() <= 15;
  const secondHalf = a.getUTCDate() >= 16 && b.getUTCDate() >= 16;
  if (!firstHalf && !secondHalf) throw new Error('El rango no puede cruzar entre la I y II quincena.');
  const roman = firstHalf ? 'I' : 'II';
  return { roman, month: MONTHS[a.getUTCMonth()], title: `${roman} ${MONTHS[a.getUTCMonth()]}` };
}
async function credentials() {
  if (!existsSync(config.googleServiceAccountJson)) {
    throw new Error('Falta la credencial de Google. Coloque google-service-account.json en los datos de Qubiq Control.');
  }
  return JSON.parse(await readFile(config.googleServiceAccountJson, 'utf8'));
}

async function clients() {
  let auth;
  if (existsSync(config.googleServiceAccountJson)) {
    auth = new google.auth.GoogleAuth({
      credentials: await credentials(),
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });
  } else {
    auth = getGoogleOAuthClient();
  }
  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth })
  };
}

export function isGoogleSheetsConfigured() {
  return Boolean(existsSync(config.googleServiceAccountJson) || googleOAuthStatus().authorized);
}

function serialToDate(value) {
  if (typeof value !== 'number') return String(value || '').slice(0, 10);
  return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
}
function clockToHours(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h + (m / 60) : null;
}

async function findSpreadsheet(drive, spec) {
  if (config.googleSheetsId) return { id: config.googleSheetsId, name: spec.title };
  const response = await drive.files.list({
    q: `'${config.googleDriveFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 100
  });
  const target = normalize(spec.title);
  const files = response.data.files || [];
  const exact = files.find(file => normalize(file.name) === target);
  const starts = files.find(file => normalize(file.name).startsWith(target));
  const match = exact || starts;
  if (!match) throw new Error(`No encontré un Google Sheet para ${spec.title} en la carpeta configurada.`);
  return { id: match.id, name: match.name };
}

async function sheetProfiles(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title,index)' });
  const profiles = [];
  for (const item of meta.data.sheets || []) {
    const title = item.properties?.title;
    const sheetId = item.properties?.sheetId;
    if (sheetId == null || !title || IGNORED_TABS.test(title)) continue;
    const safe = title.replaceAll("'", "''");
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `'${safe}'!A1:H40`, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const values = result.data.values || [];
    const employeeName = values[3]?.[1] || '';
    const positionRow = values.find(row => normalize(row?.[0]) === 'PUESTO');
    const position = String(positionRow?.[1] || '').trim();
    const headerIndex = values.findIndex(row => normalize(row?.[0]) === 'FECHA');
    const totalIndex = values.findIndex((row, index) => index > headerIndex && normalize(row?.[0]) === 'TOTAL POR QUINCENA');
    if (!employeeName || headerIndex < 0) continue;
    profiles.push({ sheetId, title, employeeName, position, cedula: extractCedula(values), values, headerIndex, totalIndex });
  }
  return profiles;
}

function pickProfile(profiles, nationalId) {
  const wanted = normalizeId(nationalId);
  if (!wanted) return null;
  return profiles.find(profile => profile.cedula && profile.cedula === wanted) || null;
}

function positionGroup(value = '') {
  const text = normalize(value);
  if (text.includes('REGENTE') || text.includes('FARMACEUT')) return 'REGENTE';
  if (text.includes('DEPENDIENTE') || text.includes('CAJERO')) return 'DEPENDIENTE';
  return text;
}

function uniqueEmployeeTabTitle(profiles, row) {
  const code = String(row.codigo || 'EMP').trim().toUpperCase();
  const firstName = String(row.empleado || 'Empleado').trim().split(/\s+/)[0] || 'Empleado';
  const base = `${code}-${firstName}`.replace(/[\\/?*\[\]:]/g, '-').slice(0, 85);
  let title = base;
  let suffix = 2;
  while (profiles.some(profile => normalize(profile.title) === normalize(title))) title = `${base}-${suffix++}`.slice(0, 95);
  return title;
}

async function createEmployeeProfile(sheets, spreadsheetId, profiles, row) {
  const group = positionGroup(row.puesto);
  if (!['REGENTE', 'DEPENDIENTE'].includes(group)) return null;
  const donor = profiles.find(profile => positionGroup(profile.position) === group);
  if (!donor) return null;

  const title = uniqueEmployeeTabTitle(profiles, row);
  const duplicate = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ duplicateSheet: { sourceSheetId: donor.sheetId, newSheetName: title } }] }
  });
  const properties = duplicate.data.replies?.[0]?.duplicateSheet?.properties;
  if (properties?.sheetId == null) throw new Error(`No se pudo crear la pestaña para ${row.empleado}.`);

  const safeTitle = title.replaceAll("'", "''");
  const startRow = donor.headerIndex + 2;
  const endRow = donor.totalIndex > donor.headerIndex ? donor.totalIndex : donor.headerIndex + 20;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${safeTitle}'!B${startRow}:G${endRow}` });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: [
      { range: `'${safeTitle}'!B4`, values: [[row.empleado]] },
      { range: `'${safeTitle}'!B5`, values: [[`CED: ${normalizeId(row.cedula)}`]] },
      { range: `'${safeTitle}'!B6`, values: [[row.puesto || donor.position]] }
    ] }
  });

  const values = donor.values.map(entry => Array.isArray(entry) ? [...entry] : entry);
  if (values[3]) values[3][1] = row.empleado;
  if (values[4]) values[4][1] = `CED: ${normalizeId(row.cedula)}`;
  const positionIndex = values.findIndex(entry => normalize(entry?.[0]) === 'PUESTO');
  if (positionIndex >= 0) values[positionIndex][1] = row.puesto || donor.position;
  const profile = { ...donor, sheetId: properties.sheetId, title, employeeName: row.empleado,
    cedula: normalizeId(row.cedula), position: row.puesto || donor.position, values };
  profiles.push(profile);
  return profile;
}

function findDateRow(profile, date) {
  for (let i = profile.headerIndex + 1; i < profile.values.length; i += 1) {
    if (serialToDate(profile.values[i]?.[0]) === date) return i + 1;
  }
  return null;
}

function roundedClockHour(clock) {
  const hours = clockToHours(clock);
  if (hours == null) return null;
  const minutes = Math.round(hours * 60);
  const whole = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return whole + (remainder >= 30 ? 1 : 0);
}

function rowValues(_profile, _rowNumber, row) {
  const entryHours = clockToHours(row.entrada);
  const exitHours = clockToHours(row.salida);
  const roundedEntry = roundedClockHour(row.entrada);
  const roundedExit = roundedClockHour(row.salida);
  const cap = Number(row.horasHorario);
  if (entryHours == null || exitHours == null || !Number.isFinite(cap)) return null;

  const counted = Number(row.horasTrabajadas);
  const adjustedExit = exitHours < entryHours ? exitHours + 24 : exitHours;
  const rawMinutes = Math.max(0, Math.round((adjustedExit - entryHours) * 60));
  const roundedHours = Math.floor(rawMinutes / 60) + ((rawMinutes % 60) >= 30 ? 1 : 0);
  const worked = Number.isFinite(counted) ? Math.min(counted, cap) : Math.min(roundedHours, cap);
  const entryTime = roundedEntry / 24;
  const exitTime = roundedExit / 24;

  return [entryTime, exitTime, worked, worked, 0, 0];
}

async function syncGenericPayroll(sheets, target, rows, spec) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: target.id, fields: 'sheets.properties(sheetId,title)' });
  const first = meta.data.sheets?.[0]?.properties;
  if (!first?.sheetId && first?.sheetId !== 0) throw new Error('No se pudo preparar la hoja de Qubiq Control.');
  if (first.title !== 'Asistencia') {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: target.id, requestBody: { requests: [{
      updateSheetProperties: { properties: { sheetId: first.sheetId, title: 'Asistencia', gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' }
    }] } });
  }
  const headers = ['Fecha','Código','Cédula','Empleado','Puesto','Entrada','Salida','Estado','Tardanza (min)','Horas trabajadas','Descanso'];
  const values = rows.map(row => [row.fecha,row.codigo,row.cedula,row.empleado,row.puesto,row.entrada || '',row.salida || '',row.estadoEntrada || '',row.tardanzaMin ?? 0,row.horasTrabajadas ?? '',row.descanso ? 'SÍ' : '']);
  await sheets.spreadsheets.values.clear({ spreadsheetId: target.id, range: "'Asistencia'!A1:K5000" });
  await sheets.spreadsheets.values.update({ spreadsheetId: target.id, range: "'Asistencia'!A1", valueInputOption: 'USER_ENTERED', requestBody: { values: [headers, ...values] } });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: target.id, requestBody: { requests: [{ repeatCell: {
    range: { sheetId: first.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length },
    cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.06, green: 0.15, blue: 0.28 }, horizontalAlignment: 'CENTER' } },
    fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
  }}] } });
  return { rows: rows.length, updatedRows: rows.length, template: target.name, quincena: spec.title, createdSheet: Boolean(target.created), createdFolder: Boolean(target.folderCreated), folderName: target.folderName || '', missingEmployees: [], autoCreatedEmployees: [], skippedOpen: rows.filter(r => r.entrada && !r.salida).length, generic: true };
}

export async function syncPayrollRows(rows, { from, to } = {}) {
  if (!from || !to) throw new Error('Debe indicar el rango de la quincena.');
  const spec = quincenaSpec(from, to);
  const { sheets, drive } = await clients();
  const target = await ensurePayrollSpreadsheet({ drive, sheets, spec, from });
  if (target.generic) return syncGenericPayroll(sheets, target, rows, spec);
  const profiles = await sheetProfiles(sheets, target.id);
  const updates = [];
  const missingEmployees = new Set();
  const autoCreatedEmployees = [];
  let skippedOpen = 0;

  for (const row of rows) {
    let profile = pickProfile(profiles, row.cedula);
    if (!profile) {
      profile = await createEmployeeProfile(sheets, target.id, profiles, row);
      if (profile) autoCreatedEmployees.push({ empleado: row.empleado, cedula: row.cedula, puesto: row.puesto, pestaña: profile.title });
    }
    if (!profile) {
      missingEmployees.add(`${row.empleado} (${row.cedula || 'sin cédula'})`);
      continue;
    }
    const rowNumber = findDateRow(profile, row.fecha);
    if (!rowNumber) continue;
    const safeTitle = profile.title.replaceAll("'", "''");
    if (row.descanso) {
      updates.push({ range: `'${safeTitle}'!B${rowNumber}:C${rowNumber}`, values: [['DESCANSO', '']] });
      continue;
    }
    if (!row.entrada || !row.salida) {
      skippedOpen += 1;
      continue;
    }
    const values = rowValues(profile, rowNumber, row);
    if (!values) continue;
    updates.push({ range: `'${safeTitle}'!B${rowNumber}:G${rowNumber}`, values: [values] });
  }
  if (!updates.length) {
    return {
      rows: rows.length,
      updatedRows: 0,
      template: target.name,
      quincena: spec.title,
      createdSheet: Boolean(target.created),
      createdFolder: Boolean(target.folderCreated),
      folderName: target.folderName || '',
      missingEmployees: [...missingEmployees],
      autoCreatedEmployees,
      skippedOpen
    };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: target.id,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates
    }
  });

  const timeFormatRequests = profiles.map((profile) => ({
    repeatCell: {
      range: {
        sheetId: profile.sheetId,
        startRowIndex: profile.headerIndex + 1,
        endRowIndex: profile.totalIndex > profile.headerIndex ? profile.totalIndex : profile.headerIndex + 20,
        startColumnIndex: 1,
        endColumnIndex: 3
      },
      cell: { userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm' } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  }));
  if (timeFormatRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: target.id, requestBody: { requests: timeFormatRequests } });
  }

  return {
    rows: rows.length,
    updatedRows: updates.length,
    template: target.name,
    quincena: spec.title,
    createdSheet: Boolean(target.created),
    createdFolder: Boolean(target.folderCreated),
    folderName: target.folderName || '',
    missingEmployees: [...missingEmployees],
    autoCreatedEmployees,
    skippedOpen
  };
}


export async function uploadBackupToDrive(filePath, fileName) {
  if (!isGoogleSheetsConfigured()) return { uploaded: false, reason: 'not-configured' };
  const { drive } = await clients();
  const backupFolder = await ensureBackupFolder(drive);
  const response = await drive.files.create({
    requestBody: {
      name: fileName || String(filePath).split(/[\\/]/).pop(),
      parents: [backupFolder.id]
    },
    media: { mimeType: 'application/octet-stream', body: createReadStream(filePath) },
    fields: 'id,name,webViewLink'
  });
  return { uploaded: true, id: response.data.id, name: response.data.name, webViewLink: response.data.webViewLink || '' };
}
