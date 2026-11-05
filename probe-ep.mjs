import { Engine } from './electron/engine.mjs';
const e = new Engine();
await e.start();
const cands = [
  'session/search', 'session/create', 'session/rename', 'session/fork',
  'session/prompt', 'session/projections', 'session/state',
  'workspace/create', 'workspace/baseline', 'workspace/changed',
  'settings/get', 'settings/read', 'account/state',
];
for (const m of cands) {
  try {
    const v = await e.call(m, {});
    console.log('OK   ' + m + ' -> ' + JSON.stringify(v).slice(0, 150));
  } catch (err) {
    const s = String(err.message ?? err);
    console.log((s.includes('unknown endpoint') ? 'MISS ' : 'EXIST') + ' ' + m + ' -> ' + s.slice(0, 110));
  }
}
e.stop();
process.exit(0);
