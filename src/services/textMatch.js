// Variantes de escritura que deben considerarse el mismo nombre al buscar
// archivos y carpetas en Drive. En Costa Rica el mes se escribe "Setiembre",
// pero muchas plantillas quedaron guardadas como "Septiembre".
const ALIASES = [
  [/SEPTIEMBRE/g, 'SETIEMBRE']
];

export const MONTHS = Object.freeze(['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre']);

export function normalizeName(value = '') {
  let text = String(value).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  for (const [pattern, replacement] of ALIASES) text = text.replace(pattern, replacement);
  return text;
}
