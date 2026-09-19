import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { openJson, sealJson } from '../security.js';

const filePath = resolve(config.dataDir, 'integrations.enc');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})$/;

function readAll() {
  if (!existsSync(filePath)) return {};
  try { return openJson(readFileSync(filePath, 'utf8')) || {}; }
  catch { return {}; }
}

function writeAll(value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, sealJson(value), { encoding: 'utf8', mode: 0o600 });
}

export function getMailConfig() {
  const saved = readAll().mail || {};
  return {
    host: saved.host || config.smtpHost || '',
    port: Number(saved.port || config.smtpPort || 587),
    secure: saved.secure ?? config.smtpSecure ?? false,
    user: saved.user || config.smtpUser || '',
    pass: saved.pass || config.smtpPass || '',
    from: saved.from || config.mailFrom || saved.user || config.smtpUser || ''
  };
}
export function saveMailConfig(input = {}) {
  const all = readAll();
  const current = all.mail || {};
  const host = String(input.host ?? current.host ?? '').trim().slice(0, 253);
  const user = String(input.user ?? current.user ?? '').trim().toLowerCase().slice(0, 200);
  const from = String(input.from ?? input.user ?? current.from ?? current.user ?? '').trim().toLowerCase().slice(0, 200);
  const suppliedPass = String(input.pass || '').replace(/\s+/g, '').slice(0, 300);
  const port = Number(input.port ?? current.port ?? 587);
  const secure = input.secure == null ? Boolean(current.secure) : Boolean(input.secure);

  if (host && !HOST.test(host)) throw new Error('El servidor SMTP no es válido.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('El puerto SMTP no es válido.');
  if (user && !EMAIL.test(user)) throw new Error('El correo SMTP no es válido.');
  if (from && !EMAIL.test(from)) throw new Error('El remitente no es válido.');

  const nextPass = suppliedPass || current.pass || '';
  if (host && user && from && !nextPass) {
    throw new Error('Ingrese la contraseña de aplicación del correo. Es obligatoria la primera vez que configura esta cuenta.');
  }

  const next = {
    host,
    port,
    secure,
    user,
    pass: nextPass,
    from
  };
  writeAll({ ...all, mail: next });
  return {
    configured: Boolean(next.host && next.user && next.pass && next.from),
    user: next.user,
    from: next.from,
    host: next.host,
    port: next.port,
    secure: next.secure
  };
}
export function publicIntegrationStatus() {
  const mail = getMailConfig();
  return {
    mail: {
      configured: Boolean(mail.host && mail.user && mail.pass && mail.from),
      user: mail.user,
      from: mail.from,
      host: mail.host,
      port: mail.port,
      secure: mail.secure
    }
  };
}
