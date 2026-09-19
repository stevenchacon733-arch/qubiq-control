import express from 'express';
import QRCode from 'qrcode';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { getSetting, setSetting, audit } from './db.js';
import { createAdminSession, createAttendanceToken, createKioskSession, hashSecret, verifySecret, verifyToken } from './security.js';
import { localDate } from './time.js';
import {
  createEmployee, createSchedule, dailyOverview, listEmployees, listSchedules, updateSchedule,
  archiveEmployee, markAttendance, payrollRows, payrollSyncRows, setDayStatus, setEmployeeActive, updateEmployee
} from './services/attendance.js';
import { isGoogleSheetsConfigured, syncPayrollRows, uploadBackupToDrive } from './services/googleSheets.js';
import { beginGoogleOAuth, completeGoogleOAuth, googleOAuthStatus, saveGoogleOAuthClient } from './services/googleAuth.js';
import { isMailConfigured, mailQueueStats, queueAttendanceConfirmation, resetMailTransport, sendTestMail, startMailWorker, stopMailWorker } from './services/mail.js';
import { getCompanyProfile, saveCompanyProfile } from './services/company.js';
import { publicIntegrationStatus, saveMailConfig } from './services/integrationConfig.js';
import { assertNotLocked, guardConfig, registerFailure, resetFailures } from './services/guard.js';
import { backupStatus, createBackup, startBackupScheduler, stopBackupScheduler } from './services/backup.js';
import { checkLicense, licenseGate, licenseStatus, saveLicenseKey, startLicenseScheduler, stopLicenseScheduler } from './services/license.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
app.use((req, _res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) req.body = {};
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});
function isAdminSurface(path = '') {
  return path === '/' || path === '/admin.html' || path === '/admin.js' || path === '/admin-extra.css' ||
    path === '/kiosk.html' || path === '/kiosk.js' ||
    (path === '/setup.html' || path === '/setup.js') || path.startsWith('/api/admin') || path.startsWith('/api/auth') ||
    path.startsWith('/api/google/oauth') || path === '/api/setup' || path === '/api/status';
}

app.use((req, res, next) => {
  if (isAdminSurface(req.path) && !isLoopback(clientIp(req))) {
    return res.status(403).type('text').send('Administración disponible solo desde la computadora Qubiq.');
  }
  next();
});

app.use(express.static(config.publicDir, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
}));

const parseCookies = (header = '') => Object.fromEntries(header.split(';').filter(Boolean).map(part => {
  const [k, ...v] = part.trim().split('=');
  return [k, decodeURIComponent(v.join('='))];
}));

function requireAdmin(req, res, next) {
  const token = parseCookies(req.headers.cookie).qubiq_session;
  const payload = verifyToken(token, 'admin');
  const activeNonce = getSetting('admin_session_nonce');
  if (!payload || !activeNonce || payload.nonce !== activeNonce) return res.status(401).json({ error: 'Sesión requerida.' });
  req.adminSession = payload;
  next();
}

function currentRole(req) {
  const token = parseCookies(req.headers.cookie).qubiq_session;
  const adminPayload = verifyToken(token, 'admin');
  if (adminPayload && adminPayload.nonce === getSetting('admin_session_nonce')) return 'admin';
  const kioskPayload = verifyToken(token, 'kiosk');
  if (kioskPayload && kioskPayload.nonce === getSetting('kiosk_session_nonce')) return 'kiosk';
  return null;
}

function requireAdminOrKiosk(req, res, next) {
  if (!currentRole(req)) return res.status(401).json({ error: 'Sesión requerida.' });
  next();
}

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace('::ffff:', '');
}

function isLoopback(ip = '') {
  const value = String(ip).replace('::ffff:', '');
  return value === '::1' || value === '127.0.0.1';
}

