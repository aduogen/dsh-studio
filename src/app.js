// Canvas-first client. Sessions are cards on an infinite board;
// clicking one opens a conversation panel inside the canvas (no navigation away).

import { showMenu, closeMenu, toast, confirmDialog, promptDialog } from './menu.js';
import { EDGE_KINDS, sideHandles, anchor, curvePath, distToSegment, buildInjectedText } from './edges.js';

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
  workspaces: [],          // {workspaceId, title, path, sessionIds}
  wsRect: new Map(),       // workspaceId -> {x,y,w,h}
  pinnedSet: new Set(),
  batchMode: false,
  picked: new Set(),
  edges: [],               // {id, fromCardId, toCardId, kind, injectedText?}
  connecting: null,        // {fromCardId, x, y} while dragging a new line
  pendingSpawn: null,      // {fromCardId, flowX, flowY} while the preview is open
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
  const memberOf = new Map();
  for (const w of state.workspaces) for (const id of w.sessionIds) memberOf.set(id, w.workspaceId);

  // Members are laid out inside their own workspace block, so frames stay tight.
  let cursorY = 48;
  for (const w of state.workspaces) {
    const members = state.sessions.filter((s) => memberOf.get(s.sessionId) === w.workspaceId);
    if (members.length === 0) continue;
    let i = 0;
    let maxY = cursorY;
    for (const s of members) {
      if (!state.positions.has(s.sessionId)) {
        const col = i % COLS, row = Math.floor(i / COLS);
        state.positions.set(s.sessionId, {
          x: snap(80 + col * (CARD_W + CARD_GAP_X)),
          y: snap(cursorY + 26 + row * (132 + CARD_GAP_Y)),
        });
      }
      i++;
    }
    const rows = Math.ceil(members.length / COLS);
    maxY = cursorY + 26 + rows * (132 + CARD_GAP_Y) + 30;
    cursorY = snap(maxY);
  }

  // Sessions that belong to no workspace sit below, in their own grid.
  const loose = state.sessions.filter((s) => !memberOf.has(s.sessionId));
  let i = 0;
  for (const s of loose) {
    if (state.positions.has(s.sessionId)) continue;
    const col = i % COLS, row = Math.floor(i / COLS);
    state.positions.set(s.sessionId, {
      x: snap(80 + col * (CARD_W + CARD_GAP_X)),
      y: snap(cursorY + 40 + row * (132 + CARD_GAP_Y)),
    });
    i++;
  }
}

const FRAME_PAD = 26;
const FRAME_LABEL_H = 26;

function ensureFrames() {
  for (const w of state.workspaces) {
    if (state.wsRect.has(w.workspaceId)) continue;
    const memberSet = new Set(w.sessionIds);
    const members = state.sessions
      .filter((s) => memberSet.has(s.sessionId))
      .map((s) => state.positions.get(s.sessionId))
      .filter(Boolean);
    if (members.length === 0) continue;
    const minX = Math.min(...members.map((p) => p.x));
    const minY = Math.min(...members.map((p) => p.y));
    const maxX = Math.max(...members.map((p) => p.x)) + CARD_W;
    const maxY = Math.max(...members.map((p) => p.y)) + 132;
    state.wsRect.set(w.workspaceId, {
      x: snap(minX - FRAME_PAD),
      y: snap(minY - FRAME_PAD - FRAME_LABEL_H),
      w: snap(maxX - minX + FRAME_PAD * 2),
      h: snap(maxY - minY + FRAME_PAD * 2 + FRAME_LABEL_H),
    });
  }
}

function renderFrames() {
  canvasEl.querySelectorAll('.frame').forEach((el) => el.remove());
  const c = state.camera;
  for (const w of state.workspaces) {
    const r = state.wsRect.get(w.workspaceId);
    if (!r) continue;
    const el = document.createElement('div');
    el.className = 'frame';
    el.dataset.workspaceId = w.workspaceId;
    el.style.left = (r.x * c.zoom + c.x) + 'px';
    el.style.top = (r.y * c.zoom + c.y) + 'px';
    el.style.width = (r.w * c.zoom) + 'px';
    el.style.height = (r.h * c.zoom) + 'px';

    const label = document.createElement('div');
    label.className = 'frame-label';
    label.textContent = w.title + ' · ' + w.sessionIds.length;
    label.style.fontSize = Math.max(10, 11 * c.zoom) + 'px';
    label.title = w.path;
    label.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      startFrameDrag(e, w);
    });
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFrameMenu(e.clientX, e.clientY, w);
    });
    el.appendChild(label);
    canvasEl.appendChild(el);
  }
}

