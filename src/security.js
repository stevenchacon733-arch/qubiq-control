import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

function appSecret() {
  mkdirSync(dirname(config.secretPath), { recursive: true });
  if (!existsSync(config.secretPath)) writeFileSync(config.secretPath, randomBytes(32), { mode: 0o600 });
  return readFileSync(config.secretPath);
}

const secret = appSecret();
const b64 = (input) => Buffer.from(input).toString('base64url');

export function sealJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}

export function openJson(payload) {
  const box = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

export function hashSecret(value) {
  const salt = randomBytes(16);
  const digest = scryptSync(String(value), salt, 32);
  return `${salt.toString('hex')}:${digest.toString('hex')}`;
}

export function verifySecret(value, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    const actual = scryptSync(String(value), Buffer.from(saltHex, 'hex'), 32);
    const expected = Buffer.from(hashHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function signToken(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token, kind) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', secret).update(body).digest();
    const supplied = Buffer.from(sig, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.kind !== kind || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const machineId = () => createHash('sha256').update(secret).update('qubiq-machine-id').digest('hex');

export const createAdminSession = () => signToken({ kind: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000, nonce: randomBytes(16).toString('hex') });
export const createKioskSession = () => signToken({ kind: 'kiosk', exp: Date.now() + 30 * 24 * 60 * 60 * 1000, nonce: randomBytes(16).toString('hex') });
export const createAttendanceToken = () => signToken({
  kind: 'attendance',
  exp: Date.now() + config.qrTtlSeconds * 1000,
  nonce: randomBytes(8).toString('hex')
});
