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
  // Surface renderer errors in boot.log: a thrown module leaves a blank board.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) diag('renderer[' + level + '] ' + String(message).slice(0, 500) + ' @' + sourceId + ':' + line);
  });
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
ipcMain.handle('digest:generate', async (_e, sessionId, title) => await api.generateDigest(sessionId, title));

ipcMain.handle('search:run', async (_e, query) => await api.search(String(query ?? '')));

ipcMain.handle('spawn:run', async (_e, opts) => {
  try {
    const { fromSessionId, mode, text, x, y } = opts ?? {};
    const result = { ok: true };
    if (mode === 'full') {
      // Native fork: the new session carries the whole history.
      const forked = await api.forkSession(fromSessionId);
      result.sessionId = forked?.sessionId ?? forked?.value?.sessionId;
    } else {
      const ws = await api.workspaceBaseline();
      const created = await api.createSession(ws.items[0]?.workspaceId);
      result.sessionId = created?.sessionId;
      if (mode === 'digest' && text) {
        await api.sendPrompt(result.sessionId, text);
      } else if (mode === 'none' && text) {
        await api.sendPrompt(result.sessionId, text);
      }
    }
    if (!result.sessionId) return { ok: false, error: '内核没有返回新的会话 ID' };
    return result;
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle('chat:send', async (_e, opts) => {
  try {
    const { sessionId, text } = opts ?? {};
    if (!sessionId || !String(text ?? '').trim()) return { ok: false, error: '消息为空' };
    return await api.chatSend(sessionId, String(text));
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle('push:send', async (_e, opts) => {
  try {
    const { sessionId, text } = opts ?? {};
    if (!sessionId || !text) return { ok: false, error: '缺少参数' };
    await api.pushToSession(sessionId, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle('digest:get', async (_e, sessionId) => {
  try { return { ok: true, value: await api.digestOf(sessionId) }; }
  catch (err) { return { ok: false, error: String(err.message ?? err) }; }
});

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
      case 'createWorkspace': {
        const created = await api.createWorkspace(String(extra ?? ''));
        return { ok: true, value: created };
      }
      case 'deleteWorkspace': await api.deleteWorkspace(sessionId); return { ok: true };
      case 'moveToWorkspace': await api.moveSessionToWorkspace(sessionId, String(extra ?? '')); return { ok: true };
      case 'renameWorkspace': await engine.call('workspace/rename', { request: { workspaceId: sessionId, title: String(extra ?? '') } }, 'request'); return { ok: true };
      default: return { ok: false, error: 'unknown action ' + action };
    }
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle('board:running', async (_e, ids) => await api.runningStates(ids ?? []));
ipcMain.handle('board:status', async (_e, ids) => await api.boardStatus(ids ?? []));

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

const digestsFile = () => path.join(app.getPath('userData'), 'canvas-digests.json');
const colorsFile = () => path.join(app.getPath('userData'), 'canvas-colors.json');

// Atomic write: a crash mid-write must not leave a truncated canvas file.
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

ipcMain.handle('digests:load', async () => {
  try { return JSON.parse(fs.readFileSync(digestsFile(), 'utf8')); } catch { return {}; }
});

ipcMain.handle('digests:save', async (_e, map) => {
  try { writeAtomic(digestsFile(), JSON.stringify(map ?? {})); return true; } catch { return false; }
});

const framesFile = () => path.join(app.getPath('userData'), 'canvas-frames.json');

ipcMain.handle('frames:load', async () => {
  try { return JSON.parse(fs.readFileSync(framesFile(), 'utf8')); } catch { return {}; }
});

ipcMain.handle('frames:save', async (_e, map) => {
  try { writeAtomic(framesFile(), JSON.stringify(map ?? {})); return true; } catch { return false; }
});

ipcMain.handle('colors:load', async () => {
  try { return JSON.parse(fs.readFileSync(colorsFile(), 'utf8')); } catch { return {}; }
});

ipcMain.handle('colors:save', async (_e, map) => {
  try { writeAtomic(colorsFile(), JSON.stringify(map ?? {})); return true; } catch { return false; }
});

ipcMain.handle('layout:load', async () => {
  try {
    return JSON.parse(fs.readFileSync(layoutFile(), 'utf8'));
  } catch {
    return {};
  }
});

const edgesFile = () => path.join(app.getPath('userData'), 'canvas-edges.json');

ipcMain.handle('edges:load', async () => {
  try { return JSON.parse(fs.readFileSync(edgesFile(), 'utf8')); } catch { return []; }
});

ipcMain.handle('edges:save', async (_e, edges) => {
  try { fs.writeFileSync(edgesFile(), JSON.stringify(edges ?? []), 'utf8'); return true; } catch { return false; }
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
        diag('dump script starting');
        const scriptPath = path.join(__dirname, '..', 'probe-ui.js');
        const info = await win.webContents.executeJavaScript(fs.readFileSync(scriptPath, 'utf8'));
        fs.writeFileSync(path.join(__dirname, '..', 'dom.json'), JSON.stringify(info, null, 2));
        diag('dom dumped');
        diag('dump script finished');
      } catch (e) {
        diag('dom dump failed: ' + String(e));
        try {
          const logs = await win.webContents.executeJavaScript('window.__errs || []');
          diag('collected errors: ' + JSON.stringify(logs).slice(0, 1500));
        } catch {}
      }
      app.quit();
    }, 10000);
  });
}

app.on('before-quit', () => engine.stop());
