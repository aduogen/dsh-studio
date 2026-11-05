// Canvas-first client. Sessions are cards on an infinite board;
// clicking one opens a conversation panel inside the canvas (no navigation away).

import { showMenu, closeMenu, toast, confirmDialog, promptDialog } from './menu.js';
import { EDGE_KINDS, sideHandles, anchor, curvePath, distToSegment, buildInjectedText } from './edges.js';
import { t, activeLocale, setLocalePref, getLocalePref, subscribeLocale, initFontScale, increaseFont, decreaseFont, resetFont, canIncrease, canDecrease, fontStep, subscribeFont } from './i18n.js';

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
  digests: new Map(),      // sessionId -> {summary, keyFindings, nextStep}
  digestBusy: new Set(),   // sessionIds currently generating
  status: new Map(),       // sessionId -> {running, active, waiting, draft, lastSeq}
  ghosts: new Set(),       // card ids whose session no longer exists
  dismissed: new Set(),    // session ids the user removed from the board on purpose
  wsColors: new Map(),     // workspaceId -> colour
  stacked: new Map(),      // workspaceId -> true when folded into a stack cell
  groupView: null,         // workspaceId shown in the folder-style panel
};

const snap = (v) => Math.round(v / GRID) * GRID;
const STACK_LIMIT = 8;   // cards shown before a workspace folds the rest away

// Members visible on the board; the remainder collapses into one stack cell.
function workspaceLayout(w) {
  const memberSet = new Set(w.sessionIds);
  const members = state.sessions.filter((s) => memberSet.has(s.sessionId));
  const visible = members.slice(0, STACK_LIMIT);
  const folded = members.slice(STACK_LIMIT);
  return { members, visible, folded };
}

initFontScale();
// Follow the OS colour scheme.
const mq = window.matchMedia('(prefers-color-scheme: light)');
const applyScheme = () => {
  document.documentElement.dataset.scheme = mq.matches ? 'light' : 'dark';
};
applyScheme();
mq.addEventListener('change', applyScheme);
subscribeLocale(() => { applyStaticText(); render(); });
subscribeFont(() => { applyStaticText(); render(); });

// Every static label in the chrome is owned here, so a locale switch repaints them.
function applyStaticText() {
  const brand = document.getElementById('brand');
  if (brand) brand.textContent = t('app.brand');
  const search = document.getElementById('search');
  if (search) search.placeholder = t('search.placeholder');
  const bb = document.getElementById('btn-batch');
  if (bb) bb.textContent = t('btn.batch');
  const bf = document.getElementById('btn-fit');
  if (bf) bf.textContent = t('btn.fit');
  const br = document.getElementById('btn-reload');
  if (br) br.textContent = t('btn.reload');
  const lang = document.getElementById('btn-lang');
  if (lang) {
    const pref = getLocalePref();
    lang.textContent = pref === 'auto' ? t('lang.auto') : (pref === 'zh' ? '中文' : 'English');
    lang.title = t('lang.hint', {
      cur: pref === 'auto' ? t('lang.auto') : pref,
      nxt: pref === 'auto' ? '中文' : (pref === 'zh' ? 'English' : t('lang.auto')),
    });
  }
  const fi = document.getElementById('btn-font-plus');
  if (fi) { fi.disabled = !canIncrease(); fi.title = t('font.increase'); }
  const fd = document.getElementById('btn-font-minus');
  if (fd) { fd.disabled = !canDecrease(); fd.title = t('font.decrease'); }
  const fr = document.getElementById('btn-font-reset');
  if (fr) { fr.textContent = t('font.reset'); fr.title = t('font.reset'); }
}

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
  // A workspace larger than STACK_LIMIT keeps its first members and folds the rest.
  let cursorY = 48;
  for (const w of state.workspaces) {
    const { members, visible } = workspaceLayout(w);
    if (members.length === 0) continue;
    let i = 0;
    for (const s of visible) {
      if (!state.positions.has(s.sessionId)) {
        const col = i % COLS, row = Math.floor(i / COLS);
        state.positions.set(s.sessionId, {
          x: snap(80 + col * (CARD_W + CARD_GAP_X)),
          y: snap(cursorY + 26 + row * (132 + CARD_GAP_Y)),
        });
      }
      i++;
    }
    const rows = Math.ceil(visible.length / COLS);
    cursorY = snap(cursorY + 26 + rows * (132 + CARD_GAP_Y) + 30);
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

// A workspace larger than STACK_LIMIT keeps a folded stack card on the board.
// Clicking it opens the group as a centred panel that shows every member card
// in a grid, mirroring the original plugin's "open the folder" behaviour.
function renderStackCells() {
  canvasEl.querySelectorAll('.stack-cell').forEach((el) => el.remove());
  const c = state.camera;
  for (const w of state.workspaces) {
    const { folded } = workspaceLayout(w);
    if (folded.length === 0) continue;
    const r = state.wsRect.get(w.workspaceId);
    if (!r) continue;

    const cell = document.createElement('div');
    cell.className = 'stack-cell';
    cell.style.left = (r.x * c.zoom + c.x) + 'px';
    cell.style.top = ((r.y + r.h + 8) * c.zoom + c.y) + 'px';
    cell.style.transform = 'scale(' + c.zoom + ')';
    cell.style.transformOrigin = '0 0';

    // Three stacked sheets, exactly like the original stack node.
    for (const cls of ['stack-sheet-back', 'stack-sheet-mid']) {
      const sheet = document.createElement('span');
      sheet.className = cls;
      cell.appendChild(sheet);
    }
    const face = document.createElement('div');
    face.className = 'stack-face';
    const faceTitle = document.createElement('span');
    faceTitle.className = 'stack-face-title';
    faceTitle.textContent = w.title;
    face.appendChild(faceTitle);
    const badge = document.createElement('span');
    badge.className = 'stack-badge';
    badge.textContent = '+' + folded.length;
    face.appendChild(badge);
    cell.appendChild(face);

    cell.title = '展开这个分组的 ' + folded.length + ' 个对话';
    cell.addEventListener('mousedown', (e) => e.stopPropagation());
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      openGroupView(w.workspaceId);
    });
    canvasEl.appendChild(cell);
  }
}

