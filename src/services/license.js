import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from '../config.js';
import { openJson, sealJson, machineId as deriveMachineId } from '../security.js';
import { audit } from '../db.js';

const statePath = resolve(config.dataDir, 'license.enc');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 10 * 24 * 60 * 60 * 1000;
const emptyState = () => ({
  licenseKey: '', machineId: deriveMachineId(), lastCheckAt: null, lastCheckOk: false, lastSuccessAt: null,
  valid: false, expiresAt: null, message: ''
});

let timer = null;
let cache = null;

function readState() {
  if (cache) return cache;
  if (!existsSync(statePath)) return (cache = emptyState());
  try { cache = { ...emptyState(), ...openJson(readFileSync(statePath, 'utf8')), machineId: deriveMachineId() }; }
  catch { cache = emptyState(); }
  return cache;
}

function writeState(next) {
  cache = next;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, sealJson(next), { encoding: 'utf8', mode: 0o600 });
}

function daysBetween(fromIso) {
  if (!fromIso) return null;
  return Math.floor((Date.now() - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000));
}

export function licenseStatus() {
  const state = readState();
  const hasKey = Boolean(state.licenseKey);
  const daysSinceSuccess = state.lastCheckOk ? 0 : daysBetween(state.lastSuccessAt);
  const offlineGraceExpired = hasKey && !state.lastCheckOk && (daysSinceSuccess == null || daysSinceSuccess >= 10);
  const daysRemaining = state.expiresAt ? Math.ceil((new Date(state.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;

  let phase = 'active';
  let banner = null;
  let blockCreateEmployee = false;
  let blockQrGeneration = false;

  if (!hasKey) {
    phase = 'unlicensed';
    banner = { type: 'danger', text: 'Active su licencia de Qubiq Control para crear empleados y generar el QR de asistencia.' };
    blockCreateEmployee = true;
    blockQrGeneration = true;
  } else if (state.lastCheckOk && !state.valid) {
    phase = 'expired';
    banner = { type: 'danger', text: state.message || 'Suscripción vencida. Contacte a Qubiq para renovar su licencia.' };
    blockCreateEmployee = true;
    blockQrGeneration = true;
  } else if (!state.lastCheckOk && offlineGraceExpired) {
    phase = state.lastSuccessAt ? 'offline-grace-expired' : 'unverified';
    banner = { type: 'warn', text: state.lastSuccessAt
      ? `No se pudo verificar la licencia en los últimos ${daysSinceSuccess} días. Verifique la conexión a internet.`
      : 'No se pudo verificar la licencia todavía. Verifique la conexión a internet.' };
  } else if (state.lastCheckOk && state.valid) {
    phase = 'active';
  }

  return {
    hasKey,
    machineId: state.machineId,
    valid: Boolean(state.valid),
    expiresAt: state.expiresAt || null,
    daysRemaining,
    message: state.message || '',
    lastCheckAt: state.lastCheckAt || null,
    lastCheckOk: Boolean(state.lastCheckOk),
    lastSuccessAt: state.lastSuccessAt || null,
    daysSinceSuccess,
    phase,
    banner,
    blockCreateEmployee,
    blockQrGeneration
  };
}

export function licenseGate() {
  const status = licenseStatus();
  return { blockCreateEmployee: status.blockCreateEmployee, blockQrGeneration: status.blockQrGeneration, banner: status.banner };
}

export async function saveLicenseKey(licenseKey) {
  const key = String(licenseKey || '').trim();
  if (!key) throw new Error('Ingrese una licencia válida.');
  writeState({ ...readState(), licenseKey: key, lastCheckOk: false, valid: false, message: '' });
  return checkLicense();
}

export async function checkLicense() {
  const state = readState();
  const now = new Date().toISOString();
  if (!state.licenseKey) {
    writeState({ ...state, lastCheckAt: now, lastCheckOk: false, valid: false, message: 'Sin licencia configurada.' });
    return licenseStatus();
  }
  try {
    const response = await fetch(config.licenseServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: state.licenseKey, machineId: state.machineId }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`El servidor de licencias respondió ${response.status}.`);
    const body = await response.json();
    const valid = Boolean(body.valid);
    writeState({
      ...state,
      lastCheckAt: now,
      lastCheckOk: true,
      lastSuccessAt: now,
      valid,
      expiresAt: body.expiresAt || null,
      message: body.message || ''
    });
    audit('SYSTEM', 'LICENSE_CHECK', 'LICENSE', null, { valid });
  } catch (error) {
    writeState({ ...state, lastCheckAt: now, lastCheckOk: false, message: error.message });
  }
  return licenseStatus();
}

export function startLicenseScheduler() {
  if (timer) return;
  const run = () => checkLicense().catch((error) => console.error('Verificación de licencia:', error.message));
  run();
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopLicenseScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
