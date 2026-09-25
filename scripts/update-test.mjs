import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CHECK_EVERY_MS, INSTALL_HOUR, TICK_MS, installWhenText, startAutoUpdates } from '../desktop/updates.js';

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute);

function setup({ start = at(1, 9), checkResult = Promise.resolve(null) } = {}) {
  let clock = start;
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = () => { updater.checks += 1; return typeof checkResult === 'function' ? checkResult() : checkResult; };
  updater.quitAndInstall = (...args) => { updater.installs.push(args); };
  const notifications = [];
  const events = [];
  const timers = [];
  const errors = [];
  const handle = startAutoUpdates({
    updater,
    notify: (title, body) => notifications.push({ title, body }),
    beforeInstall: () => events.push('beforeInstall'),
    now: () => clock,
    every: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    stopEvery: () => {},
    log: { error: (...args) => errors.push(args.join(' ')) }
  });
  return { updater, notifications, events, timers, errors, handle, setClock: (value) => { clock = value; } };
}

assert.equal(INSTALL_HOUR, 13, 'La instalación automática debe ser a la 1 de la tarde.');
assert.equal(installWhenText(at(1, 9)), 'hoy a la 1:00 p. m.');
assert.equal(installWhenText(at(1, 12, 59)), 'hoy a la 1:00 p. m.');
assert.equal(installWhenText(at(1, 13, 30)), 'en este momento');
assert.equal(installWhenText(at(1, 15)), 'mañana a la 1:00 p. m.');

{
  const t = setup();
  assert.equal(t.updater.autoDownload, true);
  assert.equal(t.updater.autoInstallOnAppQuit, true, '"Salir completamente" también debe instalar.');
  assert.equal(t.updater.checks, 1, 'Debe buscar actualizaciones al arrancar.');
  assert.deepEqual(t.timers.map(timer => timer.ms).sort((a, b) => a - b), [TICK_MS, CHECK_EVERY_MS].sort((a, b) => a - b));
  t.timers.find(timer => timer.ms === CHECK_EVERY_MS).fn();
  assert.equal(t.updater.checks, 2, 'Debe volver a buscar periódicamente mientras corre.');

  // Descarga a las 10:00: avisa en español y espera a la 1 p. m.
  t.setClock(at(1, 10));
  t.updater.emit('update-downloaded', { version: '1.0.6' });
  assert.equal(t.notifications.length, 1);
  assert.match(t.notifications[0].body, /Qubiq Control 1\.0\.6 se va a instalar hoy a la 1:00 p\. m\./);
  assert.equal(t.updater.installs.length, 0, 'No debe instalar antes de la 1 p. m.');

  t.updater.emit('update-downloaded', { version: '1.0.6' });
  assert.equal(t.notifications.length, 1, 'No debe repetir el aviso de la misma versión.');

  t.setClock(at(1, 12, 59));
  assert.equal(t.handle.tick(), false);
  assert.equal(t.updater.installs.length, 0);

  t.setClock(at(1, 13, 0));
  const tick = t.timers.find(timer => timer.ms === TICK_MS).fn;
  tick();
  assert.deepEqual(t.updater.installs, [[true, true]], 'Debe instalar en silencio y volver a abrir la app.');
  assert.deepEqual(t.events, ['beforeInstall']);

  t.setClock(at(1, 13, 1));
  tick();
  assert.equal(t.updater.installs.length, 1, 'No debe lanzar la instalación dos veces.');
}

{
  // Descarga en plena hora de instalación: se instala de una vez.
  const t = setup({ start: at(2, 13, 20) });
  t.updater.emit('update-downloaded', { version: '1.0.7' });
  assert.match(t.notifications[0].body, /en este momento/);
  assert.equal(t.updater.installs.length, 1);
}

{
  // Descarga en la tarde: queda para mañana a la 1 p. m.
  const t = setup({ start: at(3, 15) });
  t.updater.emit('update-downloaded', { version: '1.0.8' });
  assert.match(t.notifications[0].body, /mañana a la 1:00 p\. m\./);
  t.setClock(at(3, 23, 59));
  t.handle.tick();
  t.setClock(at(4, 8));
  t.handle.tick();
  assert.equal(t.updater.installs.length, 0);
  t.setClock(at(4, 13, 5));
  t.handle.tick();
  assert.equal(t.updater.installs.length, 1);
}

{
  // Si lanzar el instalador falla, lo reintenta en el siguiente minuto.
  const t = setup({ start: at(5, 13) });
  let fail = true;
  t.updater.quitAndInstall = (...args) => {
    if (fail) { fail = false; throw new Error('instalador ocupado'); }
    t.updater.installs.push(args);
  };
  t.updater.emit('update-downloaded', { version: '1.0.9' });
  assert.equal(t.updater.installs.length, 0);
  assert.match(t.errors.join('\n'), /instalador ocupado/);
  t.setClock(at(5, 13, 1));
  t.handle.tick();
  assert.equal(t.updater.installs.length, 1);
}

{
  // Sin internet: la búsqueda falla sin tumbar la app.
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  const t = setup({ checkResult: () => Promise.reject(new Error('sin conexión')) });
  await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null, 'Un error de red no debe quedar como promesa rechazada sin manejar.');
  assert.match(t.errors.join('\n'), /sin conexión/);
  t.updater.emit('error', new Error('feed caído'));
  assert.match(t.errors.join('\n'), /feed caído/);
}

console.log('UPDATE_TEST_OK');