// The group view: a big centred panel listing every member as a card.
function openGroupView(workspaceId) {
  state.groupView = workspaceId;
  renderGroupView();
}

function closeGroupView() {
  state.groupView = null;
  const el = document.getElementById('groupview');
  if (el) el.remove();
}

function renderGroupView() {
  const wsId = state.groupView;
  if (!wsId) { closeGroupView(); return; }
  const w = state.workspaces.find((x) => x.workspaceId === wsId);
  if (!w) { closeGroupView(); return; }

  let back = document.getElementById('groupview');
  if (back) back.remove();
  back = document.createElement('div');
  back.id = 'groupview';

  const box = document.createElement('div');
  box.className = 'gv-box';

  const head = document.createElement('div');
  head.className = 'gv-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'gv-title';
  titleEl.textContent = w.title;
  head.appendChild(titleEl);
  const countEl = document.createElement('span');
  countEl.className = 'gv-count';
  countEl.textContent = '共 ' + w.sessionIds.length + ' 个对话';
  head.appendChild(countEl);
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  head.appendChild(spacer);

  const search = document.createElement('input');
  search.className = 'gv-search';
  search.placeholder = '搜这个分组里的卡片';
  head.appendChild(search);

  const close = document.createElement('button');
  close.className = 'panel-close';
  close.textContent = '✕';
  close.title = '收起（Esc）';
  close.addEventListener('click', closeGroupView);
  head.appendChild(close);
  box.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'gv-grid';
  box.appendChild(grid);

  const memberSet = new Set(w.sessionIds);
  const members = state.sessions.filter((x) => memberSet.has(x.sessionId));

  const paint = (filterText) => {
    grid.innerHTML = '';
    const q = String(filterText ?? '').trim().toLowerCase();
    const shown = members.filter((x) => !q || x.title.toLowerCase().includes(q));
    if (shown.length === 0) {
      const none = document.createElement('div');
      none.className = 'gv-empty';
      none.textContent = '没有匹配的对话';
      grid.appendChild(none);
      return;
    }
    for (const item of shown) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'gv-card';
      card.dataset.sessionId = item.sessionId;

      const top = document.createElement('div');
      top.className = 'gv-card-top';
      if (item.pinned) {
        const pin = document.createElement('span');
        pin.className = 'gv-pin';
        pin.textContent = '📌';
        top.appendChild(pin);
      }
      const t2 = document.createElement('span');
      t2.className = 'gv-card-title';
      t2.textContent = item.title;
      top.appendChild(t2);
      card.appendChild(top);

      if (item.lastPrompt) {
        const pv = document.createElement('div');
        pv.className = 'gv-card-preview';
        pv.textContent = item.lastPrompt;
        card.appendChild(pv);
      }

      const foot = document.createElement('div');
      foot.className = 'gv-card-meta';
      const st2 = state.status.get(item.sessionId) || {};
      const dot = document.createElement('span');
      dot.className = 'card-dot' + (st2.running || item.running ? ' running' : '');
      foot.appendChild(dot);
      const tm = document.createElement('span');
      tm.textContent = relTime(item.updatedAt);
      foot.appendChild(tm);
      card.appendChild(foot);

      card.addEventListener('mousedown', (e) => e.stopPropagation());
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        closeGroupView();
        selectSession(item.sessionId);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCardMenu(e.clientX, e.clientY, item);
      });
      grid.appendChild(card);
    }
  };
  paint('');
  search.addEventListener('input', () => paint(search.value));

  back.addEventListener('mousedown', (e) => {
    if (e.target === back) closeGroupView();
  });
  back.appendChild(box);
  document.getElementById('canvas-wrap').appendChild(back);
  setTimeout(() => search.focus(), 40);
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
    const colour = state.wsColors.get(w.workspaceId);
    if (colour) {
      el.style.borderColor = colour;
      el.style.background = colour + '0d';
    }

    const label = document.createElement('div');
    label.className = 'frame-label';
    label.style.fontSize = Math.max(10, 11 * c.zoom) + 'px';
    label.title = w.path;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = w.title + ' · ' + w.sessionIds.length;
    label.appendChild(nameSpan);

    const { folded } = workspaceLayout(w);
    if (folded.length > 0) {
      const foldBtn = document.createElement('button');
      foldBtn.className = 'frame-fold';
      foldBtn.textContent = '折叠 ' + folded.length + ' 个 ▸';
      foldBtn.title = '展开这个分组';
      foldBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      foldBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGroupView(w.workspaceId);
      });
      label.appendChild(foldBtn);
    }
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
    let cls = 'edge';
    if (edge.pending) cls += ' pending';
    if (edge.kind === 'full') cls += ' full';
    else if (edge.lastPushAt !== undefined) {
      const src = state.status.get(edge.fromCardId);
      const stale = src && src.lastSeq !== null && src.lastSeq !== undefined
        && src.lastSeq > (edge.pushedSeq ?? 0);
      cls += stale ? ' behind' : ' synced';
    }
    if (edge.autoPush) cls += ' auto';
    path.setAttribute('class', cls);
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
  renderStackCells();
  renderEdges();
}