function isPrivateIp(ip = '') {
  const value = ip.replace('::ffff:', '');
  return value === '::1' || value === '127.0.0.1' || value.startsWith('10.') || value.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

function requireLan(req, res, next) {
  if (!config.requireLan || isPrivateIp(req.socket.remoteAddress)) return next();
  return res.status(403).json({ error: 'Las marcaciones solo se permiten desde la red local de Qubiq.' });
}

function lanAddress() {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((net) => net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);

  const preferred = addresses.find((ip) => ip.startsWith('192.168.'))
    || addresses.find((ip) => ip.startsWith('10.'))
    || addresses.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
    || addresses[0];
  return preferred ? `http://${preferred}:${config.port}` : `http://localhost:${config.port}`;
}

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const api = express.Router();

api.get('/status', (_req, res) => res.json({
  setupRequired: !getSetting('admin_password_hash'),
  kioskEnabled: Boolean(getSetting('kiosk_password_hash')),
  googleSheetsConfigured: isGoogleSheetsConfigured(),
  lanUrl: lanAddress(),
  today: localDate(),
  qrTtlSeconds: config.qrTtlSeconds,
  company: getCompanyProfile()
}));
api.get('/branding', (_req, res) => {
  const company = getCompanyProfile();
  res.json({
    appName: company.appName,
    businessName: company.businessName,
    branchName: company.branchName
  });
});

api.post('/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.status(409).json({ error: 'La configuración inicial ya fue realizada.' });
  const password = String(req.body.password || '');
  const businessName = String(req.body.businessName || '').trim();
  const adminEmail = String(req.body.adminEmail || '').trim();
  const mailInput = req.body.mail && typeof req.body.mail === 'object' ? req.body.mail : null;
  if (mailInput) {
    const mailUser = String(mailInput.user || '').trim();
    const mailHost = String(mailInput.host || '').trim();
    const mailPass = String(mailInput.pass || '').trim();
    const mailPort = Number(mailInput.port || 587);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailUser)) return res.status(400).json({ error: 'El correo automático de asistencia no es válido.' });
    if (!mailHost || mailHost.length > 200) return res.status(400).json({ error: 'El servidor SMTP no es válido.' });
    if (!Number.isInteger(mailPort) || mailPort < 1 || mailPort > 65535) return res.status(400).json({ error: 'El puerto SMTP no es válido.' });
    if (mailPass.length < 4) return res.status(400).json({ error: 'La contraseña de aplicación del correo automático no es válida.' });
  }
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return res.status(400).json({ error: 'Use una contraseña de al menos 10 caracteres que incluya letras y números.' });
  if (businessName.length < 2) return res.status(400).json({ error: 'Indique el nombre del negocio.' });
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return res.status(400).json({ error: 'El correo del administrador no es válido.' });
  setSetting('admin_password_hash', hashSecret(password));
  const company = saveCompanyProfile(req.body, 'SYSTEM');
  const mail = mailInput ? saveMailConfig(mailInput) : null;
  audit('SYSTEM', 'INITIAL_SETUP', 'SETTINGS', null, { businessName: company.businessName });
  const token = createAdminSession();
  const session = verifyToken(token, 'admin');
  setSetting('admin_session_nonce', session.nonce);
  res.setHeader('Set-Cookie', `qubiq_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; Priority=High`);
  res.json({ ok: true, company, mailConfigured: Boolean(mail?.configured) });
});

api.post('/auth/login', (req, res) => {
  const role = req.body.role === 'kiosk' ? 'kiosk' : 'admin';
  const key = `${clientIp(req)}:${role}`;
  try { assertNotLocked('ADMIN_LOGIN', key); }
  catch (error) { return res.status(429).json({ error: error.message }); }
  const hash = getSetting(role === 'kiosk' ? 'kiosk_password_hash' : 'admin_password_hash');
  if (!hash || !verifySecret(req.body.password, hash)) {
    const state = registerFailure('ADMIN_LOGIN', key);
    const message = state.locked
      ? 'Demasiados intentos. Acceso bloqueado por 1 hora.'
      : `Contraseña incorrecta. Quedan ${state.remainingAttempts} intentos.`;
    return res.status(state.locked ? 429 : 401).json({ error: message });
  }
  resetFailures('ADMIN_LOGIN', key);
  const token = role === 'kiosk' ? createKioskSession() : createAdminSession();
  const session = verifyToken(token, role);
  setSetting(role === 'kiosk' ? 'kiosk_session_nonce' : 'admin_session_nonce', session.nonce);
  const maxAge = role === 'kiosk' ? 30 * 24 * 60 * 60 : 28800;
  res.setHeader('Set-Cookie', `qubiq_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}; Priority=High`);
  audit(role === 'kiosk' ? 'KIOSK' : 'ADMIN', 'LOGIN', 'SESSION');
  res.json({ ok: true, role });
});

