import nodemailer from 'nodemailer';
import { db, audit } from '../db.js';
import { nowIso } from '../time.js';
import { getCompanyProfile } from './company.js';
import { getMailConfig } from './integrationConfig.js';

let transporter = null;
let transporterSignature = '';
let workerTimer = null;
let kickTimer = null;
let processing = false;
let stopping = false;

export function isMailConfigured() {
  const cfg = getMailConfig();
  return Boolean(cfg.host && cfg.user && cfg.pass && cfg.from);
}

function mailer() {
  const cfg = getMailConfig();
  const signature = JSON.stringify([cfg.host,cfg.port,cfg.secure,cfg.user,cfg.from]);
  if (!transporter || signature !== transporterSignature) {
    transporterSignature = signature;
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  }
  return transporter;
}

function messageFor({ employee, eventType, date, time }) {
  const type = eventType === 'ENTRY' ? 'Entrada' : 'Salida';
  const company = getCompanyProfile();
  return {
    subject: `${company.businessName} · ${type} registrada | Qubiq Control`,
    text: `${employee}, tu ${type.toLowerCase()} fue registrada el ${date} a las ${time}.\n\nQubiq Control · Tu equipo. Tu tiempo. Bajo control.`
  };
}

export function queueAttendanceConfirmation({ to, employee, eventType, date, time }) {
  if (!to) return { queued: false, reason: 'no-email' };
  const created = nowIso();
  const result = db.prepare(`INSERT INTO mail_queue(to_email, employee_name, event_type, work_date, local_time,
                         status, attempts, next_attempt_at, created_at)
                         VALUES(?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`) 
    .run(String(to).trim().toLowerCase(), employee, eventType, date, time, created, created);
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = setTimeout(() => { kickTimer = null; if (!stopping) void processMailQueue(); }, 50);
  return { queued: true, id: Number(result.lastInsertRowid) };
}

export async function sendAttendanceConfirmation({ to, employee, eventType, date, time }) {
  if (!to || !isMailConfigured()) return { sent: false, reason: 'not-configured' };
  const cfg = getMailConfig();
  const message = messageFor({ employee, eventType, date, time });
  await mailer().sendMail({ from: cfg.from, to, ...message });
  return { sent: true };
}

export async function processMailQueue() {
  if (stopping || processing || !isMailConfigured()) return;
  processing = true;
  try {
    const now = nowIso();
    const jobs = db.prepare(`SELECT * FROM mail_queue
      WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= ?
      ORDER BY id LIMIT 10`).all(now);
    for (const job of jobs) {
      try {
        await sendAttendanceConfirmation({ to: job.to_email, employee: job.employee_name,
          eventType: job.event_type, date: job.work_date, time: job.local_time });
        if (stopping) break;
        db.prepare("UPDATE mail_queue SET status='SENT', sent_at=?, attempts=attempts+1, last_error='' WHERE id=?")
          .run(nowIso(), job.id);
        audit('SYSTEM', 'MAIL_SENT', 'MAIL_QUEUE', job.id, { eventType: job.event_type, date: job.work_date });
      } catch (error) {
        if (stopping) break;
        const attempts = Number(job.attempts || 0) + 1;
        const finalFailure = attempts >= 5;
        const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 5));
        const next = new Date(Date.now() + delayMinutes * 60000).toISOString();
        db.prepare('UPDATE mail_queue SET status=?, attempts=?, next_attempt_at=?, last_error=? WHERE id=?')
          .run(finalFailure ? 'FAILED' : 'RETRY', attempts, next, String(error.message || error).slice(0, 500), job.id);
        audit('SYSTEM', 'MAIL_FAILED', 'MAIL_QUEUE', job.id, { attempts, finalFailure });
      }
    }
  } finally {
    processing = false;
  }
}

export function mailQueueStats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS total FROM mail_queue GROUP BY status').all();
  return Object.fromEntries(rows.map(row => [row.status, Number(row.total)]));
}

export function resetMailTransport() {
  transporter = null;
  transporterSignature = '';
}
export function startMailWorker() {
  stopping = false;
  if (workerTimer) return;
  void processMailQueue();
  workerTimer = setInterval(() => { void processMailQueue(); }, 30000);
  workerTimer.unref?.();
}

export function stopMailWorker() {
  stopping = true;
  if (workerTimer) clearInterval(workerTimer);
  if (kickTimer) clearTimeout(kickTimer);
  workerTimer = null;
  kickTimer = null;
}
export async function sendTestMail(to) {
  if (!isMailConfigured()) throw new Error('Primero configure el correo saliente.');
  const cfg = getMailConfig();
  const company = getCompanyProfile();
  const destination = String(to || cfg.user).trim();
  if (!destination || !destination.includes('@')) throw new Error('Indique un correo de prueba válido.');
  await mailer().sendMail({
    from: cfg.from,
    to: destination,
    subject: `${company.businessName} · Prueba de correo | Qubiq Control`,
    text: `La conexión de correo de Qubiq Control está funcionando correctamente para ${company.businessName}.`
  });
  return { sent: true, to: destination };
}
