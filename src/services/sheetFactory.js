import { config } from '../config.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const IGNORED_TABS = /PRUEBA|VACACIONES/i;

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function qText(value = '') {
  return String(value).replaceAll("'", "\\'");
}

function googleSerial(dateText) {
  const ms = Date.parse(`${dateText}T00:00:00Z`);
  return (ms - Date.UTC(1899, 11, 30)) / 86400000;
}

function periodInfo(spec, from) {
  const base = new Date(`${from}T12:00:00Z`);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const firstDay = spec.roman === 'I' ? 1 : 16;
  const lastDay = spec.roman === 'I' ? 15 : new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    dates.push(new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10));
  }
  return {
    year,
    month,
    dates,
    endDate: dates.at(-1),
    folderName: `${year} - ${spec.month}`,
    fileName: `${spec.title} ${year}`
  };
}

export async function ensureChildFolder(drive, parentId, name) {
  const result = await drive.files.list({
    q: `'${qText(parentId)}' in parents and trashed = false and mimeType = '${FOLDER_MIME}' and name = '${qText(name)}'`,
    fields: 'files(id,name,webViewLink)',
    pageSize: 10
  });
  const existing = result.data.files?.[0];
  if (existing) return { ...existing, created: false };
  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id,name,webViewLink'
  });
  return { ...created.data, created: true };
}

async function resolveBaseFolder(drive) {
  if (config.googleDriveFolderId) {
    try {
      const result = await drive.files.get({ fileId: config.googleDriveFolderId, fields: 'id,name,webViewLink' });
      return { ...result.data, created: false, fallback: false };
    } catch (error) {
      const status = Number(error?.code || error?.response?.status || 0);
      if (![403, 404].includes(status)) throw error;
    }
  }
  const folder = await ensureChildFolder(drive, 'root', 'Qubiq Control');
  return { ...folder, fallback: true };
}

async function findSheetInFolder(drive, folderId, target) {
  const response = await drive.files.list({
    q: `'${qText(folderId)}' in parents and trashed = false and mimeType = '${SHEET_MIME}'`,
    fields: 'files(id,name,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: 100
  });
  const wanted = normalize(target);
  const files = response.data.files || [];
  return files.find((file) => normalize(file.name) === wanted)
    || files.find((file) => normalize(file.name).startsWith(wanted))
    || null;
}

async function prepareDates(sheets, spreadsheetId, spec, from) {
  const period = periodInfo(spec, from);
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)'
  });
  const insertRequests = [];
  const plans = [];

  for (const item of meta.data.sheets || []) {
    const sheetId = item.properties?.sheetId;
    const title = item.properties?.title;
    if (sheetId == null || !title || IGNORED_TABS.test(title)) continue;
    const safe = title.replaceAll("'", "''");
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${safe}'!A1:H50`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const values = result.data.values || [];
    const headerIndex = values.findIndex((row) => normalize(row?.[0]) === 'FECHA');
    const totalIndex = values.findIndex((row, index) => index > headerIndex && normalize(row?.[0]) === 'TOTAL POR QUINCENA');
    if (headerIndex < 0 || totalIndex < 0) continue;

    const availableRows = totalIndex - headerIndex - 1;
    const missingRows = Math.max(0, period.dates.length - availableRows);
    if (missingRows) {
      insertRequests.push({
        insertDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: totalIndex, endIndex: totalIndex + missingRows },
          inheritFromBefore: true
        }
      });
    }
    plans.push({
      sheetId,
      title,
      safe,
      headerIndex,
      availableRows: Math.max(availableRows, period.dates.length)
    });
  }

  if (insertRequests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: insertRequests }
    });
  }

  const data = [];
  for (const plan of plans) {
    const startRow = plan.headerIndex + 2;
    const endRow = startRow + plan.availableRows - 1;
    const rows = [];
    for (let i = 0; i < plan.availableRows; i += 1) {
      rows.push(i < period.dates.length
        ? [googleSerial(period.dates[i]), '', '', '', '', '', '']
        : ['', '', '', '', '', '', '']);
    }
    data.push({ range: `'${plan.safe}'!A${startRow}:G${endRow}`, values: rows });
    data.push({ range: `'${plan.safe}'!A3`, values: [[googleSerial(period.endDate)]] });
  }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ updateSpreadsheetProperties: {
        properties: { timeZone: 'America/Costa_Rica' },
        fields: 'timeZone'
      }}]
    }
  });
  return period;
}

export async function ensurePayrollSpreadsheet({ drive, sheets, spec, from }) {
  if (config.googleSheetsId) {
    return { id: config.googleSheetsId, name: spec.title, created: false, folderCreated: false, generic: !config.googleTemplateSheetsId };
  }
  const period = periodInfo(spec, from);
  const baseFolder = await resolveBaseFolder(drive);

  const legacy = await findSheetInFolder(drive, baseFolder.id, spec.title);
  if (legacy) return { ...legacy, created: false, folderCreated: baseFolder.created, generic: !config.googleTemplateSheetsId };

  const monthFolder = await ensureChildFolder(drive, baseFolder.id, period.folderName);
  const existing = await findSheetInFolder(drive, monthFolder.id, spec.title);
  if (existing) return { ...existing, created: false, folderCreated: baseFolder.created || monthFolder.created, folderName: period.folderName, generic: !config.googleTemplateSheetsId };

  if (!config.googleTemplateSheetsId) {
    const created = await drive.files.create({
      requestBody: { name: period.fileName, mimeType: SHEET_MIME, parents: [monthFolder.id] },
      fields: 'id,name,webViewLink'
    });
    return {
      ...created.data,
      created: true,
      generic: true,
      folderCreated: baseFolder.created || monthFolder.created,
      folderName: period.folderName,
      baseFolderName: baseFolder.name || 'Qubiq Control'
    };
  }

  const copied = await drive.files.copy({
    fileId: config.googleTemplateSheetsId,
    requestBody: { name: period.fileName, parents: [monthFolder.id] },
    fields: 'id,name,webViewLink'
  });
  try {
    await prepareDates(sheets, copied.data.id, spec, from);
  } catch (error) {
    try { await drive.files.delete({ fileId: copied.data.id }); } catch { /* conservar error original */ }
    throw new Error(`No se pudo preparar la nueva planilla ${period.fileName}: ${error.message}`);
  }

  return {
    ...copied.data,
    created: true,
    folderCreated: baseFolder.created || monthFolder.created,
    folderName: period.folderName,
    baseFolderName: baseFolder.name || 'Qubiq Control'
  };
}

export async function ensureBackupFolder(drive) {
  const baseFolder = await resolveBaseFolder(drive);
  return ensureChildFolder(drive, baseFolder.id, 'Backups');
}