function cardBadges(s) {
  const out = [];
  const st = state.status.get(s.sessionId) ?? {};
  if (st.running || s.running) out.push(['running', '运行中']);
  if (st.waiting) out.push(['waiting', '等你回复']);
  if (st.draft) out.push(['draft', '待发送']);
  if (s.pinned) out.push(['pin', '置顶']);
  return out;
}

function openCardMenu(x, y, s) {
  const dg = state.digests.get(s.sessionId);
  const groupItems = state.workspaces.length > 1
    ? state.workspaces.map((w) => ({
        label: '移入「' + w.title + '」',
        run: () => moveToWorkspace(s, w),
      }))
    : [];
  showMenu(x, y, [
    { label: t('menu.open'), run: () => selectSession(s.sessionId) },
    { label: s.pinned ? t('menu.unpin') : t('menu.pin'), run: () => runAction(s.pinned ? 'unpin' : 'pin', s) },
    { label: t('menu.rename'), run: () => renameCard(s) },
    ...(dg ? [{ label: '查看摘要…', run: () => showDigestDialog(s) }] : []),
    ...(groupItems.length ? [{ separator: true }, ...groupItems] : []),
    { separator: true },
    { label: s.running ? t('menu.stop') : t('menu.archive'), run: () => s.running ? runAction('cancel', s) : runAction('archive', s) },
    { label: t('menu.delete'), danger: true, run: () => deleteCard(s) },
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
  // A card can be removed from the board without touching the conversation.
  const ok = await confirmDialog({
    title: '删除这个会话？',
    body: '「' + s.title + '」会被移入回收站。仍在运行的会话会先被停止。',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  const res = await window.studio.action('delete', s.sessionId);
  if (!res?.ok) {
    toast(friendlyError(res?.error), 'error');
    return;
  }
  removeCardLocal(s.sessionId);
  toast('已删除');
}

let render = function () {
  canvasEl.querySelectorAll('.card').forEach((el) => el.remove());
  const q = state.query.trim().toLowerCase();
  for (const s of state.sessions) {
    const p = state.positions.get(s.sessionId);
    if (!p) continue;
    if (q && !(s.title.toLowerCase().includes(q) || (s.lastPrompt || '').toLowerCase().includes(q))) continue;

    const isPinned = s.pinned === true || state.pinnedSet.has(s.sessionId);

    const isHit = state.query.trim().length >= 2
      && (s.title.toLowerCase().includes(state.query.trim().toLowerCase())
        || (s.lastPrompt ?? '').toLowerCase().includes(state.query.trim().toLowerCase()));
    const card = document.createElement('div');
    card.className = 'card' + (isHit ? ' hit' : '')
      + (state.selected === s.sessionId ? ' selected' : '')
      + (state.picked.has(s.sessionId) ? ' picked' : '')
      + (s.ghost ? ' ghost' : '');
    card.dataset.sessionId = s.sessionId;

    if (state.batchMode) {
      const box = document.createElement('span');
      box.className = 'pick-box' + (state.picked.has(s.sessionId) ? ' on' : '');
      box.textContent = state.picked.has(s.sessionId) ? '✓' : '';
      card.appendChild(box);
    }
    const head = document.createElement('div');
    head.className = 'card-top';
    const ghost = s.ghost === true;
    if (isPinned) {
      const pin = document.createElement('span');
      pin.className = 'card-pin';
      pin.textContent = '📌';
      head.appendChild(pin);
    }
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = ghost ? '会话已不存在' : s.title;
    head.appendChild(title);
    if (ghost) {
      const rm = document.createElement('button');
      rm.className = 'card-remove';
      rm.textContent = '移除卡片';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeCardLocal(s.sessionId);
        toast('已移除卡片');
      });
      card.appendChild(rm);
    }
    card.appendChild(head);

    if (s.lastPrompt) {
      const pv = document.createElement('div');
      pv.className = 'card-preview';
      pv.textContent = s.lastPrompt;
      card.appendChild(pv);
    }

    const dg = state.digests.get(s.sessionId);
    const st = state.status.get(s.sessionId) ?? {};
    const stale = dg?.lastSeq !== undefined && st.lastSeq !== null && st.lastSeq !== undefined
      && st.lastSeq > dg.lastSeq;
    if (dg?.summary) {
      const dgEl = document.createElement('div');
      dgEl.className = 'card-digest';
      dgEl.textContent = (stale ? '⚠ ' : '') + dg.summary;
      dgEl.title = [
        dg.summary,
        ...(dg.keyFindings ?? []).map((x) => '· ' + x),
        dg.nextStep ? '下一步：' + dg.nextStep : '',
      ].filter(Boolean).join('\n');
      if (stale) dgEl.classList.add('stale');
      card.appendChild(dgEl);
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
    const refresh = document.createElement('button');
    refresh.className = 'card-refresh';
    refresh.textContent = state.digestBusy.has(s.sessionId) ? '…' : '⟳';
    refresh.title = '生成 / 重新生成摘要';
    if (state.digestBusy.has(s.sessionId)) refresh.disabled = true;
    refresh.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      generateDigest(s);
    });
    foot.appendChild(refresh);
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

function showDigestDialog(s) {
  const dg = state.digests.get(s.sessionId);
  if (!dg) { toast('这个对话还没有摘要，先点 ⟳ 生成'); return; }
  const back = document.createElement('div');
  back.className = 'dlg-back';
  const box = document.createElement('div');
  box.className = 'dlg dlg-wide';

  const h = document.createElement('div');
  h.className = 'dlg-title';
  h.textContent = '摘要 · ' + s.title;
  box.appendChild(h);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'dlg-body dlg-scroll';
  const full = [
    '概要：' + (dg.summary ?? ''),
    '',
    '关键结论：',
    ...(dg.keyFindings ?? []).map((x) => '· ' + x),
    '',
    '下一步：' + (dg.nextStep || '（已完成）'),
  ].join('\n');
  bodyEl.textContent = full;
  box.appendChild(bodyEl);

  const foot = document.createElement('div');
  foot.className = 'dlg-foot';
  const copy = document.createElement('button');
  copy.className = 'dlg-btn';
  copy.textContent = '复制';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(full);
      toast('已复制');
    } catch {
      toast('复制失败', 'error');
    }
  });
  const closeBtn = document.createElement('button');
  closeBtn.className = 'dlg-btn dlg-primary';
  closeBtn.textContent = '关闭';
  const done = () => back.remove();
  closeBtn.addEventListener('click', done);
  back.addEventListener('mousedown', (e) => { if (e.target === back) done(); });
  foot.appendChild(copy);
  foot.appendChild(closeBtn);
  box.appendChild(foot);
  back.appendChild(box);
  document.body.appendChild(back);
}