function ensureEdgeLayer() {
  let svg = document.getElementById('edges');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'edges';
    canvasEl.appendChild(svg);
  }
  return svg;
}

function cardRect(sessionId) {
  const p = state.positions.get(sessionId);
  if (!p) return null;
  return { x: p.x, y: p.y, w: CARD_W, h: 132 };
}

function renderEdges() {
  const svg = ensureEdgeLayer();
  const c = state.camera;
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.innerHTML = '';

  const all = [...state.edges];
  if (state.connecting) {
    const a = cardRect(state.connecting.fromCardId);
    if (a) all.push({ id: '__temp', fromCardId: state.connecting.fromCardId, pending: true });
  }

  for (const edge of all) {
    const a = cardRect(edge.fromCardId);
    if (!a) continue;
    let p, q;
    if (edge.pending) {
      p = anchor(a, 'r', CARD_W, 132);
      q = { x: state.connecting.x, y: state.connecting.y };
    } else {
      const b = cardRect(edge.toCardId);
      if (!b) continue;
      const hs = sideHandles(a, b, CARD_W, 132);
      p = anchor(a, hs.from, CARD_W, 132);
      q = anchor(b, hs.to, CARD_W, 132);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', curvePath(
      { x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y },
      { x: q.x * c.zoom + c.x, y: q.y * c.zoom + c.y }
    ));
    path.setAttribute('class', 'edge' + (edge.pending ? ' pending' : '') + (edge.kind === 'full' ? ' full' : ''));
    path.dataset.edgeId = edge.id;
    svg.appendChild(path);
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
  renderFrames();
  renderEdges();
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

let render = function () {
  canvasEl.querySelectorAll('.card').forEach((el) => el.remove());
  const q = state.query.trim().toLowerCase();
  for (const s of state.sessions) {
    const p = state.positions.get(s.sessionId);
    if (!p) continue;
    if (q && !(s.title.toLowerCase().includes(q) || (s.lastPrompt || '').toLowerCase().includes(q))) continue;

    const isPinned = s.pinned === true || state.pinnedSet.has(s.sessionId);

    const card = document.createElement('div');
    card.className = 'card'
      + (state.selected === s.sessionId ? ' selected' : '')
      + (state.picked.has(s.sessionId) ? ' picked' : '');
    card.dataset.sessionId = s.sessionId;

    if (state.batchMode) {
      const box = document.createElement('span');
      box.className = 'pick-box' + (state.picked.has(s.sessionId) ? ' on' : '');
      box.textContent = state.picked.has(s.sessionId) ? '✓' : '';
      card.appendChild(box);
    }
    const head = document.createElement('div');
    head.className = 'card-top';
    if (isPinned) {
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

    const grip = document.createElement('span');
    grip.className = 'card-grip';
    grip.title = '拖出连线';
    grip.addEventListener('mousedown', (e) => startConnect(e, s.sessionId));
    card.appendChild(grip);

    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('.card-grip')) return;
      startDrag(e, s.sessionId);
    });
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.batchMode || e.ctrlKey || e.metaKey) {
        if (state.picked.has(s.sessionId)) state.picked.delete(s.sessionId);
        else state.picked.add(s.sessionId);
        render();
        return;
      }
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
};

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

function startFrameDrag(e, w) {
  const memberSet = new Set(w.sessionIds);
  const members = state.sessions.filter((s) => memberSet.has(s.sessionId));
  const starts = members
    .map((s) => ({ id: s.sessionId, pos: state.positions.get(s.sessionId) }))
    .filter((x) => x.pos);
  state.dragging = {
    frame: w.workspaceId, starts, ox: e.clientX, oy: e.clientY, z: state.camera.zoom, moved: false,
  };
  document.addEventListener('mousemove', onFrameDrag);
  document.addEventListener('mouseup', endFrameDrag, { once: true });
}

function onFrameDrag(e) {
  const d = state.dragging;
  if (!d || !d.frame) return;
  const dx = (e.clientX - d.ox) / d.z;
  const dy = (e.clientY - d.oy) / d.z;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
  for (const x of d.starts) {
    state.positions.set(x.id, { x: x.pos.x + dx, y: x.pos.y + dy });
  }
  const r = state.wsRect.get(d.frame);
  if (r) {
    const startRect = d.startRect ?? (d.startRect = r);
    state.wsRect.set(d.frame, { ...startRect, x: startRect.x + dx, y: startRect.y + dy });
  }
  applyCamera();
}

