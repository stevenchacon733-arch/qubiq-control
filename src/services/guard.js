import { db } from '../db.js';

const MAX_ATTEMPTS = 8;
const LOCK_MS = 60 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function lockState(scope, key) {
  const row = db.prepare('SELECT * FROM security_lockouts WHERE scope = ? AND key_value = ?').get(scope, key);
  if (!row) return { locked: false, attempts: 0, remainingMs: 0 };
  const lockedUntil = row.locked_until ? Date.parse(row.locked_until) : 0;
  if (lockedUntil > Date.now()) {
    return { locked: true, attempts: row.failed_attempts, remainingMs: lockedUntil - Date.now() };
  }
  if (lockedUntil) resetFailures(scope, key);
  return { locked: false, attempts: Number(row.failed_attempts || 0), remainingMs: 0 };
}

export function registerFailure(scope, key) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM security_lockouts WHERE scope = ? AND key_value = ?').get(scope, key);
  const windowStart = row?.window_started_at ? Date.parse(row.window_started_at) : 0;
  const attempts = row && now - windowStart <= WINDOW_MS ? Number(row.failed_attempts || 0) + 1 : 1;
  const start = row && now - windowStart <= WINDOW_MS ? row.window_started_at : iso(now);
  const lockedUntil = attempts >= MAX_ATTEMPTS ? iso(now + LOCK_MS) : null;
  db.prepare(`INSERT INTO security_lockouts(scope, key_value, failed_attempts, window_started_at, locked_until, last_failed_at)
              VALUES(?, ?, ?, ?, ?, ?)
              ON CONFLICT(scope, key_value) DO UPDATE SET
                failed_attempts = excluded.failed_attempts,
                window_started_at = excluded.window_started_at,
                locked_until = excluded.locked_until,
                last_failed_at = excluded.last_failed_at`)
    .run(scope, key, attempts, start, lockedUntil, iso(now));
  return { attempts, locked: Boolean(lockedUntil), remainingAttempts: Math.max(0, MAX_ATTEMPTS - attempts) };
}

export function resetFailures(scope, key) {
  db.prepare('DELETE FROM security_lockouts WHERE scope = ? AND key_value = ?').run(scope, key);
}

export function assertNotLocked(scope, key) {
  const state = lockState(scope, key);
  if (!state.locked) return state;
  const minutes = Math.max(1, Math.ceil(state.remainingMs / 60000));
  const error = new Error(`Acceso bloqueado temporalmente. Intentá de nuevo en ${minutes} min.`);
  error.code = 'LOCKED';
  throw error;
}

export const guardConfig = Object.freeze({ maxAttempts: MAX_ATTEMPTS, lockMinutes: 60 });