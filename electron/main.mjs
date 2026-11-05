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
ipcMain.handle('workspaces:get', async () => {
  try { return { ok: true, value: await api.workspaceBaseline() }; }
  catch (err) { return { ok: false, error: String(err.message ?? err) }; }
});

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
      case 'renameWorkspace': await engine.call('workspace/rename', { request: { workspaceId: sessionId, title: String(extra ?? '') } }, 'request'); return { ok: true };
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
          await wait(2800);
          const out = {};
          out.status = document.getElementById('status')?.textContent;
          out.cards = document.querySelectorAll('.card').length;
          out.frames = document.querySelectorAll('.frame').length;
          out.frameLabel = document.querySelector('.frame-label')?.textContent;

          // A. card click -> panel
          const card = [...document.querySelectorAll('.card')].find(c => {
            const f = document.querySelector('.frame')?.getBoundingClientRect();
            const r = c.getBoundingClientRect();
            return f && r.left >= f.left && r.right <= f.right;
          });
          card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await wait(4500);
          const panel = document.getElementById('panel');
          out.A_panelOpen = !panel.hidden;
          out.A_turns = panel.querySelectorAll('.turn').length;

          // B. card context menu still works
          card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
          await wait(250);
          out.B_menuItems = [...(document.querySelector('.ctx-menu')?.querySelectorAll('.ctx-item') ?? [])].map(e => e.textContent);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          await wait(150);
          out.B_panelClosedByEsc = document.getElementById('panel').hidden;

          // C. search still filters
          const s = document.getElementById('search');
          s.value = 'dsh-talk-map';
          s.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(250);
          out.C_filteredCards = document.querySelectorAll('.card').length;
          s.value = '';
          s.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(250);
          out.C_restoredCards = document.querySelectorAll('.card').length;

          // D. frame drag moves cards
          const label = document.querySelector('.frame-label');
          const before = document.querySelector('.card').offsetLeft;
          const lr = label.getBoundingClientRect();
          label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: lr.left + 8, clientY: lr.top + 4, button: 0 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: lr.left + 88, clientY: lr.top + 4 }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: lr.left + 88, clientY: lr.top + 4 }));
          await wait(300);
          out.D_frameDragMovesCards = document.querySelector('.card').offsetLeft !== before;
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
