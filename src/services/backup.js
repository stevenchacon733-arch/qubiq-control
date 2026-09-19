import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, getSetting, setSetting, audit } from '../db.js';
import { config } from '../config.js';
import { localDate, localTime, nowIso } from '../time.js';

const backupDir = resolve(config.dataDir, 'backups');
let timer = null;

function safeSqlPath(path) {
  return path.replaceAll('\\', '/').replaceAll("'", "''");
}

function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replace('T', '_').slice(0, 19);
}

function cleanupBackups(maxFiles = 30) {
  if (!existsSync(backupDir)) return;
  const files = readdirSync(backupDir)
    .filter(name => name.endsWith('.db'))
    .map(name => ({ name, path: resolve(backupDir, name), mtime: statSync(resolve(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(maxFiles)) unlinkSync(file.path);
}
export function createBackup(reason = 'manual') {
  mkdirSync(backupDir, { recursive: true });
  const fileName = `qubiq-${stamp()}-${String(reason).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.db`;
  const target = resolve(backupDir, fileName);
  db.exec(`VACUUM INTO '${safeSqlPath(target)}'`);
  cleanupBackups();
  const createdAt = nowIso();
  setSetting('last_backup_at', createdAt);
  setSetting('last_backup_path', target);
  audit('SYSTEM', 'BACKUP_CREATED', 'DATABASE', null, { reason, fileName });
  return { createdAt, path: target, fileName };
}

export function backupStatus() {
  return {
    lastBackupAt: getSetting('last_backup_at') || null,
    lastBackupPath: getSetting('last_backup_path') || null,
    directory: backupDir
  };
}

async function uploadCloudBackup(backup) {
  try {
    const { isGoogleSheetsConfigured, uploadBackupToDrive } = await import('./googleSheets.js');
    if (!isGoogleSheetsConfigured()) return;
    const cloud = await uploadBackupToDrive(backup.path, `BACKUP-${backup.fileName}`);
    if (cloud.uploaded) {
      setSetting('last_cloud_backup_at', nowIso());
      audit('SYSTEM', 'BACKUP_CLOUD', 'DATABASE', cloud.id || null, { name: cloud.name });
    }
  } catch (error) {
    console.error('Backup nube:', error.message);
  }
}

export function ensureDailyBackup() {
  const today = localDate();
  const currentTime = localTime().slice(0, 5);
  if (currentTime !== '21:00') return backupStatus();
  if (getSetting('last_scheduled_backup_date') === today) return backupStatus();

  const backup = createBackup('daily-21h');
  setSetting('last_scheduled_backup_date', today);
  void uploadCloudBackup(backup);
  return backup;
}

export function startBackupScheduler() {
  if (timer) return;
  const check = () => {
    try { ensureDailyBackup(); }
    catch (error) { console.error('Backup diario 21:00:', error.message); }
  };
  check();
  timer = setInterval(check, 30 * 1000);
  timer.unref?.();
}

export function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}