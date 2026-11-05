// UI locale and font scale, mirroring the original plugin's pill and A+/A- controls.

export const DICT = {
  zh: {
    'app.brand': 'DSH Studio',
    'search.placeholder': '搜卡片（标题 / 正文）',
    'btn.batch': '批量',
    'btn.fit': '1:1',
    'btn.reload': '刷新',
    'status.loading': '正在读取会话…',
    'status.count': '{n} 个会话 · {w} 个分组',
    'menu.open': '打开对话',
    'menu.pin': '置顶会话',
    'menu.unpin': '取消置顶',
    'menu.rename': '重命名…',
    'menu.archive': '归档会话',
    'menu.stop': '停止运行',
    'menu.delete': '删除会话（回收站）',
    'menu.renameWs': '重命名工作区…',
    'menu.tidyWs': '整理本组卡片',
    'panel.loading': '正在读取对话…',
    'panel.empty': '这个对话还没有内容。',
    'rail.head': '队列中的任务 · {n}',
    'batch.count': '已选 {n} 个对话',
    'batch.archive': '归档',
    'batch.delete': '删除',
    'batch.cancel': '取消',
    'hits.head': '全部对话里的命中 · {n} 条',
    'hits.loading': '全文搜索中…',
    'hits.disabled': '全文索引未启用 —— 上方卡片过滤仍可用。',
    'hits.empty': '没有命中',
    'spawn.head': '连线分叉：开一个带上下文的新对话',
    'spawn.from': '来源：{t}',
    'spawn.ok': '开新对话',
    'spawn.busy': '创建中…',
    'spawn.cancel': '取消',
    'draft.injectLabel': '将要注入的内容，可编辑…',
    'font.group': '文字大小',
    'font.increase': '加大字号',
    'font.decrease': '减小字号',
    'font.reset': '默认',
    'lang.hint': '界面语言：{cur} · 点击切换到{nxt}',
    'lang.auto': '自动',
  },
  en: {
    'app.brand': 'DSH Studio',
    'search.placeholder': 'Search cards (title / body)',
    'btn.batch': 'Batch',
    'btn.fit': '1:1',
    'btn.reload': 'Refresh',
    'status.loading': 'Loading sessions…',
    'status.count': '{n} sessions · {w} groups',
    'menu.open': 'Open conversation',
    'menu.pin': 'Pin session',
    'menu.unpin': 'Unpin',
    'menu.rename': 'Rename…',
    'menu.archive': 'Archive',
    'menu.stop': 'Stop running',
    'menu.delete': 'Delete (recycle bin)',
    'menu.renameWs': 'Rename workspace…',
    'menu.tidyWs': 'Tidy this group',
    'panel.loading': 'Loading conversation…',
    'panel.empty': 'This conversation has no content yet.',
    'rail.head': 'Tasks in the queue · {n}',
    'batch.count': '{n} selected',
    'batch.archive': 'Archive',
    'batch.delete': 'Delete',
    'batch.cancel': 'Cancel',
    'hits.head': 'Hits across conversations · {n}',
    'hits.loading': 'Searching…',
    'hits.disabled': 'Full-text index is off — title filtering above still works.',
    'hits.empty': 'No hits',
    'spawn.head': 'Fork with context',
    'spawn.from': 'From: {t}',
    'spawn.ok': 'Start conversation',
    'spawn.busy': 'Creating…',
    'spawn.cancel': 'Cancel',
    'draft.injectLabel': 'Context to inject (editable)…',
    'font.group': 'Text size',
    'font.increase': 'Larger text',
    'font.decrease': 'Smaller text',
    'font.reset': 'Default',
    'lang.hint': 'UI language: {cur} · click for {nxt}',
    'lang.auto': 'Auto',
  },
};

let pref = 'auto';
const listeners = new Set();

export function documentLocale() {
  const raw = (typeof document !== 'undefined' && document.documentElement.lang) || '';
  return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function activeLocale() {
  return pref === 'auto' ? documentLocale() : pref;
}

export function setLocalePref(next) {
  if (next === pref) return;
  pref = next;
  for (const fn of listeners) fn();
}

export function getLocalePref() { return pref; }

export function subscribeLocale(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, params) {
  const dict = activeLocale() === 'zh' ? DICT.zh : DICT.en;
  let text = dict[key] ?? DICT.en[key] ?? key;
  if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => String(params[name] ?? m));
  return text;
}

// --- font scale -------------------------------------------------------------

const STEPS = [0, 1, 2, 3, 4];
const FONT_KEY = 'dsh-studio.font-step.v1';
let stepIndex = 2;
const fontListeners = new Set();

export function initFontScale() {
  try {
    const saved = Number(localStorage.getItem(FONT_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < STEPS.length) stepIndex = saved;
  } catch {}
  applyFontScale();
}

export function fontStep() { return STEPS[stepIndex]; }
export function canIncrease() { return stepIndex < STEPS.length - 1; }
export function canDecrease() { return stepIndex > 0; }

function applyFontScale() {
  document.documentElement.style.setProperty('--ui-font-step', STEPS[stepIndex] + 'px');
  try { localStorage.setItem(FONT_KEY, String(stepIndex)); } catch {}
  for (const fn of fontListeners) fn();
}

export function increaseFont() { if (canIncrease()) { stepIndex++; applyFontScale(); } }
export function decreaseFont() { if (canDecrease()) { stepIndex--; applyFontScale(); } }
export function resetFont() { stepIndex = 2; applyFontScale(); }
export function subscribeFont(fn) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}
