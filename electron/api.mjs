// Typed access to the engine's endpoints, with the arg-field quirk handled in one place.
import { Engine } from './engine.mjs';

const withTimeout = (p, ms, fallback) =>
  Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

export class StudioApi {
  constructor(engine) { this.engine = engine; }

  // session/state, session/projections, ... take their payload as "request".
  call(endpoint, request = {}) {
    return this.engine.call(endpoint, { request }, 'request');
  }

  // session/list takes "_request" (no payload).
  listSessions() {
    return this.engine.call('session/list', {}, '_request');
  }

  // Fast board: session/list only. Per-session state is fetched on demand.
  async fastBoard() {
    const list = await this.listSessions();
    return (list.items ?? [])
      .filter((s) => s.blank !== true)
      .map((s) => {
        const v = s.projections?.values ?? {};
        return {
          sessionId: s.sessionId,
          title: v.title ?? '(未命名会话)',
          cwd: s.cwd ?? v.workingDirectory ?? '',
          updatedAt: s.updatedAt,
          running: s.running === true,
          cached: s.projections?.kind === 'cached' || s.projections?.kind === 'sequenced',
        };
      });
  }

  // Deeper detail for one session, used when a card is opened.
  async sessionDetail(sessionId) {
    const [state, projections] = await Promise.all([
      withTimeout(this.call('session/state', { sessionId }), 4000, null),
      withTimeout(this.call('session/projections', { sessionId }), 4000, null),
    ]);
    const v = projections?.values ?? {};
    return {
      running: state?.running === true,
      active: state?.active === true,
      pendingInput: state?.pendingInput?.length ?? 0,
      title: v.title ?? null,
      model: v.modelSelection?.lastUsed ?? null,
      turns: v.sessionStats?.turns ?? 0,
      outline: v.turnOutline ?? [],
    };
  }

  // Refresh running flags for the whole board in bounded batches.
  async runningStates(sessionIds) {
    const out = {};
    const BATCH = 8;
    for (let i = 0; i < sessionIds.length; i += BATCH) {
      const slice = sessionIds.slice(i, i + BATCH);
      const rows = await Promise.all(slice.map((id) =>
        withTimeout(this.call('session/state', { sessionId: id }), 3000, null)));
      slice.forEach((id, k) => { if (rows[k]) out[id] = rows[k].running === true; });
    }
    return out;
  }

  rename(sessionId, title) { return this.call('session/rename', { sessionId, title }); }
  cancel(sessionId) { return this.call('session/cancel', { sessionId }); }
  archive(sessionId, stopActivity = false) { return this.call('workspace/archiveSession', { sessionId, stopActivity }); }
  pin(sessionId) { return this.call('workspace/pinSession', { sessionId }); }
  deleteSession(sessionId) { return this.call('session/delete', { sessionId }); }
  markUnread(sessionId) { return this.call('session/control', { sessionId, action: 'markUnread' }); }
  unpin(sessionId) { return this.call('workspace/unpinSession', { sessionId }); }
}