api.post('/auth/logout', (req, res) => {
  const role = currentRole(req);
  if (role === 'kiosk') setSetting('kiosk_session_nonce', '');
  else setSetting('admin_session_nonce', '');
  audit(role === 'kiosk' ? 'KIOSK' : 'ADMIN', 'LOGOUT', 'SESSION');
  res.setHeader('Set-Cookie', 'qubiq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High');
  res.json({ ok: true });
});

api.get('/auth/me', (req, res) => {
  const role = currentRole(req);
  if (!role) return res.status(401).json({ error: 'Sesión requerida.' });
  res.json({ authenticated: true, role });
});
api.get('/admin/overview', requireAdmin, (req, res) => res.json(dailyOverview(req.query.date || localDate())));
api.get('/admin/system', requireAdmin, (_req, res) => res.json({
  mailConfigured: isMailConfigured(),
  googleSheetsConfigured: isGoogleSheetsConfigured(),
  googleOAuth: googleOAuthStatus(),
  mailQueue: mailQueueStats(),
  backup: backupStatus(),
  license: licenseStatus(),
  kioskEnabled: Boolean(getSetting('kiosk_password_hash')),
  security: guardConfig
}));

api.post('/admin/kiosk', requireAdmin, (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Use una contraseña de kiosco de al menos 6 caracteres.' });
  setSetting('kiosk_password_hash', hashSecret(password));
  setSetting('kiosk_session_nonce', '');
  audit('ADMIN', 'KIOSK_PASSWORD_SET', 'SETTINGS');
  res.json({ ok: true, kioskEnabled: true });
});

api.post('/admin/kiosk/disable', requireAdmin, (_req, res) => {
  setSetting('kiosk_password_hash', '');
  setSetting('kiosk_session_nonce', '');
  audit('ADMIN', 'KIOSK_DISABLED', 'SETTINGS');
  res.json({ ok: true, kioskEnabled: false });
});

api.get('/admin/license/status', requireAdmin, (_req, res) => res.json(licenseStatus()));

