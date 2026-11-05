// Context menu, confirm dialog, and toast — the interaction chrome of the board.

let openMenuEl = null;

export function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}

export function showMenu(x, y, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      el.appendChild(sep);
      continue;
    }
    const row = document.createElement('button');
    row.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    row.textContent = item.label;
    if (item.disabled) {
      row.disabled = true;
    } else {
      row.addEventListener('click', () => { closeMenu(); item.run(); });
    }
    el.appendChild(row);
  }
  el.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  el.style.top = Math.min(y, window.innerHeight - 40 - items.length * 30) + 'px';
  document.body.appendChild(el);
  openMenuEl = el;
  return el;
}

document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !e.target.closest('.ctx-menu')) closeMenu();
});

let toastTimer = null;
export function toast(text, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast toast-' + kind;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function confirmDialog({ title, body, okLabel, cancelLabel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dlg-back';
    const box = document.createElement('div');
    box.className = 'dlg';
    const h = document.createElement('div');
    h.className = 'dlg-title';
    h.textContent = title;
    const b = document.createElement('div');
    b.className = 'dlg-body';
    b.textContent = body;
    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const cancel = document.createElement('button');
    cancel.className = 'dlg-btn';
    cancel.textContent = cancelLabel;
    const ok = document.createElement('button');
    ok.className = 'dlg-btn ' + (danger ? 'dlg-danger' : 'dlg-primary');
    ok.textContent = okLabel;
    const done = (v) => { back.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(false); });
    foot.appendChild(cancel); foot.appendChild(ok);
    box.appendChild(h); box.appendChild(b); box.appendChild(foot);
    back.appendChild(box);
    document.body.appendChild(back);
  });
}

export function promptDialog({ title, value = '', okLabel = '确定', cancelLabel = '取消' }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dlg-back';
    const box = document.createElement('div');
    box.className = 'dlg';
    const h = document.createElement('div');
    h.className = 'dlg-title';
    h.textContent = title;
    const input = document.createElement('input');
    input.className = 'dlg-input';
    input.value = value;
    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const cancel = document.createElement('button');
    cancel.className = 'dlg-btn';
    cancel.textContent = cancelLabel;
    const ok = document.createElement('button');
    ok.className = 'dlg-btn dlg-primary';
    ok.textContent = okLabel;
    const done = (v) => { back.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    foot.appendChild(cancel); foot.appendChild(ok);
    box.appendChild(h); box.appendChild(input); box.appendChild(foot);
    back.appendChild(box);
    document.body.appendChild(back);
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
