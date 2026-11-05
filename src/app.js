// Canvas-first client. Sessions are cards on an infinite board;
// clicking one opens a conversation panel inside the canvas (no navigation away).

import { showMenu, closeMenu, toast, confirmDialog, promptDialog } from './menu.js';

const canvasEl = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('empty');
const panelEl = document.getElementById('panel');

const GRID = 16;
const CARD_W = 236;
const CARD_GAP_X = 28;
const CARD_GAP_Y = 24;
const COLS = 4;

const state = {
  sessions: [],           // enriched session rows
  byId: new Map(),
  positions: new Map(),   // sessionId -> {x,y}
  selected: null,
  panelSession: null,     // session id shown in the side panel
  camera: { x: 0, y: 0, zoom: 1 },
  dragging: null,
  query: '',
};

const snap = (v) => Math.round(v / GRID) * GRID;

function setStatus(t) { statusEl.textContent = t; }

function relTime(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

function ensureLayout() {
  let i = 0;
  for (const s of state.sessions) {
    if (state.positions.has(s.sessionId)) continue;
    const col = i % COLS, row = Math.floor(i / COLS);
    state.positions.set(s.sessionId, {
      x: snap(60 + col * (CARD_W + CARD_GAP_X)),
      y: snap(48 + row * (132 + CARD_GAP_Y)),
    });
    i++;
  }
}

function applyCamera() {
  const c = state.camera;
  canvasEl.style.backgroundPosition = c.x + 'px ' + c.y + 'px';
  canvasEl.style.backgroundSize = (GRID * c.zoom) + 'px ' + (GRID * c.zoom) + 'px';
  for (const el of canvasEl.querySelectorAll('.card')) {
    const p = state.positions.get(el.dataset.sessionId);
    if (!p) continue;
    el.style.left = (p.x * c.zoom + c.x) + 'px';
    el.style.top = (p.y * c.zoom + c.y) + 'px';
    el.style.transform = 'scale(' + c.zoom + ')';
  }
}

function cardBadges(s) {
  const out = [];
  if (s.running) out.push(['running', '运行中']);
  if (s.pendingInput > 0) out.push(['waiting', '等你回复']);
  if (s.pinned) out.push(['pin', '置顶']);
  return out;
}

function openCardMenu(x, y, s) {
  showMenu(x, y, [
    { label: '打开对话', run: () => selectSession(s.sessionId) },
    { label: s.pinned ? '取消置顶' : '置顶会话', run: () => runAction(s.pinned ? 'unpin' : 'pin', s) },
    { label: '重命名…', run: () => renameCard(s) },
    { separator: true },
    { label: s.running ? '停止运行' : '归档会话', run: () => s.running ? runAction('cancel', s) : runAction('archive', s) },
    { label: '删除会话（回收站）', danger: true, run: () => deleteCard(s) },
  ]);
}

function friendlyError(raw) {
  const m = String(raw ?? '');
  if (m.includes('writer-held') || m.includes('agent-busy')) return '这个对话正被占用（在运行或被打开），先停止或关闭它再试';
  if (m.includes('not found') || m.includes('unknown')) return '内核不支持这个操作';
  return m.slice(0, 70);
}

async function runAction(name, s) {
  const res = await window.studio.action(name, s.sessionId);
  if (!res?.ok) { toast(friendlyError(res?.error), 'error'); return; }

  if (name === 'pin') { s.pinned = true; toast('已置顶'); }
  else if (name === 'unpin') { s.pinned = false; toast('已取消置顶'); }
  else if (name === 'archive') { state.sessions = state.sessions.filter((x) => x.sessionId !== s.sessionId); toast('已归档'); if (state.panelSession === s.sessionId) closePanel(); }
  else if (name === 'cancel') { s.running = false; toast('已停止运行'); }
  render();
}

async function renameCard(s) {
  const next = await promptDialog({ title: '重命名会话', value: s.title, okLabel: '保存' });
  if (next === null) return;
  const title = next.trim();
  if (!title || title === s.title) return;
  const res = await window.studio.action('rename', s.sessionId, title);
  if (!res?.ok) { toast(friendlyError(res?.error), 'error'); return; }
  s.title = title;
  state.byId.set(s.sessionId, s);
  toast('已重命名');
  render();
  if (state.panelSession === s.sessionId) openPanel(s.sessionId);
}

async function deleteCard(s) {
  const ok = await confirmDialog({
    title: '删除这个会话？',
    body: '「' + s.title + '」会被移入回收站。仍在运行的会话会先被停止。',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  const res = await window.studio.action('delete', s.sessionId);
  if (!res?.ok) { toast(friendlyError(res?.error), 'error'); return; }
  state.sessions = state.sessions.filter((x) => x.sessionId !== s.sessionId);
  state.positions.delete(s.sessionId);
  if (state.panelSession === s.sessionId) closePanel();
  toast('已删除');
  render();
}

function render() {
  canvasEl.querySelectorAll('.card').forEach((el) => el.remove());
  const q = state.query.trim().toLowerCase();
  for (const s of state.sessions) {
    const p = state.positions.get(s.sessionId);
    if (!p) continue;
    if (q && !(s.title.toLowerCase().includes(q) || (s.lastPrompt || '').toLowerCase().includes(q))) continue;

    const card = document.createElement('div');
    card.className = 'card' + (state.selected === s.sessionId ? ' selected' : '');
    card.dataset.sessionId = s.sessionId;

    const head = document.createElement('div');
    head.className = 'card-top';
    if (s.pinned) {
      const pin = document.createElement('span');
      pin.className = 'card-pin';
      pin.textContent = '📌';
      head.appendChild(pin);
    }
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = s.title;
    head.appendChild(title);
    card.appendChild(head);

    if (s.lastPrompt) {
      const pv = document.createElement('div');
      pv.className = 'card-preview';
      pv.textContent = s.lastPrompt;
      card.appendChild(pv);
    }

    const foot = document.createElement('div');
    foot.className = 'card-meta';
    const dot = document.createElement('span');
    dot.className = 'card-dot' + (s.running ? ' running' : '');
    foot.appendChild(dot);
    const time = document.createElement('span');
    time.textContent = relTime(s.updatedAt);
    foot.appendChild(time);
    for (const [kind, label] of cardBadges(s)) {
      if (kind === 'pin') continue;
      const b = document.createElement('span');
      b.className = 'chip chip-' + kind;
      b.textContent = label;
      foot.appendChild(b);
    }
    card.appendChild(foot);

    card.addEventListener('mousedown', (e) => startDrag(e, s.sessionId));
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSession(s.sessionId);
    });
    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      selectSession(s.sessionId);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selected = s.sessionId;
      document.querySelectorAll('.card').forEach((x) => x.classList.toggle('selected', x.dataset.sessionId === s.sessionId));
      openCardMenu(e.clientX, e.clientY, s);
    });
    canvasEl.appendChild(card);
  }
  emptyEl.hidden = state.sessions.length > 0;
  applyCamera();
}