function endFrameDrag() {
  const d = state.dragging;
  state.dragging = null;
  document.removeEventListener('mousemove', onFrameDrag);
  if (!d?.moved) return;
  for (const x of d.starts) {
    const p = state.positions.get(x.id);
    if (p) {
      const s = { x: snap(p.x), y: snap(p.y) };
      state.positions.set(x.id, s);
      window.studio.savePosition(x.id, s);
    }
  }
  const r = state.wsRect.get(d.frame);
  if (r) state.wsRect.set(d.frame, { x: snap(r.x), y: snap(r.y), w: r.w, h: r.h });
  applyCamera();
}

function openFrameMenu(x, y, w) {
  showMenu(x, y, [
    { label: '重命名工作区…', run: () => renameWorkspace(w) },
    { label: '整理本组卡片', run: () => { relayoutWorkspace(w); toast('已整理'); } },
  ]);
}

function relayoutWorkspace(w) {
  const memberSet = new Set(w.sessionIds);
  const members = state.sessions.filter((s) => memberSet.has(s.sessionId));
  const r = state.wsRect.get(w.workspaceId);
  if (!r) return;
  let i = 0;
  for (const s of members) {
    const col = i % COLS, row = Math.floor(i / COLS);
    state.positions.set(s.sessionId, {
      x: snap(r.x + FRAME_PAD + col * (CARD_W + CARD_GAP_X)),
      y: snap(r.y + FRAME_LABEL_H + FRAME_PAD + row * (132 + CARD_GAP_Y)),
    });
    i++;
  }
  applyCamera();
}

async function renameWorkspace(w) {
  const next = await promptDialog({ title: '重命名工作区', value: w.title, okLabel: '保存' });
  if (next === null) return;
  const title = next.trim();
  if (!title || title === w.title) return;
  const res = await window.studio.action('renameWorkspace', w.workspaceId, title);
  if (!res?.ok) { toast('改名失败: ' + String(res?.error ?? '').slice(0, 60), 'error'); return; }
  w.title = title;
  toast('已重命名工作区');
  render();
}

// ---- connecting -----------------------------------------------------------

function startConnect(e, sessionId) {
  e.stopPropagation();
  e.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  state.connecting = {
    fromCardId: sessionId,
    x: (e.clientX - rect.left - state.camera.x) / state.camera.zoom,
    y: (e.clientY - rect.top - state.camera.y) / state.camera.zoom,
  };
  document.addEventListener('mousemove', onConnectMove);
  document.addEventListener('mouseup', endConnect, { once: true });
  renderEdges();
}

function onConnectMove(e) {
  if (!state.connecting) return;
  const rect = canvasEl.getBoundingClientRect();
  state.connecting.x = (e.clientX - rect.left - state.camera.x) / state.camera.zoom;
  state.connecting.y = (e.clientY - rect.top - state.camera.y) / state.camera.zoom;
  renderEdges();
}

function endConnect(e) {
  document.removeEventListener('mousemove', onConnectMove);
  const conn = state.connecting;
  state.connecting = null;
  if (!conn) { renderEdges(); return; }

  // Did the drop land on another card? Then it is a plain link, not a spawn.
  const rect = canvasEl.getBoundingClientRect();
  const px = e.clientX, py = e.clientY;
  const target = document.elementsFromPoint(px, py)
    .map((el) => el.closest && el.closest('.card'))
    .find((el) => el !== null && el.closest('.card') !== null);
  const targetCard = target ? target.closest('.card') : null;
  const targetId = targetCard?.dataset.sessionId;
  if (targetId && targetId !== conn.fromCardId) {
    addEdge(conn.fromCardId, targetId, 'none');
    return;
  }
  // Otherwise: dropped on empty space -> offer to spawn a new conversation there.
  state.pendingSpawn = { fromCardId: conn.fromCardId, flowX: conn.x, flowY: conn.y };
  openSpawnPreview();
}

function removeEdge(id) {
  const edge = state.edges.find((x) => x.id === id);
  if (!edge) return;
  state.edges = state.edges.filter((x) => x.id !== id);
  window.studio.saveEdges(state.edges);
  renderEdges();
  toast('已删除连线');
}

function addEdge(fromCardId, toCardId, kind, injectedText) {
  const id = 'e' + Math.random().toString(36).slice(2, 9);
  state.edges.push({ id, fromCardId, toCardId, kind, injectedText });
  window.studio.saveEdges(state.edges);
  renderEdges();
  return id;
}