async function moveToWorkspace(s, w) {
  const res = await window.studio.action('moveToWorkspace', s.sessionId, w.workspaceId);
  if (!res?.ok) { toast('移入失败: ' + String(res?.error ?? '').slice(0, 60), 'error'); return; }
  toast('已移入「' + w.title + '」');
  state.wsRect.clear();
  await reload();
}

async function createSessionAt(flowX, flowY) {
  const res = await window.studio.spawn({ mode: 'none' });
  if (!res?.ok) { toast('创建失败: ' + String(res?.error ?? '').slice(0, 60), 'error'); return; }
  state.positions.set(res.sessionId, { x: snap(flowX - CARD_W / 2), y: snap(flowY - 60) });
  window.studio.savePosition(res.sessionId, state.positions.get(res.sessionId));
  toast('已创建新对话');
  await reload();
  selectSession(res.sessionId);
}

// Drop a card from the board for good: session list, layout, pending edges.
function removeCardLocal(sessionId) {
  state.dismissed.add(sessionId);
  state.sessions = state.sessions.filter((x) => x.sessionId !== sessionId);
  state.byId.delete(sessionId);
  state.positions.delete(sessionId);
  state.ghosts.delete(sessionId);
  state.status.delete(sessionId);
  state.edges = state.edges.filter((e) => e.fromCardId !== sessionId && e.toCardId !== sessionId);
  window.studio.savePosition(sessionId, null);
  window.studio.saveEdges(state.edges);
  if (state.panelSession === sessionId) closePanel();
  render();
  renderEdges();
}

function persistDigests() {
  window.studio.saveDigests(Object.fromEntries(state.digests));
}

function persistColors() {
  window.studio.saveColors(Object.fromEntries(state.wsColors));
}

async function generateDigest(s) {
  if (state.digestBusy.has(s.sessionId)) return;
  state.digestBusy.add(s.sessionId);
  render();
  toast('正在生成摘要…');
  try {
    const res = await window.studio.genDigest(s.sessionId, s.title);
    if (!res?.ok) {
      toast('摘要失败: ' + String(res?.error ?? '').slice(0, 70), 'error');
      return;
    }
    const st = state.status.get(s.sessionId) ?? {};
    state.digests.set(s.sessionId, { ...res.value, lastSeq: st.lastSeq ?? null, generatedAt: Date.now() });
    persistDigests();
    toast('摘要已生成（' + (res.value.model ?? '') + '）');
  } catch (err) {
    toast('摘要失败: ' + String(err.message ?? err).slice(0, 70), 'error');
  } finally {
    state.digestBusy.delete(s.sessionId);
    render();
  }
}