function selectSession(sessionId) {
  state.selected = sessionId;
  state.panelSession = sessionId;
  document.querySelectorAll('.card').forEach((x) => x.classList.toggle('selected', x.dataset.sessionId === sessionId));
  openPanel(sessionId);
}

// ---- side panel inside the canvas -----------------------------------------

async function openPanel(sessionId) {
  const s = state.byId.get(sessionId);
  panelEl.hidden = false;
  panelEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'panel-head';
  const t = document.createElement('span');
  t.className = 'panel-title';
  t.textContent = s?.title ?? sessionId;
  head.appendChild(t);
  const close = document.createElement('button');
  close.className = 'panel-close';
  close.textContent = '✕';
  close.title = '关闭';
  close.addEventListener('click', closePanel);
  head.appendChild(close);
  panelEl.appendChild(head);

  const body = document.createElement('div');
  body.className = 'panel-body';
  panelEl.appendChild(body);

  const meta = document.createElement('div');
  meta.className = 'panel-meta';
  meta.textContent = s?.cwd || '';
  body.appendChild(meta);

  const loading = document.createElement('div');
  loading.className = 'panel-meta';
  loading.textContent = '正在读取对话…';
  body.appendChild(loading);

  try {
    const detail = await window.studio.detail(sessionId);
    loading.remove();
    if (detail) {
      if (detail.turns) meta.textContent = (s?.cwd || '') + ' · ' + detail.turns + ' 轮';
      for (const turn of (detail.outline || []).slice(-8)) {
        const item = document.createElement('div');
        item.className = 'turn';
        const q1 = document.createElement('div');
        q1.className = 'turn-q';
        q1.textContent = turn.prompt || '';
        item.appendChild(q1);
        if (turn.response) {
          const a1 = document.createElement('div');
          a1.className = 'turn-a';
          a1.textContent = turn.response;
          item.appendChild(a1);
        }
        body.appendChild(item);
      }
      if (!detail.outline?.length) {
        const none = document.createElement('div');
        none.className = 'panel-meta';
        none.textContent = '这个对话还没有内容。';
        body.appendChild(none);
      }
    }
  } catch (err) {
    loading.textContent = '读取失败: ' + String(err.message ?? err).slice(0, 80);
  }
}