// ---- spawn preview ---------------------------------------------------------

async function openSpawnPreview() {
  const pending = state.pendingSpawn;
  if (!pending) return;
  const from = state.byId.get(pending.fromCardId);
  let existing = document.getElementById('spawn');
  if (existing) existing.remove();

  const box = document.createElement('div');
  box.id = 'spawn';
  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'spawn-head';
  head.textContent = '连线分叉：开一个带上下文的新对话';
  const close = document.createElement('button');
  close.className = 'panel-close';
  close.textContent = '✕';
  close.addEventListener('click', closeSpawn);
  head.appendChild(close);
  box.appendChild(head);

  const fromLine = document.createElement('div');
  fromLine.className = 'spawn-from';
  fromLine.textContent = '来源：' + (from?.title ?? pending.fromCardId);
  box.appendChild(fromLine);

  // mode picker
  const modes = document.createElement('div');
  modes.className = 'spawn-modes';
  let mode = 'digest';
  const buttons = {};
  for (const [key, spec] of Object.entries(EDGE_KINDS)) {
    const b = document.createElement('button');
    b.className = 'spawn-mode' + (key === mode ? ' active' : '');
    b.textContent = spec.label;
    b.addEventListener('click', () => {
      mode = key;
      for (const [k, el] of Object.entries(buttons)) el.classList.toggle('active', k === mode);
      hint.textContent = EDGE_KINDS[mode].hint;
      textarea.style.display = mode === 'full' ? 'none' : '';
    });
    buttons[key] = b;
    modes.appendChild(b);
  }
  box.appendChild(modes);

  const hint = document.createElement('div');
  hint.className = 'spawn-hint';
  hint.textContent = EDGE_KINDS[mode].hint;
  box.appendChild(hint);

  const textarea = document.createElement('textarea');
  textarea.className = 'spawn-text';
  textarea.placeholder = '将要注入的内容，可编辑…';
  box.appendChild(textarea);

  // prefill from the source digest
  const dg = await window.studio.digest(pending.fromCardId).catch(() => null);
  if (dg?.ok && dg.value) {
    textarea.value = buildInjectedText(from?.title ?? '原会话', dg.value);
  }

  const foot = document.createElement('div');
  foot.className = 'spawn-foot';
  const cancel = document.createElement('button');
  cancel.className = 'dlg-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeSpawn);
  const ok = document.createElement('button');
  ok.className = 'dlg-btn dlg-primary';
  ok.textContent = '开新对话';
  foot.appendChild(cancel);
  foot.appendChild(ok);
  box.appendChild(foot);

  ok.addEventListener('click', async () => {
    ok.disabled = true;
    ok.textContent = '创建中…';
    const res = await window.studio.spawn({
      fromSessionId: pending.fromCardId,
      mode,
      text: mode === 'full' ? undefined : textarea.value,
    });
    if (!res?.ok) {
      toast('创建失败: ' + String(res?.error ?? '').slice(0, 60), 'error');
      ok.disabled = false;
      ok.textContent = '开新对话';
      return;
    }
    // the new card belongs next to where the line was dropped
    const newId = res.sessionId;
    state.positions.set(newId, {
      x: snap(pending.flowX - CARD_W / 2),
      y: snap(pending.flowY - 66),
    });
    window.studio.savePosition(newId, state.positions.get(newId));
    closeSpawn();
    toast('已创建新对话');
    await reload();
    selectSession(newId);
  });

  document.getElementById('canvas-wrap').appendChild(box);
}

function closeSpawn() {
  const el = document.getElementById('spawn');
  if (el) el.remove();
  state.pendingSpawn = null;
}

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

canvasEl.addEventListener('click', (e) => {
  const path = e.target.closest && e.target.closest('path.edge');
  if (!path) return;
  const id = path.dataset.edgeId;
  if (!id || id === '__temp') return;
  e.stopPropagation();
  removeEdge(id);
});

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
    // Workspaces define the grouping frames.
    try {
      const wz = await window.studio.workspaces();
      if (wz?.ok) {
        state.workspaces = wz.value.items ?? [];
        state.pinnedSet = new Set(wz.value.pinnedSessionIds ?? []);
      }
    } catch {}

    try {
      const savedEdges = await window.studio.loadEdges();
      if (Array.isArray(savedEdges)) state.edges = savedEdges;
    } catch {}

    const saved = await window.studio.loadLayout();
    for (const [id, pos] of Object.entries(saved || {})) {
      if (pos && typeof pos.x === 'number') state.positions.set(id, pos);
    }
    ensureLayout();
    ensureFrames();
    render();
    setStatus(board.length + ' 个会话 · ' + state.workspaces.length + ' 个分组');

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

