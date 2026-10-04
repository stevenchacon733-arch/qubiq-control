import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { nowIso } from './time.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  tolerance_minutes INTEGER NOT NULL DEFAULT 5 CHECK(tolerance_minutes BETWEEN 0 AND 120),
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  national_id TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  hire_date TEXT NOT NULL DEFAULT '',
  hourly_rate REAL NOT NULL DEFAULT 0,
  pin_hash TEXT NOT NULL,
  schedule_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(schedule_id) REFERENCES schedules(id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('ENTRY','EXIT')),
  occurred_at TEXT NOT NULL,
  local_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OK',
  minutes_delta INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'QR',
  qr_nonce TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(id),
  UNIQUE(employee_id, work_date, event_type)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance(employee_id, work_date);
`);

const employeeColumns = db.prepare('PRAGMA table_info(employees)').all().map(row => row.name);
const employeeMigrations = [
  ['archived', 'INTEGER NOT NULL DEFAULT 0'],
  ['national_id', "TEXT NOT NULL DEFAULT ''"],
  ['phone', "TEXT NOT NULL DEFAULT ''"],
  ['email', "TEXT NOT NULL DEFAULT ''"],
  ['hire_date', "TEXT NOT NULL DEFAULT ''"],
  ['hourly_rate', 'REAL NOT NULL DEFAULT 0']
];
for (const [column, definition] of employeeMigrations) {
  if (!employeeColumns.includes(column)) db.exec(`ALTER TABLE employees ADD COLUMN ${column} ${definition}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS security_lockouts (
  scope TEXT NOT NULL,
  key_value TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  locked_until TEXT,
  last_failed_at TEXT NOT NULL,
  PRIMARY KEY(scope, key_value)
);

CREATE TABLE IF NOT EXISTS mail_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  work_date TEXT NOT NULL,
  local_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS day_status (
  employee_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('REST','ABSENT','VACATION','SICK','MANUAL')),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(employee_id, work_date),
  FOREIGN KEY(employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_mail_queue_status ON mail_queue(status, next_attempt_at);
`);

// Sucursales (modo multisucursal). No se borran: se desactivan.
db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// Lectores biométricos. Solo se guardan IDs y marcaciones: nunca huellas ni plantillas.
db.exec(`
CREATE TABLE IF NOT EXISTS biometric_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  driver TEXT NOT NULL DEFAULT 'zkteco',
  ip TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 4370 CHECK(port BETWEEN 1 AND 65535),
  device_number INTEGER NOT NULL DEFAULT 1,
  comm_key_sealed TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  poll_seconds INTEGER NOT NULL DEFAULT 30,
  min_gap_seconds INTEGER NOT NULL DEFAULT 120,
  import_since TEXT NOT NULL,
  last_contact_at TEXT,
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_record_count INTEGER,
  last_event_local TEXT,
  info_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ip, port)
);

CREATE TABLE IF NOT EXISTS employee_biometric_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  zk_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(id),
  FOREIGN KEY(device_id) REFERENCES biometric_devices(id),
  UNIQUE(device_id, zk_user_id),
  UNIQUE(device_id, employee_id)
);

CREATE TABLE IF NOT EXISTS biometric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  zk_user_id TEXT NOT NULL,
  punched_local TEXT NOT NULL,
  occurred_at TEXT,
  verify_status INTEGER NOT NULL DEFAULT 0,
  punch_state INTEGER NOT NULL DEFAULT 0,
  employee_id INTEGER,
  attendance_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('APPLIED','UNMAPPED','REJECTED','IGNORED','INVALID')),
  note TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY(device_id) REFERENCES biometric_devices(id),
  UNIQUE(device_id, zk_user_id, punched_local, verify_status, punch_state)
);

CREATE TABLE IF NOT EXISTS biometric_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  device_name TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bio_events_device_time ON biometric_events(device_id, punched_local);
CREATE INDEX IF NOT EXISTS idx_bio_events_status ON biometric_events(device_id, zk_user_id, status);
CREATE INDEX IF NOT EXISTS idx_bio_logs_device ON biometric_sync_logs(device_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bio_events_attendance ON biometric_events(attendance_id) WHERE attendance_id IS NOT NULL;
`);

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
export const setSetting = (key, value) => db.prepare(`
  INSERT INTO settings(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(key, String(value));

export function audit(actor, action, entityType, entityId = null, details = {}) {
  db.prepare(`INSERT INTO audit_log(actor, action, entity_type, entity_id, details_json, created_at)
              VALUES(?, ?, ?, ?, ?, ?)`)
    .run(actor, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details), nowIso());
}
