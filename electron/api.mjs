// Typed access to the engine's endpoints, with the arg-field quirk handled in one place.
import { randomUUID } from 'node:crypto';
import { Engine } from './engine.mjs';
import { WebSocket } from 'ws';

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

  // Workspace grouping arrives only over the Gateway stream carrier.
  async workspaceBaseline(timeoutMs = 15000) {
    const origin = new URL(this.engine.origin);
    const ws = new WebSocket('ws://' + origin.host + '/api/remote.mux', { headers: { cookie: this.engine.cookie } });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('workspace stream timeout')), timeoutMs);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'open', streamId: 'ws-baseline', endpoint: 'workspace/follow', payload: { args: {} } }));
        });
        ws.on('message', (raw) => {
          let frame;
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== 'item') return;
          const v = frame.value;
          if (v?.type === 'baseline') {
            clearTimeout(timer);
            const value = v.value ?? {};
            resolve({
              items: (value.items ?? []).map((w) => ({
                workspaceId: w.workspaceId,
                path: w.path,
                title: w.title,
                sessionIds: w.sessionIds ?? [],
              })),
              pinnedSessionIds: value.pinnedSessionIds ?? [],
              archivedSessionIds: value.archivedSessionIds ?? [],
            });
          }
        });
        ws.on('error', (err) => { clearTimeout(timer); reject(new Error(String(err.message ?? err))); });
      });
    } finally {
      try { ws.close(); } catch {}
    }
  }

  // --- fork / spawn ---------------------------------------------------------
  createSession(workspaceId) {
    return this.call('session/create', workspaceId ? { workspaceId } : {});
  }

  sendPrompt(sessionId, text) {
    return this.call('session/prompt', {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    });
  }

  forkSession(sessionId, atSeq) {
    return this.call('session/fork', atSeq === undefined ? { sessionId } : { sessionId, atSeq });
  }

  // A digest-shaped summary built from the turn outline, used as injected context.
  async digestOf(sessionId) {
    const pj = await this.call('session/projections', { sessionId });
    const outline = pj?.values?.turnOutline ?? [];
    const last = outline[outline.length - 1];
    return {
      turns: outline.length,
      summary: last?.prompt ? String(last.prompt).slice(0, 400) : '',
      findings: last?.response ? String(last.response).slice(0, 400) : '',
    };
  }

  rename(sessionId, title) { return this.call('session/rename', { sessionId, title }); }
  cancel(sessionId) { return this.call('session/cancel', { sessionId }); }
  archive(sessionId, stopActivity = false) { return this.call('workspace/archiveSession', { sessionId, stopActivity }); }
  pin(sessionId) { return this.call('workspace/pinSession', { sessionId }); }
  deleteSession(sessionId) { return this.call('session/delete', { sessionId }); }
  markUnread(sessionId) { return this.call('session/control', { sessionId, action: 'markUnread' }); }
  unpin(sessionId) { return this.call('workspace/unpinSession', { sessionId }); }
}