// ---- side panel inside the canvas -----------------------------------------

async function openPanel(sessionId) {
  const s = state.byId.get(sessionId);
  panelEl.hidden = false;
  panelEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'panel-head';
  // NOTE: do not name this "t" — it would shadow the t() translation helper.
  const titleEl = document.createElement('span');
  titleEl.className = 'panel-title';
  titleEl.textContent = s?.title ?? sessionId;
  head.appendChild(titleEl);
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
  loading.textContent = t('panel.loading');
  body.appendChild(loading);

  // Composer: the panel is a real conversation, not a read-only preview.
  const composer = document.createElement('div');
  composer.className = 'panel-composer';
  const input = document.createElement('textarea');
  input.className = 'panel-input';
  input.rows = 1;
  input.placeholder = '发消息…（Enter 发送，Shift+Enter 换行）';
  const send = document.createElement('button');
  send.className = 'panel-send';
  send.textContent = '发送';
  composer.appendChild(input);
  composer.appendChild(send);
  panelEl.appendChild(composer);

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  };
  input.addEventListener('input', grow);

  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    grow();
    send.disabled = true;
    send.textContent = '…';

    const mine = document.createElement('div');
    mine.className = 'turn mine';
    const mq = document.createElement('div');
    mq.className = 'turn-q';
    mq.textContent = text;
    mine.appendChild(mq);
    body.appendChild(mine);
    body.scrollTop = body.scrollHeight;

    const thinking = document.createElement('div');
    thinking.className = 'panel-meta thinking';
    thinking.textContent = '正在回复…';
    body.appendChild(thinking);
    body.scrollTop = body.scrollHeight;

    const res = await window.studio.chatSend({ sessionId, text });
    thinking.remove();
    send.disabled = false;
    send.textContent = '发送';

    if (!res?.ok) {
      const err = document.createElement('div');
      err.className = 'panel-meta err';
      err.textContent = '回复失败：' + String(res?.error ?? '').slice(0, 120);
      body.appendChild(err);
      return;
    }
    if (res.reply) {
      const bot = document.createElement('div');
      bot.className = 'turn bot';
      const a1 = document.createElement('div');
      a1.className = 'turn-a';
      a1.textContent = res.reply;
      bot.appendChild(a1);
      body.appendChild(bot);
    }
    body.scrollTop = body.scrollHeight;
  };

  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

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
        none.textContent = t('panel.empty');
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

const WS_COLORS = ['#4c8dff', '#38d39f', '#e3b341', '#ff7b72', '#a371f7', '#39c5cf'];

function openFrameMenu(x, y, w) {
  showMenu(x, y, [
    { label: t('menu.renameWs'), run: () => renameWorkspace(w) },
    { label: t('menu.tidyWs'), run: () => { relayoutWorkspace(w); toast('已整理'); } },
    { label: '同步本组新会话', run: () => syncWorkspace(w) },
    { separator: true },
    ...WS_COLORS.map((c) => ({
      label: '标记颜色 ' + c,
      run: () => { state.wsColors.set(w.workspaceId, c); persistColors(); applyCamera(); },
    })),
    { label: '清除颜色', run: () => { state.wsColors.delete(w.workspaceId); persistColors(); applyCamera(); } },
    { separator: true },
    { label: '删除分组', danger: true, run: () => deleteWorkspace(w) },
  ]);
}

// A workspace is a real directory in DSH, so creating one asks for a path.
async function createWorkspaceFlow() {
  const path = await promptDialog({
    title: '新建分组（填写已存在的文件夹路径）',
    value: 'E:/工具/DeepSeek默认工作区',
    okLabel: '创建',
  });
  if (path === null) return;
  const trimmed = path.trim();
  if (!trimmed) return;
  const res = await window.studio.action('createWorkspace', undefined, trimmed);
  if (!res?.ok) {
    const msg = String(res?.error ?? '');
    if (msg.includes('invalid-path') || msg.includes('ENOENT')) {
      toast('这个文件夹不存在，请填一个已存在的目录', 'error');
    } else {
      toast('创建失败: ' + msg.slice(0, 70), 'error');
    }
    return;
  }
  toast('分组已创建');
  state.wsRect.clear();
  await reload();
}

async function syncWorkspace(w) {
  toast('正在同步…');
  const before = w.sessionIds.length;
  const wz = await window.studio.workspaces();
  if (wz?.ok) {
    const fresh = (wz.value.items ?? []).find((x) => x.workspaceId === w.workspaceId);
    if (fresh) {
      w.sessionIds = fresh.sessionIds;
      state.wsRect.delete(w.workspaceId);
      ensureLayout();
      ensureFrames();
      applyCamera();
      const added = fresh.sessionIds.length - before;
      toast(added > 0 ? '已同步，新增 ' + added + ' 个会话' : '已同步，没有新会话');
      return;
    }
  }
  toast('同步失败', 'error');
}

