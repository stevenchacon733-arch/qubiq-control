import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import { config } from '../config.js';
import { openJson, sealJson } from '../security.js';

const clientPath = resolve(config.dataDir, 'google-oauth-client.enc');
const tokenPath = resolve(config.dataDir, 'google-oauth-token.enc');
const bundledClientPath = resolve(config.rootDir, 'build', 'google-oauth-client.json');
const redirectUri = `http://127.0.0.1:${config.port}/api/google/oauth/callback`;
const states = new Map();
const scopes = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

function readEncrypted(path) {
  if (!existsSync(path)) return null;
  return openJson(readFileSync(path, 'utf8'));
}

function writeEncrypted(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sealJson(value), { encoding: 'utf8', mode: 0o600 });
}
function normalizeClient(raw) {
  const input = raw?.installed || raw;
  if (!raw?.installed || !input.client_id || !input.client_secret) {
    throw new Error('La credencial debe ser un OAuth Client de tipo Aplicación de escritorio.');
  }
  return { clientId: input.client_id, clientSecret: input.client_secret };
}

function clientConfig() {
  const saved = readEncrypted(clientPath);
  if (saved) return saved;
  if (!existsSync(bundledClientPath)) return null;
  try { return normalizeClient(JSON.parse(readFileSync(bundledClientPath, 'utf8'))); }
  catch { return null; }
}

function tokenBundle() {
  return readEncrypted(tokenPath);
}

function buildClient({ withToken = true } = {}) {
  const cfg = clientConfig();
  if (!cfg) throw new Error('Primero cargue la credencial OAuth de Google.');
  const client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, redirectUri);
  const bundle = withToken ? tokenBundle() : null;
  if (bundle?.tokens) client.setCredentials(bundle.tokens);
  client.on('tokens', (fresh) => {
    const current = tokenBundle() || { tokens: {}, account: null };
    writeEncrypted(tokenPath, { ...current, tokens: { ...current.tokens, ...fresh } });
  });
  return client;
}
export function googleOAuthStatus() {
  const client = clientConfig();
  const bundle = tokenBundle();
  return {
    clientInstalled: Boolean(client),
    authorized: Boolean(bundle?.tokens?.refresh_token || bundle?.tokens?.access_token),
    account: bundle?.account || null,
    redirectUri
  };
}

export function saveGoogleOAuthClient(raw) {
  const cfg = normalizeClient(raw);
  writeEncrypted(clientPath, cfg);
  if (existsSync(tokenPath)) unlinkSync(tokenPath);
  return googleOAuthStatus();
}

export function beginGoogleOAuth() {
  const state = randomBytes(24).toString('hex');
  states.set(state, Date.now() + 10 * 60 * 1000);
  const client = buildClient({ withToken: false });
  const url = client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', include_granted_scopes: true,
    scope: scopes, state
  });
  return { url, stateExpiresInSeconds: 600 };
}
export async function completeGoogleOAuth(code, state) {
  const expiresAt = states.get(String(state || ''));
  states.delete(String(state || ''));
  if (!expiresAt || expiresAt < Date.now()) throw new Error('La autorización expiró. Iníciela otra vez desde Qubiq.');
  if (!code) throw new Error('Google no devolvió el código de autorización.');

  const client = buildClient({ withToken: false });
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: client });
  const about = await drive.about.get({ fields: 'user(displayName,emailAddress)' });
  const account = {
    name: about.data.user?.displayName || '',
    email: about.data.user?.emailAddress || ''
  };
  writeEncrypted(tokenPath, { tokens, account });
  return account;
}

export function getGoogleOAuthClient() {
  const status = googleOAuthStatus();
  if (!status.authorized) throw new Error('Google todavía no está autorizado.');
  return buildClient({ withToken: true });
}
