import { app, BrowserWindow, dialog, shell, Tray, Menu, Notification, session } from 'electron';
import electronUpdater from 'electron-updater';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startAutoUpdates } from './updates.js';

const { autoUpdater } = electronUpdater;
const PORT = 3220;
const HIDDEN_RESTART_MAX_AGE_MS = 10 * 60 * 1000;
let startHidden = process.argv.includes('--background');
let mainWindow;
let server;
let tray;
let quitting = false;

app.setName('Qubiq Control');
// Debe coincidir con build.appId: Windows solo muestra las notificaciones si el ID es el del acceso directo.
if (process.platform === 'win32') app.setAppUserModelId('com.qubiq.control');
if (!app.requestSingleInstanceLock()) app.quit();

function appRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve('.');
}

function dataDirectory() {
  const dir = path.join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Tras una actualización la app se vuelve a abrir sola. Si estaba escondida en la bandeja, tiene que volver
// escondida y no aparecer de golpe en pantalla. El aviso solo vale unos minutos, por si la instalación falló.
const hiddenRestartFlag = () => path.join(app.getPath('userData'), 'restart-hidden.flag');

function rememberHiddenForRestart() {
  if (mainWindow && !mainWindow.isVisible()) writeFileSync(hiddenRestartFlag(), new Date().toISOString());
}

function consumeHiddenRestartFlag() {
  const flag = hiddenRestartFlag();
  if (!existsSync(flag)) return false;
  const fresh = Date.now() - statSync(flag).mtimeMs < HIDDEN_RESTART_MAX_AGE_MS;
  try { unlinkSync(flag); } catch { /* sin importancia */ }
  return fresh;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: path.join(appRoot(), 'build', 'icon.png') }).show();
}

async function startBackend() {
  const root = appRoot();
  const dataDir = dataDirectory();
  process.env.QUBIQ_ROOT_DIR = root;
  process.env.QUBIQ_DATA_DIR = dataDir;
  process.env.PORT = String(PORT);
  const { startServer } = await import('../src/server.js');
  server = await startServer({ quiet: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#F4F7FB',
    title: 'Qubiq Control',
    icon: path.join(appRoot(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith(`http://localhost:${PORT}/`);
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) {
      mainWindow.show();
      mainWindow.maximize();
    }
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/admin.html`);
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(appRoot(), 'build', 'icon.png'));
  tray.setToolTip('Qubiq Control · asistencia activa');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Qubiq Control', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Salir completamente', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (consumeHiddenRestartFlag()) startHidden = true;
    await startBackend();
    createWindow();
    createTray();
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] });
      startAutoUpdates({
        updater: autoUpdater,
        notify,
        beforeInstall: () => {
          rememberHiddenForRestart();
          quitting = true;
        }
      });
    }
  } catch (error) {
    dialog.showErrorBox('Qubiq Control no pudo iniciar',
      `No se pudo iniciar el servicio local.\n\n${error.message}\n\nVerifique que el puerto ${PORT} no esté siendo usado por otra copia.`);
    app.quit();
  }
});
app.on('window-all-closed', () => {
  // Qubiq Control continúa en segundo plano para mantener el QR activo.
});

app.on('before-quit', () => {
  quitting = true;
  server?.close();
});