async function deleteWorkspace(w) {
  const ok = await confirmDialog({
    title: '删除这个分组？',
    body: '「' + w.title + '」会被删除。其中的 ' + w.sessionIds.length + ' 个对话仍保留在 DSH 里，只是不再归入分组。',
    okLabel: '删除分组',
    danger: true,
  });
  if (!ok) return;
  const res = await window.studio.action('deleteWorkspace', w.workspaceId);
  if (!res?.ok) { toast('删除失败: ' + String(res?.error ?? '').slice(0, 60), 'error'); return; }
  state.wsRect.delete(w.workspaceId);
  state.wsColors.delete(w.workspaceId);
  toast('已删除分组');
  await reload();
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

function addEdge(fromCardId, toCardId, kind, injectedText, extra = {}) {
  const id = 'e' + Math.random().toString(36).slice(2, 9);
  state.edges.push({ id, fromCardId, toCardId, kind, injectedText, ...extra });
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
  head.textContent = t('spawn.head');
  const close = document.createElement('button');
  close.className = 'panel-close';
  close.textContent = '✕';
  close.addEventListener('click', closeSpawn);
  head.appendChild(close);
  box.appendChild(head);

  const fromLine = document.createElement('div');
  fromLine.className = 'spawn-from';
  fromLine.textContent = t('spawn.from', { t: from?.title ?? pending.fromCardId });
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
  textarea.placeholder = t('draft.injectLabel');
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
  cancel.textContent = t('spawn.cancel');
  cancel.addEventListener('click', closeSpawn);
  const ok = document.createElement('button');
  ok.className = 'dlg-btn dlg-primary';
  ok.textContent = t('spawn.ok');
  foot.appendChild(cancel);
  foot.appendChild(ok);
  box.appendChild(foot);

  ok.addEventListener('click', async () => {
    ok.disabled = true;
    ok.textContent = t('spawn.busy');
    const res = await window.studio.spawn({
      fromSessionId: pending.fromCardId,
      mode,
      text: mode === 'full' ? undefined : textarea.value,
    });
    if (!res?.ok) {
      toast('创建失败: ' + String(res?.error ?? '').slice(0, 60), 'error');
      ok.disabled = false;
      ok.textContent = t('spawn.ok');
      return;
    }
    // the new card belongs next to where the line was dropped
    const newId = res.sessionId;
    state.positions.set(newId, {
      x: snap(pending.flowX - CARD_W / 2),
      y: snap(pending.flowY - 66),
    });
    window.studio.savePosition(newId, state.positions.get(newId));
    // Keep the line the user drew: bind it to the new card instead of dropping it.
    const edgeKind = mode === 'full' ? 'full' : (mode === 'digest' ? 'digest' : 'none');
    addEdge(pending.fromCardId, newId, edgeKind, mode === 'full' ? undefined : textarea.value);
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

let marquee = null;
let panning = null;
canvasEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // Alt+drag empty space draws a selection rectangle for batch picking.
  if (e.altKey && !e.target.closest('.card') && !e.target.closest('.stack-cell')) {
    const rect = canvasEl.getBoundingClientRect();
    marquee = { x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top };
    state.batchMode = true;
    document.addEventListener('mousemove', onMarquee);
    document.addEventListener('mouseup', endMarquee, { once: true });
    return;
  }
  if (e.target.closest('.card')) return;
  canvasEl.classList.add('dragging');
  panning = { ox: e.clientX, oy: e.clientY, cx: state.camera.x, cy: state.camera.y };
  document.addEventListener('mousemove', onPan);
  document.addEventListener('mouseup', endPan, { once: true });
});
function onMarquee(e) {
  if (!marquee) return;
  const rect = canvasEl.getBoundingClientRect();
  marquee.x1 = e.clientX - rect.left;
  marquee.y1 = e.clientY - rect.top;
  let el = document.getElementById('marquee');
  if (!el) {
    el = document.createElement('div');
    el.id = 'marquee';
    canvasEl.appendChild(el);
  }
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = Math.abs(marquee.x1 - marquee.x0) + 'px';
  el.style.height = Math.abs(marquee.y1 - marquee.y0) + 'px';
}

function endMarquee() {
  if (!marquee) return;
  const m = marquee;
  marquee = null;
  document.removeEventListener('mousemove', onMarquee);
  const el = document.getElementById('marquee');
  if (el) el.remove();
  const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
  const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
  const c = state.camera;
  for (const s of state.sessions) {
    const p = state.positions.get(s.sessionId);
    if (!p) continue;
    const left = p.x * c.zoom + c.x;
    const top = p.y * c.zoom + c.y;
    const right = left + CARD_W * c.zoom;
    const bottom = top + 132 * c.zoom;
    const overlaps = left < x1 && right > x0 && top < y1 && bottom > y0;
    if (overlaps) state.picked.add(s.sessionId);
  }
  render();
}

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
  const edge = state.edges.find((x) => x.id === id);
  if (!edge) return;
  const src = state.byId.get(edge.fromCardId);
  showMenu(e.clientX, e.clientY, [
    { label: '推送最新摘要', run: () => pushDigest(edge) },
    { label: edge.autoPush ? '关闭自动推送' : '开启自动推送', run: () => toggleAutoPush(edge) },
    { separator: true },
    { label: '删除连线', danger: true, run: () => removeEdge(id) },
  ]);
});