// ---- status rail (left) ---------------------------------------------------

function statusOf(s) {
  if (s.running) return { kind: 'running', label: '运行中' };
  return null;
}

function renderRail() {
  let rail = document.getElementById('rail');
  if (!rail) {
    rail = document.createElement('div');
    rail.id = 'rail';
    document.getElementById('canvas-wrap').appendChild(rail);
  }
  const rows = state.sessions.filter((s) => statusOf(s) !== null);
  rail.innerHTML = '';
  rail.hidden = rows.length === 0;
  if (rows.length === 0) return;

  const head = document.createElement('div');
  head.className = 'rail-head';
  head.textContent = '队列中的任务 · ' + rows.length;
  rail.appendChild(head);

  for (const s of rows) {
    const st = statusOf(s);
    const row = document.createElement('div');
    row.className = 'rail-row';
    const dot = document.createElement('span');
    dot.className = 'card-dot running';
    row.appendChild(dot);
    const label = document.createElement('span');
    label.className = 'rail-title';
    label.textContent = s.title;
    row.appendChild(label);
    row.addEventListener('click', () => { selectSession(s.sessionId); focusCard(s.sessionId); });
    rail.appendChild(row);
  }
}

function focusCard(sessionId) {
  const p = state.positions.get(sessionId);
  if (!p) return;
  const wrap = document.getElementById('canvas-wrap').getBoundingClientRect();
  state.camera.x = wrap.width / 2 - (p.x + CARD_W / 2) * state.camera.zoom;
  state.camera.y = wrap.height / 2 - (p.y + 60) * state.camera.zoom;
  applyCamera();
}

// ---- batch bar ------------------------------------------------------------

function renderBatchBar() {
  let bar = document.getElementById('batchbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'batchbar';
    document.getElementById('canvas-wrap').appendChild(bar);
  }
  bar.hidden = !state.batchMode;
  if (!state.batchMode) return;
  bar.innerHTML = '';
  const count = document.createElement('span');
  count.className = 'batch-count';
  count.textContent = '已选 ' + state.picked.size + ' 个对话';
  bar.appendChild(count);
  const mk = (label, cls, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'batch-btn ' + cls;
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    return b;
  };
  bar.appendChild(mk('归档', '', () => runBatch('archive'), state.picked.size === 0));
  bar.appendChild(mk('删除', 'danger', () => runBatch('delete'), state.picked.size === 0));
  bar.appendChild(mk('取消', '', () => { state.batchMode = false; state.picked.clear(); render(); }));
}

async function runBatch(kind) {
  const ids = [...state.picked];
  if (ids.length === 0) return;
  if (kind === 'delete') {
    const ok = await confirmDialog({
      title: '删除这 ' + ids.length + ' 个对话？',
      body: '它们会被移入回收站。仍在运行的会先被停止。',
      okLabel: '删除', danger: true,
    });
    if (!ok) return;
  }
  let done = 0, failed = 0;
  for (const id of ids) {
    const res = await window.studio.action(kind === 'delete' ? 'delete' : 'archive', id);
    if (res?.ok) done++; else failed++;
  }
  state.sessions = state.sessions.filter((s) => !state.picked.has(s.sessionId));
  state.picked.forEach((id) => state.positions.delete(id));
  state.picked.clear();
  state.batchMode = false;
  toast((kind === 'delete' ? '已删除 ' : '已归档 ') + done + (failed ? '，失败 ' + failed : ''));
  render();
}

// toggle batch mode from the top bar
document.getElementById('btn-batch').addEventListener('click', () => {
  state.batchMode = !state.batchMode;
  state.picked.clear();
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.batchMode) {
    state.batchMode = false;
    state.picked.clear();
    render();
  }
});

// keep rail and batch bar in sync with render()
const _render = render;
render = function () {
  _render();
  renderRail();
  renderBatchBar();
};

// Test seam: the app exposes its state so verification can exercise paths
// that need live engine data (e.g. the status rail when nothing is running).
window.__studioDebug = {
  state,
  render: () => render(),
  setRunning(ids) {
    const set = new Set(ids);
    for (const s of state.sessions) s.running = set.has(s.sessionId);
    render();
  },
};

reload();
