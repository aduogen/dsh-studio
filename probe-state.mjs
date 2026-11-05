import { Engine } from './electron/engine.mjs';
const e = new Engine();
await e.start();
// session/state with a real id
const list = await e.call('session/list');
const id = list.items[0].sessionId;
const st = await e.call('session/state', { request: { sessionId: id } }, 'request');
console.log('session/state ->', JSON.stringify(st).slice(0, 300));

// session/projections (title, model, etc.)
const pj = await e.call('session/projections', { request: { sessionId: id } }, 'request').catch(x => ({ err: String(x).slice(0,160) }));
console.log('session/projections ->', JSON.stringify(pj).slice(0, 300));

// session/page (history)
const pg = await e.call('session/page', { request: { sessionId: id } }, 'request').catch(x => ({ err: String(x).slice(0,160) }));
console.log('session/page ->', JSON.stringify(pg).slice(0, 400));
e.stop();
process.exit(0);