function closePanel() {
  panelEl.hidden = true;
  state.panelSession = null;
}

// ---- dragging --------------------------------------------------------------

function startDrag(e, sessionId) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const start = state.positions.get(sessionId);
  state.dragging = { sessionId, start, ox: e.clientX, oy: e.clientY, z: state.camera.zoom, moved: false };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag, { once: true });
}

function onDrag(e) {
  const d = state.dragging;
  if (!d) return;
  const dx = (e.clientX - d.ox) / d.z;
  const dy = (e.clientY - d.oy) / d.z;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
  state.positions.set(d.sessionId, { x: d.start.x + dx, y: d.start.y + dy });
  applyCamera();
}

function endDrag() {
  const d = state.dragging;
  state.dragging = null;
  document.removeEventListener('mousemove', onDrag);
  if (!d?.moved) return;
  const p = state.positions.get(d.sessionId);
  if (!p) return;
  const snapped = { x: snap(p.x), y: snap(p.y) };   // grid snap
  state.positions.set(d.sessionId, snapped);
  applyCamera();
  window.studio.savePosition(d.sessionId, snapped);
}

// ---- board pan / zoom ------------------------------------------------------

let panning = null;
canvasEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.card')) return;
  canvasEl.classList.add('dragging');
  panning = { ox: e.clientX, oy: e.clientY, cx: state.camera.x, cy: state.camera.y };
  document.addEventListener('mousemove', onPan);
  document.addEventListener('mouseup', endPan, { once: true });
});
function onPan(e) {
  if (!panning) return;
  state.camera.x = panning.cx + (e.clientX - panning.ox);
  state.camera.y = panning.cy + (e.clientY - panning.oy);
  applyCamera();
}
function endPan() {
  panning = null;
  canvasEl.classList.remove('dragging');
  document.removeEventListener('mousemove', onPan);
}

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = state.camera;
  const rect = canvasEl.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const k = (e.deltaY < 0 ? 1.1 : 1 / 1.1);
  const next = Math.min(2, Math.max(0.3, c.zoom * k));
  const r = next / c.zoom;
  c.x = mx - (mx - c.x) * r;
  c.y = my - (my - c.y) * r;
  c.zoom = next;
  applyCamera();
}, { passive: false });

document.getElementById('btn-fit').addEventListener('click', () => {
  state.camera = { x: 0, y: 0, zoom: 1 };
  applyCamera();
});
document.getElementById('btn-reload').addEventListener('click', () => reload());

const searchEl = document.getElementById('search');
searchEl.addEventListener('input', () => { state.query = searchEl.value; render(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenu();
  if (!panelEl.hidden) closePanel();
  else { state.selected = null; render(); }
});

async function reload() {
  setStatus('正在读取会话…');
  try {
    const board = await window.studio.board();
    state.sessions = board;
    state.byId = new Map(board.map((s) => [s.sessionId, s]));
    const saved = await window.studio.loadLayout();
    for (const [id, pos] of Object.entries(saved || {})) {
      if (pos && typeof pos.x === 'number') state.positions.set(id, pos);
    }
    ensureLayout();
    render();
    setStatus(board.length + ' 个会话');

    // Second pass: real running flags, bounded batches, off the critical path.
    window.studio.running(board.map((s) => s.sessionId)).then((flags) => {
      let changed = false;
      for (const s of state.sessions) {
        if (flags[s.sessionId] !== undefined && s.running !== flags[s.sessionId]) {
          s.running = flags[s.sessionId];
          changed = true;
        }
      }
      if (changed) render();
    }).catch(() => {});
  } catch (err) {
    setStatus('读取失败: ' + String(err.message ?? err).slice(0, 90));
  }
}

reload();
