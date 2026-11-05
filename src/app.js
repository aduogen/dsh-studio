// Canvas-first client: sessions are cards you drag on an infinite board.
const canvasEl = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('empty');

const state = {
  sessions: [],
  positions: new Map(),   // sessionId -> {x, y}
  selected: null,
  camera: { x: 0, y: 0, zoom: 1 },
  dragging: null,
};

const CARD_W = 236;
const CARD_GAP_X = 28;
const CARD_GAP_Y = 24;
const COLS = 4;

function setStatus(text) { statusEl.textContent = text; }

function relTime(ts) {
  if (!ts) return '';
  const d = Math.now === undefined ? Date.now() - ts : Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

// Deterministic grid placement so the board is stable across restarts.
function ensureLayout() {
  let i = 0;
  for (const s of state.sessions) {
    if (state.positions.has(s.sessionId)) continue;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    state.positions.set(s.sessionId, {
      x: 60 + col * (CARD_W + CARD_GAP_X),
      y: 48 + row * (110 + CARD_GAP_Y),
    });
    i++;
  }
}

function applyCamera() {
  const c = state.camera;
  canvasEl.style.backgroundPosition = c.x + 'px ' + c.y + 'px';
  for (const el of canvasEl.querySelectorAll('.card')) {
    const p = state.positions.get(el.dataset.sessionId);
    if (!p) continue;
    el.style.left = (p.x * c.zoom + c.x) + 'px';
    el.style.top = (p.y * c.zoom + c.y) + 'px';
    el.style.transform = 'scale(' + c.zoom + ')';
    el.style.transformOrigin = '0 0';
  }
}

function render() {
  canvasEl.querySelectorAll('.card').forEach((el) => el.remove());
  for (const s of state.sessions) {
    const p = state.positions.get(s.sessionId);
    if (!p) continue;
    const v = s.projections?.values ?? {};
    const title = v.title || '(未命名会话)';
    const running = s.running === true || v.running === true;

    const card = document.createElement('div');
    card.className = 'card' + (state.selected === s.sessionId ? ' selected' : '');
    card.dataset.sessionId = s.sessionId;

    const t = document.createElement('div');
    t.className = 'card-title';
    t.textContent = title;
    card.appendChild(t);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const dot = document.createElement('span');
    dot.className = 'card-dot' + (running ? ' running' : '');
    meta.appendChild(dot);
    const time = document.createElement('span');
    time.textContent = relTime(s.updatedAt);
    meta.appendChild(time);
    card.appendChild(meta);

    if (s.cwd) {
      const cwd = document.createElement('div');
      cwd.className = 'card-cwd';
      cwd.textContent = s.cwd;
      card.appendChild(cwd);
    }

    card.addEventListener('mousedown', (e) => startDrag(e, s.sessionId));
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selected = s.sessionId;
      document.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
      card.classList.add('selected');
      window.studio?.selectSession?.(s.sessionId);
    });
    canvasEl.appendChild(card);
  }
  emptyEl.hidden = state.sessions.length > 0;
  applyCamera();
}

function startDrag(e, sessionId) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const start = state.positions.get(sessionId);
  const z = state.camera.zoom;
  const ox = e.clientX, oy = e.clientY;
  state.dragging = { sessionId, start, ox, oy, z, moved: false };
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
  if (d?.moved) {
    const p = state.positions.get(d.sessionId);
    if (p) window.studio?.savePosition?.(d.sessionId, p);
  }
}

// Pan the board by dragging empty space.
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
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const next = Math.min(2, Math.max(0.35, c.zoom * factor));
  const k = next / c.zoom;
  c.x = mx - (mx - c.x) * k;
  c.y = my - (my - c.y) * k;
  c.zoom = next;
  applyCamera();
}, { passive: false });

document.getElementById('btn-fit').addEventListener('click', () => {
  state.camera = { x: 0, y: 0, zoom: 1 };
  applyCamera();
});
document.getElementById('btn-reload').addEventListener('click', () => loadSessions());

async function loadSessions() {
  setStatus('正在读取会话…');
  try {
    const result = await window.studio.invoke('session/list');
    const items = result?.items ?? [];
    // keep the running ones and the most recent 60: the board stays readable
    state.sessions = items
      .filter((s) => s.blank !== true)
      .slice(0, 60);
    ensureLayout();
    render();
    setStatus(state.sessions.length + ' 个会话');
  } catch (err) {
    setStatus('读取失败: ' + String(err.message ?? err).slice(0, 80));
  }
}

loadSessions();