api.post('/admin/license', requireAdmin, async (req, res) => {
  try {
    const license = await saveLicenseKey(req.body.licenseKey);
    audit('ADMIN', 'LICENSE_ACTIVATE', 'LICENSE', null, { valid: license.valid });
    res.json({ ok: true, license });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

api.post('/admin/license/recheck', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, license: await checkLicense() }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

api.get('/admin/settings', requireAdmin, (_req, res) => res.json({
  company: getCompanyProfile(),
  integrations: publicIntegrationStatus(),
  googleOAuth: googleOAuthStatus(),
  googleSheetsConfigured: isGoogleSheetsConfigured(),
  kioskEnabled: Boolean(getSetting('kiosk_password_hash'))
}));
api.patch('/admin/company', requireAdmin, (req, res) => {
  try { res.json({ ok: true, company: saveCompanyProfile(req.body, 'ADMIN') }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
api.patch('/admin/mail', requireAdmin, (req, res) => {
  try {
    const mail = saveMailConfig(req.body);
    resetMailTransport();
    audit('ADMIN', 'MAIL_SETTINGS_UPDATE', 'SETTINGS');
    res.json({ ok: true, mail });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
api.post('/admin/mail/test', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await sendTestMail(req.body.to)) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

api.post('/admin/google/client', requireAdmin, (req, res) => {
  try { res.json({ ok: true, googleOAuth: saveGoogleOAuthClient(req.body.credentials) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

api.post('/admin/google/oauth/start', requireAdmin, (_req, res) => {
  try { res.json(beginGoogleOAuth()); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

api.get('/google/oauth/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(`Google canceló la autorización: ${req.query.error}`);
    await completeGoogleOAuth(String(req.query.code || ''), String(req.query.state || ''));
    res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>Qubiq</title></head><body style="font-family:system-ui;background:#07140e;color:#eef7f2;padding:40px"><h1>Google conectado ✓</h1><p>Qubiq Control ya puede usar Google Sheets y Google Drive.</p><p>Podés cerrar esta pestaña y volver a la aplicación.</p></body></html>');
  } catch (error) {
    res.status(400).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Qubiq</title></head><body style="font-family:system-ui;padding:40px"><h1>No se pudo conectar Google</h1><p>${String(error.message).replace(/[<>&]/g, '')}</p></body></html>`);
  }
});

api.post('/admin/backup', requireAdmin, async (_req, res) => {
  try {
    const backup = createBackup('manual');
    let cloud = { uploaded: false, reason: 'google-not-configured' };
    if (isGoogleSheetsConfigured()) {
      try { cloud = await uploadBackupToDrive(backup.path, `BACKUP-${backup.fileName}`); }
      catch (error) { cloud = { uploaded: false, reason: error.message }; }
    }
    res.json({ ok: true, backup, cloud });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
api.get('/admin/employees', requireAdmin, (_req, res) => res.json(listEmployees()));
api.post('/admin/employees', requireAdmin, (req, res) => {
  const gate = licenseGate();
  if (gate.blockCreateEmployee) return res.status(402).json({ error: gate.banner?.text || 'La licencia no está activa.' });
  try { res.status(201).json({ id: createEmployee(req.body) }); }
  catch (e) { res.status(400).json({ error: String(e.message).includes('UNIQUE') ? 'Ese código de empleado ya existe.' : e.message }); }
});
api.patch('/admin/employees/:id', requireAdmin, (req, res) => {
  try {
    updateEmployee(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    const duplicate = String(e.message).includes('UNIQUE');
    res.status(400).json({ error: duplicate ? 'Ese código de marcación ya pertenece a otro empleado.' : e.message });
  }
});
api.patch('/admin/employees/:id/active', requireAdmin, (req, res) => {
  try { setEmployeeActive(req.params.id, Boolean(req.body.active)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
api.delete('/admin/employees/:id', requireAdmin, (req, res) => {
  try { archiveEmployee(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
api.get('/admin/schedules', requireAdmin, (_req, res) => res.json(listSchedules()));
api.post('/admin/schedules', requireAdmin, (req, res) => {
  try { res.status(201).json({ id: createSchedule(req.body) }); }
  catch (e) { res.status(400).json({ error: String(e.message).includes('UNIQUE') ? 'Ya existe un horario con ese nombre.' : e.message }); }
});
api.patch('/admin/schedules/:id', requireAdmin, (req, res) => {
  try { res.json({ ok: true, schedule: updateSchedule(req.params.id, req.body) }); }
  catch (e) { res.status(400).json({ error: String(e.message).includes('UNIQUE') ? 'Ya existe un horario con ese nombre.' : e.message }); }
});

api.get('/admin/payroll', requireAdmin, (req, res) => {
  const from = String(req.query.from || localDate());
  const to = String(req.query.to || from);
  res.json(payrollRows(from, to));
});

api.get('/admin/payroll/review', requireAdmin, (req, res) => {
  const from = String(req.query.from || localDate());
  const to = String(req.query.to || from);
  const rows = payrollSyncRows(from, to);
  res.json(rows.review || { unresolvedWeeks: [], workedSevenDays: [], conflicts: [] });
});

api.post('/admin/day-status', requireAdmin, (req, res) => {
  try {
    setDayStatus(req.body.employeeId, String(req.body.workDate || ''), String(req.body.status || 'REST'), req.body.note || '');
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

api.get('/admin/payroll.csv', requireAdmin, (req, res) => {
  const from = String(req.query.from || localDate());
  const to = String(req.query.to || from);
  const rows = payrollRows(from, to);
  const headers = ['Fecha','Código','Cédula','Empleado','Puesto','Entrada','Salida','Estado entrada','Tardanza (min)','Horas trabajadas'];
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = [headers, ...rows.map(r => [r.fecha,r.codigo,r.cedula,r.empleado,r.puesto,r.entrada,r.salida,r.estadoEntrada,r.tardanzaMin,r.horasTrabajadas])]
    .map(row => row.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qubiq-planilla-${from}-${to}.csv"`);
  res.send('\ufeff' + csv);
});

api.post('/admin/sync/google-sheets', requireAdmin, async (req, res) => {
  try {
    const from = String(req.body.from || localDate());
    const to = String(req.body.to || from);
    const rows = payrollSyncRows(from, to);
    const review = rows.review || { unresolvedWeeks: [], workedSevenDays: [], conflicts: [] };
    const openRows = rows.filter(row => !row.descanso && row.entrada && !row.salida);
    if (review.unresolvedWeeks?.length) {
      throw new Error(`Hay ${review.unresolvedWeeks.length} semana(s) con descanso por confirmar. Resolvelas antes de sincronizar.`);
    }
    if (review.conflicts?.length) {
      throw new Error(`Hay ${review.conflicts.length} conflicto(s) entre asistencia y descanso. Revisalos antes de sincronizar.`);
    }
    if (openRows.length) {
      throw new Error(`Hay ${openRows.length} jornada(s) con entrada pero sin salida. Corregilas antes de sincronizar.`);
    }
    const result = await syncPayrollRows(rows, { from, to });
    audit('ADMIN', 'SYNC', 'GOOGLE_SHEETS', null, { from, to, ...result,
      unresolvedWeeks: review.unresolvedWeeks.length, workedSevenDays: review.workedSevenDays.length });
    res.json({ ok: true, ...result, review });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.get('/admin/qr.png', requireAdminOrKiosk, async (_req, res) => {
  const gate = licenseGate();
  if (gate.blockQrGeneration) return res.status(402).json({ error: gate.banner?.text || 'La licencia no está activa.' });
  const token = createAttendanceToken();
  const url = `${lanAddress()}/mark.html?token=${encodeURIComponent(token)}`;
  res.type('png').send(await QRCode.toBuffer(url, { width: 420, margin: 2, errorCorrectionLevel: 'M' }));
});

api.get('/attendance/token-info', requireLan, (req, res) => {
  const payload = verifyToken(req.query.token, 'attendance');
  if (!payload) return res.status(400).json({ error: 'Este QR venció. Escanee el QR actual.' });
  res.json({ valid: true, expiresAt: payload.exp });
});

api.post('/attendance/mark', requireLan, async (req, res) => {
  const payload = verifyToken(req.body.token, 'attendance');
  if (!payload) return res.status(400).json({ error: 'El QR venció. Escanee el QR que aparece actualmente.' });
  const code = String(req.body.employeeCode || '').trim().toUpperCase();
  const key = `${clientIp(req)}|${code}`;
  try { assertNotLocked('EMPLOYEE_PIN', key); }
  catch (error) { return res.status(429).json({ error: error.message }); }
  try {
    const result = markAttendance({ tokenPayload: payload, employeeCode: code, pin: req.body.pin });
    resetFailures('EMPLOYEE_PIN', key);
    const { notificationEmail, date, ...publicResult } = result;
    const queued = notificationEmail
      ? queueAttendanceConfirmation({ to: notificationEmail, employee: result.employee,
          eventType: result.eventType, date, time: result.time })
      : { queued: false, reason: 'no-email' };
    return res.json({ ...publicResult, emailQueued: Boolean(queued.queued) });
  } catch (e) {
    if (e.message === 'Código o PIN incorrecto.') {
      const state = registerFailure('EMPLOYEE_PIN', key);
      const message = state.locked
        ? 'Demasiados intentos. Este acceso quedó bloqueado por 1 hora.'
        : `Código o PIN incorrecto. Quedan ${state.remainingAttempts} intentos.`;
      return res.status(state.locked ? 429 : 400).json({ error: message });
    }
    return res.status(400).json({ error: e.message });
  }
});

app.use('/api', api);
app.get('/', (_req, res) => res.redirect('/admin.html'));
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del sistema.' });
});

export function startServer({ quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, '0.0.0.0', () => {
      if (!quiet) {
        console.log(`\nQubiq Control`);
        console.log(`Administrador: http://localhost:${config.port}`);
        console.log(`Red local:     ${lanAddress()}`);
        console.log(`Zona horaria:  ${config.timezone}\n`);
      }
      startMailWorker();
      startBackupScheduler();
      startLicenseScheduler();
      server.once('close', () => { stopMailWorker(); stopBackupScheduler(); stopLicenseScheduler(); });
      resolve(server);
    });
    server.once('error', reject);
  });
}

const launchedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (launchedDirectly) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
