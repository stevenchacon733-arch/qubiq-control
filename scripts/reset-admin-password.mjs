// Restablece la contraseña del Administrador cuando se olvidó.
//
//   node scripts/reset-admin-password.mjs "NuevaContraseña123"
//
// La contraseña vieja no se puede leer (solo se guarda su huella cifrada), así que se reemplaza por una nueva.
// Cierre Qubiq por completo antes de correrlo (clic derecho en el ícono → "Salir completamente").
// Hace un respaldo de la base de datos, cierra las sesiones abiertas y libera bloqueos por intentos fallidos.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const password = process.argv[2];
if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
  console.error('Uso: node scripts/reset-admin-password.mjs "NuevaContraseña123"\nDebe tener al menos 8 caracteres, con letras y números.');
  process.exit(1);
}

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const dataDir = process.env.QUBIQ_DATA_DIR || resolve(process.env.APPDATA || '', 'Qubiq Control', 'data');
process.env.QUBIQ_ROOT_DIR = root;
process.env.QUBIQ_DATA_DIR = dataDir;
const dbPath = resolve(dataDir, 'qubiq.db');
if (!existsSync(dbPath)) { console.error(`No encuentro la base de datos en ${dbPath}`); process.exit(1); }

const running = await new Promise((done) => {
  const socket = createConnection({ port: 3220, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
if (running) {
  console.error('Qubiq Control sigue abierto (puerto 3220 en uso). Ciérrelo con "Salir completamente" desde el ícono junto al reloj y vuelva a correr esto.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = resolve(dataDir, 'backups', `antes-de-cambiar-contrasena-${stamp}`);
mkdirSync(backupDir, { recursive: true });
for (const name of ['qubiq.db', 'qubiq.db-wal', 'qubiq.db-shm']) {
  if (existsSync(resolve(dataDir, name))) copyFileSync(resolve(dataDir, name), resolve(backupDir, name));
}
console.log('Base de datos:', dbPath);
console.log('Respaldo en  :', backupDir);

const { hashSecret, verifySecret } = await import(new URL('../src/security.js', import.meta.url));
const db = new DatabaseSync(dbPath);
const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const set = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

if (!get('admin_password_hash')) { console.error('Esta base de datos no tiene contraseña de administrador: no es la de Qubiq.'); process.exit(1); }
set('admin_password_hash', hashSecret(password));
set('admin_session_nonce', '');
const unlocked = db.prepare("DELETE FROM security_lockouts WHERE scope = 'ADMIN_LOGIN'").run().changes;
const okay = verifySecret(password, get('admin_password_hash'));
const counts = `empleados: ${db.prepare('SELECT COUNT(*) n FROM employees').get().n}, marcas: ${db.prepare('SELECT COUNT(*) n FROM attendance').get().n}`;
db.close();

console.log(`\nContraseña del Administrador cambiada (${okay ? 'verificada' : 'ERROR de verificación'}). Bloqueos liberados: ${unlocked}.`);
console.log(`Tus datos siguen intactos (${counts}).`);
