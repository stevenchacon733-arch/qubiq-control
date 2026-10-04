import { config } from './config.js';

const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone,
  year: 'numeric', month: '2-digit', day: '2-digit'
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone,
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

export const nowIso = () => new Date().toISOString();
export const localDate = (date = new Date()) => {
  const parts = Object.fromEntries(dateFmt.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export const localTime = (date = new Date()) => timeFmt.format(date);
export const localDayOfWeek = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short' }).format(date);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts);
};

export function minutesFromClock(clock) {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

export function localMinutes(date = new Date()) {
  const [h, m] = localTime(date).split(':').map(Number);
  return h * 60 + m;
}

export function minutesBetween(isoStart, isoEnd) {
  return Math.max(0, Math.round((new Date(isoEnd) - new Date(isoStart)) / 60000));
}

const zoneParts = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function zoneOffsetMs(ms) {
  const p = Object.fromEntries(zoneParts.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

// Convierte una hora de reloj local ("YYYY-MM-DD HH:MM:SS") de la zona configurada a un instante real.
export function zonedToDate(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(stamp));
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = wall - zoneOffsetMs(wall);
  return new Date(wall - zoneOffsetMs(first));
}

// Redondeo de una hora de reloj ("HH:MM" o "HH:MM:SS") a la hora entera: 30 minutos o más suben.
// Es la única regla de redondeo: la usan la app, el CSV, Google Sheets y el libro de Excel.
export function roundedClockHour(clock) {
  const [hours, minutes] = String(clock || '').split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours + (minutes >= 30 ? 1 : 0);
}

export function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