// Push: append one source summary message into the target conversation.
async function pushDigest(edge) {
  const src = state.byId.get(edge.fromCardId);
  const dst = state.byId.get(edge.toCardId);
  if (!src || !dst) return;
  let dg = state.digests.get(edge.fromCardId);
  if (!dg?.summary) {
    toast('来源还没有摘要，先点 ⟳ 生成');
    return;
  }
  const stamp = new Date().toLocaleString('zh-CN');
  const text = '【来自「' + src.title + '」的更新 · ' + stamp + '】\n\n' +
    '摘要：' + dg.summary + '\n' +
    (dg.keyFindings?.length ? '关键结论：\n' + dg.keyFindings.map((x) => '· ' + x).join('\n') + '\n' : '') +
    (dg.nextStep ? '下一步：' + dg.nextStep : '');
  const res = await window.studio.push({ sessionId: dst.sessionId, text });
  if (!res?.ok) { toast('推送失败: ' + String(res?.error ?? '').slice(0, 60), 'error'); return; }
  const st = state.status.get(edge.fromCardId) ?? {};
  edge.lastPushAt = Date.now();
  edge.pushedSeq = st.lastSeq ?? 0;
  window.studio.saveEdges(state.edges);
  toast('已推送给「' + dst.title + '」');
  renderEdges();
}

function toggleAutoPush(edge) {
  edge.autoPush = !edge.autoPush;
  window.studio.saveEdges(state.edges);
  toast(edge.autoPush ? '已开启自动推送' : '已关闭自动推送');
  renderEdges();
}

canvasEl.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.card') || e.target.closest('.frame-label') || e.target.closest('.stack-cell')) return;
  e.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  const wx = e.clientX - rect.left, wy = e.clientY - rect.top;
  const flowX = (wx - state.camera.x) / state.camera.zoom;
  const flowY = (wy - state.camera.y) / state.camera.zoom;
  showMenu(e.clientX, e.clientY, [
    { label: '新对话', run: () => createSessionAt(flowX, flowY) },
    { label: '新建分组…', run: () => createWorkspaceFlow() },
    { separator: true },
    { label: '整理所有分组', run: () => { state.wsRect.clear(); ensureFrames(); applyCamera(); toast('已整理'); } },
  ]);
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
let searchTimer = null;
searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  render();                             // instant title filter
  clearTimeout(searchTimer);
  if (state.query.trim().length < 2) { renderHits({ items: [] }); return; }
  searchTimer = setTimeout(() => runContentSearch(state.query.trim()), 420);
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runContentSearch(searchEl.value.trim()); }
});

async function runContentSearch(q) {
  if (!q) return;
  renderHits({ loading: true });
  const res = await window.studio.search(q);
  renderHits(res);
}

function renderHits(res) {
  let box = document.getElementById('hits');
  if (!box) {
    box = document.createElement('div');
    box.id = 'hits';
    document.getElementById('canvas-wrap').appendChild(box);
  }
  box.innerHTML = '';
  const q = state.query.trim();
  if (!q || q.length < 2) { box.hidden = true; return; }
  box.hidden = false;

  const head = document.createElement('div');
  head.className = 'hits-head';
  head.textContent = res.loading ? t('hits.loading') : t('hits.head', { n: res.items?.length ?? 0 });
  box.appendChild(head);

  if (res.disabled) {
    const n = document.createElement('div');
    n.className = 'hits-note';
    n.textContent = t('hits.disabled');
    box.appendChild(n);
    return;
  }
  if (res.error) {
    const n = document.createElement('div');
    n.className = 'hits-note';
    n.textContent = '搜索失败：' + res.error;
    box.appendChild(n);
    return;
  }
  for (const hit of (res.items ?? []).slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'hit-row';
    const s = state.byId.get(hit.sessionId);
    const title = document.createElement('div');
    title.className = 'hit-title';
    title.textContent = s?.title ?? hit.sessionId.slice(0, 8);
    const snip = document.createElement('div');
    snip.className = 'hit-snip';
    snip.textContent = hit.snippet ?? '';
    row.appendChild(title);
    row.appendChild(snip);
    row.addEventListener('click', () => {
      if (s) selectSession(hit.sessionId);
      focusCard(hit.sessionId);
    });
    box.appendChild(row);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenu();
  if (state.groupView) { closeGroupView(); return; }
  if (!panelEl.hidden) closePanel();
  else { state.selected = null; render(); }
});

