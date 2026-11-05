import { Engine } from './electron/engine.mjs';
const e = new Engine();
await e.start();
const tryIt = async (m, args) => {
  try { const v = await e.call(m, args, 'request'); console.log('OK   ' + m + ' -> ' + JSON.stringify(v).slice(0, 200)); }
  catch (err) { console.log('ERR  ' + m + ' -> ' + String(err.message ?? err).slice(0, 160)); }
};
await tryIt('session/state', { request: {} });
await tryIt('session/search', { request: {} });
await tryIt('session/projections', { request: {} });
e.stop();
process.exit(0);
