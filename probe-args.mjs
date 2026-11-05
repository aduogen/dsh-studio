import { Engine } from './electron/engine.mjs';
const e = new Engine();
await e.start();
// Ask the gateway to tell us the exact arg names by sending nothing but _request.
const detail = async (m) => {
  try { await e.call(m, {}); return 'NO ERROR'; }
  catch (err) { return String(err.message ?? err); }
};
for (const m of ['session/search', 'session/rename', 'session/create', 'session/fork', 'session/prompt', 'session/projections', 'session/state', 'workspace/create']) {
  console.log(m + ' :: ' + (await detail(m)).slice(0, 260));
}
e.stop();
process.exit(0);
