// Electron main: own the window, own the engine, expose a narrow IPC bridge.
import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import { StudioApi } from './api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DIAG_LOG: main-process trace to a file (Windows GUI has no console).
const DIAG = path.join(__dirname, '..', 'boot.log');
const diag = (m) => { try { fs.appendFileSync(DIAG, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
process.on('uncaughtException', (e) => diag('UNCAUGHT ' + (e.stack ?? e.message)));
process.on('unhandledRejection', (e) => diag('UNHANDLED ' + String(e)));
diag('main module loaded, electron ' + process.versions.electron);
const engine = new Engine();
const api = new StudioApi(engine);
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'DSH Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  diag('window constructed');
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  diag('loadFile called');
  win.webContents.on('did-finish-load', () => diag('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc) => diag('did-fail-load ' + code + ' ' + desc));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('engine:log', 'window ready');
  });
}

// The renderer asks for kernel data; the engine holds the authenticated channel.
ipcMain.handle('engine:invoke', async (_event, endpoint, args) => {
  return await engine.call(endpoint, args ?? {});
});

ipcMain.handle('board:get', async () => await api.fastBoard());
ipcMain.handle('session:detail', async (_e, sessionId) => await api.sessionDetail(sessionId));
ipcMain.handle('action:run', async (_e, action, sessionId, extra) => {
  try {
    switch (action) {
      case 'pin': await api.pin(sessionId); return { ok: true };
      case 'unpin': await api.unpin(sessionId); return { ok: true };
      case 'rename': await api.rename(sessionId, String(extra ?? '')); return { ok: true };
      case 'archive': await api.archive(sessionId, true); return { ok: true };
      case 'cancel': await api.cancel(sessionId); return { ok: true };
      case 'delete': await api.archive(sessionId, true); await api.deleteSession(sessionId); return { ok: true };
      default: return { ok: false, error: 'unknown action ' + action };
    }
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle('board:running', async (_e, ids) => await api.runningStates(ids ?? []));

ipcMain.handle('engine:status', async () => {
  try {
    await engine.start();
    return { ok: true, origin: engine.origin, log: engine.logLines.slice(-20) };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err), log: engine.logLines.slice(-20) };
  }
});

// Persisted card positions live beside the app's user data.
const layoutFile = () => path.join(app.getPath('userData'), 'canvas-layout.json');

ipcMain.handle('layout:load', async () => {
  try {
    return JSON.parse(fs.readFileSync(layoutFile(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('layout:save', async (_event, positions) => {
  try {
    fs.writeFileSync(layoutFile(), JSON.stringify(positions), 'utf8');
    return true;
  } catch {
    return false;
  }
});

diag('registering whenReady');
app.whenReady().then(async () => {
  diag('whenReady fired');
  createWindow();
  diag('createWindow returned');
  // Warm the engine in the background; the UI polls status until ready.
  engine.start().then(() => diag('engine started')).catch((err) => diag('engine failed: ' + String(err)));
});

app.on('window-all-closed', () => {
  engine.stop();
  if (process.platform !== 'darwin') app.quit();
});

// SCREENSHOT_HOOK: capture the live window for verification, then exit.
if (process.argv.includes('--shot')) {
  app.whenReady().then(async () => {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'shot.png'), img.toPNG());
        diag('screenshot written');
      } catch (e) { diag('screenshot failed: ' + String(e)); }
      app.quit();
    }, 9000);
  });
}

// DOMDUMP_HOOK: dump the live DOM state for verification.
if (process.argv.includes('--dump')) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      try {
        const info = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const out = {};
          out.cards = document.querySelectorAll('.card').length;
          // panel still works
          const card = document.querySelector('.card');
          card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await wait(4500);
          const panel = document.getElementById('panel');
          out.panelOpen = panel ? !panel.hidden : null;
          out.panelTurns = panel?.querySelectorAll('.turn').length ?? 0;
          // menu still works, over the panel
          card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }));
          await wait(250);
          const menu = document.querySelector('.ctx-menu');
          out.menuOpen = !!menu;
          out.menuItems = menu ? [...menu.querySelectorAll('.ctx-item')].map(e => e.textContent) : [];
          // toast renders
          const ev = new KeyboardEvent('keydown', { key: 'Escape' });
          document.dispatchEvent(ev);
          await wait(150);
          out.menuClosedByEsc = !document.querySelector('.ctx-menu');
          out.panelClosedByEsc = document.getElementById('panel')?.hidden ?? null;
          return out;
        })()`);
        fs.writeFileSync(path.join(__dirname, '..', 'dom.json'), JSON.stringify(info, null, 2));
        diag('dom dumped');
      } catch (e) { diag('dom dump failed: ' + String(e)); }
      app.quit();
    }, 10000);
  });
}

app.on('before-quit', () => engine.stop());
