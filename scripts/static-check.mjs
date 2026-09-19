import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const ignored = new Set(['node_modules', 'release', '.git']);
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json']);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (ignored.has(name) || name.startsWith('.smoke-')) continue;
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (sourceExtensions.has(extname(path).toLowerCase())) files.push(path);
  }
}
for (const dir of ['desktop','src','public']) walk(resolve(root, dir));

const text = files.map((path) => `${path}\n${readFileSync(path, 'utf8')}`).join('\n');
assert.equal(/FARMACOVA/i.test(text), false, 'Quedó una referencia a FARMACOVA en Qubiq Control.');
assert.equal(/nodeIntegration\s*:\s*true/i.test(text), false, 'nodeIntegration no puede estar habilitado.');
assert.equal(/contextIsolation\s*:\s*false/i.test(text), false, 'contextIsolation no puede estar deshabilitado.');
assert.equal(/webSecurity\s*:\s*false/i.test(text), false, 'webSecurity no puede estar deshabilitado.');
assert.equal(/allowRunningInsecureContent\s*:\s*true/i.test(text), false, 'No se permite contenido inseguro.');
assert.equal(/[ÃÂ�]/.test(text), false, 'Se detectó texto con codificación dañada.');
assert.equal(/\beval\s*\(|new\s+Function\s*\(/.test(text), false, 'Se detectó ejecución dinámica de código.');
for (const path of files.filter((file) => ['.js', '.mjs', '.cjs'].includes(extname(file).toLowerCase()))) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Error de sintaxis en ${path}:\n${result.stderr}`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(packageJson.build?.productName, 'Qubiq Control');
assert.equal(packageJson.build?.win?.icon, 'build/icon.ico');
assert.ok(packageJson.build?.appId);
assert.ok(readFileSync(resolve(root, 'src/server.js'), 'utf8').includes('Content-Security-Policy'));
assert.ok(readFileSync(resolve(root, 'desktop/main.js'), 'utf8').includes('sandbox: true'));
assert.ok(readFileSync(resolve(root, 'src/server.js'), 'utf8').includes('Array.isArray(req.body)'));
assert.ok(readFileSync(resolve(root, 'public/setup.html'), 'utf8').includes('Correo automático de asistencia'));

console.log(`STATIC_CHECK_OK files=${files.length}`);