async function reload() {
  setStatus(t('status.loading'));
  try {
    const board = await window.studio.board();
    state.sessions = board.filter((r) => !state.dismissed.has(r.sessionId));
    state.byId = new Map(state.sessions.map((s) => [s.sessionId, s]));
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
    try {
      const savedDigests = await window.studio.loadDigests();
      for (const [id, dg] of Object.entries(savedDigests ?? {})) state.digests.set(id, dg);
    } catch {}
    try {
      const savedColors = await window.studio.loadColors();
      for (const [id, c] of Object.entries(savedColors ?? {})) state.wsColors.set(id, c);
    } catch {}

    const saved = await window.studio.loadLayout();
    for (const [id, pos] of Object.entries(saved || {})) {
      if (pos && typeof pos.x === 'number') state.positions.set(id, pos);
    }
    // Cards whose session vanished from the engine become ghosts instead of disappearing.
    const live = new Set(state.sessions.map((s) => s.sessionId));
    for (const [id] of state.positions) {
      if (live.has(id)) continue;
      if (state.ghosts.has(id)) continue;
      if (state.dismissed.has(id)) continue;
      state.ghosts.add(id);
      state.sessions.push({
        sessionId: id, title: '会话已不存在', cwd: '', updatedAt: 0,
        running: false, ghost: true,
      });
      state.byId.set(id, state.sessions[state.sessions.length - 1]);
    }

    ensureLayout();
    ensureFrames();
    render();
    setStatus(t('status.count', { n: board.length, w: state.workspaces.length }));

    // Second pass: real per-session status, bounded batches, off the critical path.
    window.studio.status(board.map((s) => s.sessionId)).then((map) => {
      let changed = false;
      for (const [id, st] of Object.entries(map ?? {})) {
        state.status.set(id, st);
        const row = state.byId.get(id);
        if (row && row.running !== st.running) { row.running = st.running; changed = true; }
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
  const collapsedNow = localStorage.getItem('dsh-studio.rail-collapsed') === '1';
  rail.innerHTML = '';
  // A collapsed rail stays visible as a strip so its toggle remains reachable.
  rail.hidden = rows.length === 0 && !collapsedNow;
  if (rows.length === 0 && !collapsedNow) return;

  rail.classList.toggle('collapsed', collapsedNow);

  const head = document.createElement('div');
  head.className = 'rail-head';
  const hText = document.createElement('span');
  hText.textContent = collapsedNow ? '任务 ' + rows.length : t('rail.head', { n: rows.length });
  head.appendChild(hText);
  const toggle = document.createElement('button');
  toggle.className = 'rail-toggle';
  toggle.textContent = collapsedNow ? '»' : '«';
  toggle.title = collapsedNow ? '展开状态栏' : '收起状态栏';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    // Derive the flip from the DOM, which is the value the user is looking at.
    const isCollapsed = rail.classList.contains('collapsed');
    localStorage.setItem('dsh-studio.rail-collapsed', isCollapsed ? '0' : '1');
    renderRail();
  });
  head.appendChild(toggle);
  rail.appendChild(head);

  if (collapsedNow) return;
  const savedOrder = JSON.parse(localStorage.getItem('dsh-studio.rail-order') || '[]');
  const rank = new Map(savedOrder.map((id, i) => [id, i]));
  rows.sort((a, b) => {
    const ra = rank.has(a.sessionId) ? rank.get(a.sessionId) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.sessionId) ? rank.get(b.sessionId) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  for (const s of rows) {
    const st = statusOf(s);
    const row = document.createElement('div');
    row.className = 'rail-row';
    row.draggable = true;
    row.dataset.sessionId = s.sessionId;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', s.sessionId);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/plain');
      const to = s.sessionId;
      if (!from || from === to) return;
      const order = [...document.querySelectorAll('.rail-row')].map((r) => r.dataset.sessionId);
      const fi = order.indexOf(from);
      if (fi >= 0) order.splice(fi, 1);
      const ti = order.indexOf(to);
      order.splice(ti < 0 ? order.length : ti, 0, from);
      localStorage.setItem('dsh-studio.rail-order', JSON.stringify(order));
      renderRail();
    });
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
  count.textContent = t('batch.count', { n: state.picked.size });
  bar.appendChild(count);
  const mk = (label, cls, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'batch-btn ' + cls;
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    return b;
  };
  bar.appendChild(mk(t('batch.archive'), '', () => runBatch('archive'), state.picked.size === 0));
  bar.appendChild(mk(t('batch.delete'), 'danger', () => runBatch('delete'), state.picked.size === 0));
  bar.appendChild(mk(t('batch.cancel'), '', () => { state.batchMode = false; state.picked.clear(); render(); }));
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
document.getElementById('btn-font-minus').addEventListener('click', () => decreaseFont());
document.getElementById('btn-font-reset').addEventListener('click', () => resetFont());
document.getElementById('btn-font-plus').addEventListener('click', () => increaseFont());

document.getElementById('btn-lang').addEventListener('click', () => {
  const cur = getLocalePref();
  const next = cur === 'auto' ? 'zh' : (cur === 'zh' ? 'en' : 'auto');
  setLocalePref(next);
});

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
  reload: () => reload(),
  removeCard: (sessionId) => removeCardLocal(sessionId),
  setRunning(ids) {
    const set = new Set(ids);
    for (const s of state.sessions) s.running = set.has(s.sessionId);
    render();
  },
};

reload();
