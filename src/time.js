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
