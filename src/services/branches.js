// Sucursales del negocio. Es la base del modo multisucursal: cada lector y cada marcación van a quedar
// asociados a una sucursal (ver docs/multisucursal.md). Nunca se borran, solo se desactivan, para que el
// historial que apunte a una sucursal siga siendo legible.
import { db, audit, getSetting } from '../db.js';
import { nowIso } from '../time.js';
import { getCompanyProfile } from './company.js';

const CODE = /^[A-Z0-9]{2,6}$/;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const plain = (value) => String(value).normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase();

// "Aguas Zarcas" -> AGZ, "Venecia" -> VEN. Si ya está tomado se le agrega un número.
export function suggestBranchCode(name, exceptId = null) {
  const words = plain(name).split(' ').filter(Boolean);
  let base = words.length > 1 ? `${words[0].slice(0, 2)}${words[1].slice(0, 1)}` : (words[0] || '').slice(0, 3);
  if (base.length < 2) base = `${base}SUC`.slice(0, 3);
  const taken = new Set(db.prepare('SELECT code FROM branches WHERE id IS NOT ?').all(exceptId).map((row) => row.code.toUpperCase()));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 6 - String(n).length)}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('No se pudo generar un código de sucursal. Escribí uno a mano.');
}

function publicBranch(row) {
  return { id: row.id, name: row.name, code: row.code, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at };
}

function getRow(id) {
  const row = db.prepare('SELECT * FROM branches WHERE id = ?').get(Number(id));
  if (!row) throw new Error('Sucursal no encontrada.');
  return row;
}

function normalize(input, current = null) {
  const name = clean(input.name ?? current?.name, 80);
  if (name.length < 2) throw new Error('Indique el nombre de la sucursal.');
  const typed = clean(input.code ?? '', 6).toUpperCase();
  const code = typed || current?.code || suggestBranchCode(name, current?.id ?? null);
  if (!CODE.test(code)) throw new Error('El código de sucursal debe tener de 2 a 6 letras o números, sin espacios.');
  return { name, code };
}

function friendly(error) {
  const text = String(error.message);
  if (!text.includes('UNIQUE')) return error;
  return new Error(text.includes('code') ? 'Ya existe una sucursal con ese código.' : 'Ya existe una sucursal con ese nombre.');
}

// Las instalaciones que ya venían funcionando tenían una sola sucursal, escrita en "Identidad del negocio".
// Esa pasa a ser la primera sucursal, y más adelante todo lo existente (lectores y marcaciones) queda en ella.
export function ensureDefaultBranch() {
  if (!getSetting('admin_password_hash')) return null;
  const existing = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get();
  if (existing) return existing.id;
  const name = clean(getCompanyProfile().branchName, 80) || 'Sucursal principal';
  const now = nowIso();
  const result = db.prepare('INSERT INTO branches(name, code, created_at, updated_at) VALUES(?, ?, ?, ?)')
    .run(name, suggestBranchCode(name), now, now);
  audit('SYSTEM', 'CREATE', 'BRANCH', result.lastInsertRowid, { name, reason: 'sucursal existente' });
  return Number(result.lastInsertRowid);
}

export function listBranches() {
  ensureDefaultBranch();
  return db.prepare('SELECT * FROM branches ORDER BY active DESC, name COLLATE NOCASE').all().map(publicBranch);
}

export function createBranch(input = {}) {
  ensureDefaultBranch();
  const branch = normalize(input);
  const now = nowIso();
  try {
    const result = db.prepare('INSERT INTO branches(name, code, created_at, updated_at) VALUES(?, ?, ?, ?)')
      .run(branch.name, branch.code, now, now);
    audit('ADMIN', 'CREATE', 'BRANCH', result.lastInsertRowid, branch);
    return publicBranch(getRow(result.lastInsertRowid));
  } catch (error) { throw friendly(error); }
}

export function updateBranch(id, input = {}) {
  const current = getRow(id);
  const branch = normalize(input, current);
  try {
    db.prepare('UPDATE branches SET name = ?, code = ?, updated_at = ? WHERE id = ?').run(branch.name, branch.code, nowIso(), current.id);
  } catch (error) { throw friendly(error); }
  audit('ADMIN', 'UPDATE', 'BRANCH', current.id, branch);
  return publicBranch(getRow(current.id));
}

export function setBranchActive(id, active) {
  const current = getRow(id);
  if (!active && db.prepare('SELECT COUNT(*) AS n FROM branches WHERE active = 1 AND id <> ?').get(current.id).n === 0) {
    throw new Error('Tiene que quedar al menos una sucursal activa.');
  }
  if (!active && db.prepare('SELECT COUNT(*) AS n FROM biometric_devices WHERE branch_id = ? AND active = 1').get(current.id).n > 0) {
    throw new Error('Esa sucursal tiene lectores de huella activos. Desactivalos o pasalos a otra sucursal primero.');
  }
  if (!active && db.prepare('SELECT COUNT(*) AS n FROM branch_agents WHERE branch_id = ? AND active = 1').get(current.id).n > 0) {
    throw new Error('Esa sucursal tiene una computadora conectada activa. Desactivala primero en "Conexión entre sucursales".');
  }
  db.prepare('UPDATE branches SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowIso(), current.id);
  audit('ADMIN', active ? 'ACTIVATE' : 'DEACTIVATE', 'BRANCH', current.id);
  return publicBranch(getRow(current.id));
}
