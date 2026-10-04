import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

const rootDir = resolve(process.env.QUBIQ_ROOT_DIR || '.');
const dataDir = resolve(process.env.QUBIQ_DATA_DIR || resolve(rootDir, 'data'));
const envPaths = [resolve(dataDir, '.env'), resolve(rootDir, '.env')];
for (const envPath of envPaths) {
  if (existsSync(envPath)) { loadEnvFile(envPath); break; }
}

let version = '0.0.0';
try { version = String(JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version || version); } catch { /* sin package.json a la vista */ }

const bool = (value, fallback) => value == null ? fallback : String(value).toLowerCase() === 'true';
const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || resolve(dataDir, 'google-service-account.json');

export const config = Object.freeze({
  rootDir,
  dataDir,
  version,
  publicDir: resolve(rootDir, 'public'),
  port: Number(process.env.PORT || 3220),
  // Puerto aparte por el que la central recibe las marcaciones de las otras sucursales. Es el único que se
  // publica hacia afuera: por él no se sirve el panel ni ninguna otra cosa.
  agentPort: Number(process.env.AGENT_PORT || 3221),
  // Cada cuánto una sucursal le avisa a la central que sigue viva y cómo están sus lectores.
  linkHeartbeatMs: Math.max(1, Number(process.env.LINK_HEARTBEAT_SECONDS || 60)) * 1000,
  timezone: process.env.TIMEZONE || 'America/Costa_Rica',
  qrTtlSeconds: Number(process.env.QR_TTL_SECONDS || 45),
  requireLan: bool(process.env.REQUIRE_LAN, true),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  dbPath: resolve(dataDir, 'qubiq.db'),
  secretPath: resolve(dataDir, 'app.secret'),
  googleSheetsId: process.env.GOOGLE_SHEETS_ID || '',
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  googleTemplateSheetsId: process.env.GOOGLE_TEMPLATE_SHEETS_ID || '',
  googleServiceAccountJson: serviceAccountPath,
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: bool(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  licenseServerUrl: (process.env.LICENSE_SERVER_URL || 'https://licenciasqbiq.vercel.app/api/license/verify').replace(/\/$/, '')
});
