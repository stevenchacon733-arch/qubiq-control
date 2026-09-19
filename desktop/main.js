import { app, BrowserWindow, dialog, shell, Tray, Menu, session } from 'electron';
import electronUpdater from 'electron-updater';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const { autoUpdater } = electronUpdater;
const PORT = 3220;
const START_HIDDEN = process.argv.includes('--background');
let mainWindow;
let server;
let tray;
let quitting = false;

app.setName('Qubiq Control');
if (!app.requestSingleInstanceLock()) app.quit();

function appRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve('.');
}

function dataDirectory() {
  const dir = path.join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
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
    if (!START_HIDDEN) {
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
    await startBackend();
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] });
      autoUpdater.checkForUpdatesAndNotify();
    }
    createWindow();
    createTray();
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
