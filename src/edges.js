// Edges between cards: geometry, rendering on an SVG layer, and the spawn flow.

export const EDGE_KINDS = {
  none: { label: '不继承', hint: '全新对话，只保留一条关联线。' },
  digest: { label: '摘要注入', hint: '把这段对话的摘要作为背景注入新对话。' },
  full: { label: '完整对话', hint: '携带完整历史继续（原生分叉）。' },
};

// Pick the two card sides that face each other, so a line never crosses a card.
export function sideHandles(a, b, cardW, cardH) {
  const ax = a.x + cardW / 2, ay = a.y + cardH / 2;
  const bx = b.x + cardW / 2, by = b.y + cardH / 2;
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: 'r', to: 'l' } : { from: 'l', to: 'r' };
  }
  return dy >= 0 ? { from: 'b', to: 't' } : { from: 't', to: 'b' };
}

// Anchor point on a card for a given handle id.
export function anchor(card, handle, cardW, cardH) {
  switch (handle) {
    case 't': return { x: card.x + cardW / 2, y: card.y };
    case 'b': return { x: card.x + cardW / 2, y: card.y + cardH };
    case 'l': return { x: card.x, y: card.y + cardH / 2 };
    default:  return { x: card.x + cardW, y: card.y + cardH / 2 };
  }
}

// A gentle curve between two points, bulging along the dominant axis.
export function curvePath(p, q) {
  const dx = q.x - p.x, dy = q.y - p.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const c = Math.max(30, Math.abs(dx) * 0.45) * Math.sign(dx || 1);
    return 'M ' + p.x + ' ' + p.y + ' C ' + (p.x + c) + ' ' + p.y + ', ' + (q.x - c) + ' ' + q.y + ', ' + q.x + ' ' + q.y;
  }
  const c = Math.max(30, Math.abs(dy) * 0.45) * Math.sign(dy || 1);
  return 'M ' + p.x + ' ' + p.y + ' C ' + p.x + ' ' + (p.y + c) + ', ' + q.x + ' ' + (q.y - c) + ', ' + q.x + ' ' + q.y;
}

// Rough distance from a point to a segment, for click-to-delete handling.
export function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function buildInjectedText(fromTitle, digest) {
  const parts = [];
  parts.push('【上下文注入 · 来自】' + fromTitle);
  if (digest?.summary) parts.push('摘要：' + digest.summary);
  if (digest?.findings) parts.push('关键结论：' + digest.findings);
  parts.push('【提醒】以上是摘要提纲，不是完整对话。需要细节时请回到原会话「' + fromTitle + '」查看完整记录。');
  return parts.join('\n\n');
}
