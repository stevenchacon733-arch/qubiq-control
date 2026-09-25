// Actualizaciones automáticas de Qubiq Control.
//
// La app vive todo el día en la bandeja (cerrar la ventana no la cierra), así que no se puede depender de
// "instalar al salir": casi nunca se sale. En su lugar:
//   1. Busca versiones nuevas al arrancar y cada CHECK_EVERY_MS mientras corre.
//   2. La descarga en segundo plano y avisa en español a qué hora se va a instalar.
//   3. La instala sola a la INSTALL_HOUR (hora local del equipo) y la app se vuelve a abrir en segundos.
// "Salir completamente" desde la bandeja también la instala (autoInstallOnAppQuit).
//
// No importa nada de Electron: todo se inyecta, para poder probarlo con un reloj y un updater falsos
// (ver scripts/update-test.mjs).

export const INSTALL_HOUR = 13;
export const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;
export const TICK_MS = 60 * 1000;

export function installWhenText(date, hour = INSTALL_HOUR) {
  const current = date.getHours();
  if (current === hour) return 'en este momento';
  const label = `a la ${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? 'p. m.' : 'a. m.'}`;
  return current < hour ? `hoy ${label}` : `mañana ${label}`;
}

export function startAutoUpdates({
  updater,
  notify,
  beforeInstall = () => {},
  now = () => new Date(),
  every = setInterval,
  stopEvery = clearInterval,
  log = console
}) {
  let pendingVersion = null;
  let installing = false;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  function tick() {
    if (!pendingVersion || installing) return false;
    if (now().getHours() !== INSTALL_HOUR) return false;
    installing = true;
    try {
      beforeInstall();
      updater.quitAndInstall(true, true);
      return true;
    } catch (error) {
      installing = false;
      log.error?.('[actualizaciones] No se pudo instalar:', error?.message || error);
      return false;
    }
  }

  function check() {
    try {
      const pending = updater.checkForUpdates();
      pending?.catch?.((error) => log.error?.('[actualizaciones] Falló la búsqueda:', error?.message || error));
    } catch (error) {
      log.error?.('[actualizaciones] Falló la búsqueda:', error?.message || error);
    }
  }

  updater.on('update-downloaded', (info) => {
    const version = info?.version || 'nueva';
    if (pendingVersion === version) return;
    pendingVersion = version;
    notify('Actualización lista',
      `Qubiq Control ${version} se va a instalar ${installWhenText(now())}. La app se reinicia sola en unos segundos.`);
    tick();
  });

  updater.on('error', (error) => {
    installing = false;
    log.error?.('[actualizaciones]', error?.message || error);
  });

  check();
  const timers = [every(check, CHECK_EVERY_MS), every(tick, TICK_MS)];

  return {
    tick,
    check,
    stop: () => timers.forEach((timer) => stopEvery(timer)),
    get pendingVersion() { return pendingVersion; },
    get installing() { return installing; }
  };
}
