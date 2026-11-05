// Typed access to the engine's endpoints, with the arg-field quirk handled in one place.
import { Engine } from './engine.mjs';

export class StudioApi {
  constructor(engine) { this.engine = engine; }

  // session/state, session/projections, ... all take their payload as "request".
  call(endpoint, request = {}) {
    return this.engine.call(endpoint, { request }, 'request');
  }

  // session/list takes "_request" (no payload).
  listSessions() {
    return this.engine.call('session/list', {}, '_request');
  }

  async boardState() {
    const list = await this.listSessions();
    const items = (list.items ?? []).filter((s) => s.blank !== true);
    const enriched = await Promise.all(items.map(async (s) => {
      let state = null;
      let projections = null;
      try { state = await this.call('session/state', { sessionId: s.sessionId }); } catch {}
      try { projections = await this.call('session/projections', { sessionId: s.sessionId }); } catch {}
      const v = projections?.values ?? {};
      return {
        sessionId: s.sessionId,
        title: v.title ?? s.projections?.values?.title ?? '(未命名会话)',
        cwd: s.cwd ?? v.workingDirectory ?? '',
        updatedAt: s.updatedAt,
        running: state?.running === true || s.running === true,
        active: state?.active === true,
        pendingInput: state?.pendingInput?.length ?? 0,
        pinned: s.pinned === true,
        archived: s.archived === true,
        model: v.modelSelection?.lastUsed ?? null,
        turns: v.sessionStats?.turns ?? 0,
        outline: v.turnOutline ?? [],
        lastPrompt: v.turnOutline?.length ? (v.turnOutline[v.turnOutline.length - 1]?.prompt ?? '') : '',
      };
    }));
    return enriched;
  }

  rename(sessionId, title) { return this.call('session/rename', { sessionId, title }); }
  cancel(sessionId) { return this.call('session/cancel', { sessionId }); }
  unarchive(sessionId) { return this.engine.call('workspace/unarchiveSession', { request: { sessionId } }, 'request'); }
  archive(sessionId, stopActivity = false) { return this.engine.call('workspace/archiveSession', { request: { sessionId, stopActivity } }, 'request'); }
  pin(sessionId) { return this.engine.call('workspace/pinSession', { request: { sessionId } }, 'request'); }
  unpin(sessionId) { return this.engine.call('workspace/unpinSession', { request: { sessionId } }, 'request'); }
}
