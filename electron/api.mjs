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

  // Bind the deployment default model, because session/create leaves it unset.
  async bindDefaultModel(sessionId) {
    try {
      const cat = await this.engine.call('session/modelCatalog', {}, null);
      const def = cat?.default;
      if (!def?.provider || !def?.model) return { ok: false, error: '读不到默认模型' };
      await this.call('session/selectModel', { sessionId, provider: def.provider, model: def.model });
      return { ok: true, provider: def.provider, model: def.model };
    } catch (err) {
      return { ok: false, error: '绑定模型失败: ' + String(err.message ?? err).slice(0, 90) };
    }
  }

  // --- digest -------------------------------------------------------------
  // The host's llm service is not exposed over HTTP, so a digest is produced by
  // asking a session to summarise another one: same deployment model, no new channel.
  async generateDigest(sessionId, title) {
    const pj = await this.call('session/projections', { sessionId });
    const outline = pj?.values?.turnOutline ?? [];
    const transcript = outline.map((t, i) =>
      'Q' + (i + 1) + ': ' + String(t.prompt ?? '').slice(0, 700) +
      '\nA' + (i + 1) + ': ' + String(t.response ?? '').slice(0, 900)
    ).join('\n\n').slice(0, 12000);
    if (transcript.trim() === '') return { ok: false, error: '这个对话还没有内容，无法生成摘要' };

    const ws = await this.workspaceBaseline();
    const created = await this.createSession(ws.items[0]?.workspaceId);
    const helperId = created?.sessionId;
    if (!helperId) return { ok: false, error: '无法创建摘要会话' };

    // A fresh session has no model bound; a prompt would be accepted and never run.
    const bound = await this.bindDefaultModel(helperId);
    if (!bound.ok) return { ok: false, error: bound.error };

    const prompt = [
      '你是对话摘要器。阅读下面的对话记录，只输出严格 JSON：',
      '{"summary": string, "keyFindings": string[], "nextStep": string}',
      '规则：',
      '- 用对话本身的语言（中文对话输出中文）。',
      '- summary：这段对话在讲什么、进行到哪，不超过 120 字。',
      '- keyFindings：最多 5 条短句，写已做出的决定、已确认的事实、已产出的东西。',
      '- nextStep：一句祈使句，说明下一步具体做什么，不超过 40 字；已完结则输出空字符串。',
      '- 只输出 JSON，不要 markdown 代码块，不要解释。',
      '',
      '对话标题：' + (title ?? ''),
      '',
      '对话记录（从旧到新）：',
      transcript,
    ].join('\n');

    try {
      await this.sendPrompt(helperId, prompt);
    } catch (err) {
      return { ok: false, error: '摘要请求失败: ' + String(err.message ?? err).slice(0, 90) };
    }

    // Poll the helper session until it answers or the budget runs out.
    const deadline = Date.now() + 90000;
    let text = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const hp = await this.call('session/projections', { sessionId: helperId }).catch(() => null);
      const turns = hp?.values?.turnOutline ?? [];
      const first = turns[0];
      if (first?.response && String(first.response).trim() !== '') { text = String(first.response); break; }
    }
    if (!text) return { ok: false, error: '摘要生成超时' };

    // Tolerant parse, same rules as the original plugin.
    let body = text.trim();
    if (body.startsWith('```')) body = body.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    const s0 = body.indexOf('{'), s1 = body.lastIndexOf('}');
    if (s0 === -1 || s1 <= s0) return { ok: false, error: '摘要输出里没有 JSON' };
    try {
      const parsed = JSON.parse(body.slice(s0, s1 + 1));
      return {
        ok: true,
        value: {
          summary: String(parsed.summary ?? '').slice(0, 300),
          keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.slice(0, 5).map((x) => String(x).slice(0, 120)) : [],
          nextStep: String(parsed.nextStep ?? '').slice(0, 120),
          helperSessionId: helperId,
        },
      };
    } catch (err) {
      return { ok: false, error: '摘要 JSON 解析失败', raw: body.slice(0, 200) };
    }
  }

  async search(query) {
    try {
      const res = await this.call('session/search', { query });
      return { ok: true, items: res?.items ?? [] };
    } catch (err) {
      const m = String(err.message ?? err);
      if (m.includes('disabled')) return { ok: false, disabled: true, items: [] };
      return { ok: false, error: m.slice(0, 120), items: [] };
    }
  }

  rename(sessionId, title) { return this.call('session/rename', { sessionId, title }); }
  cancel(sessionId) { return this.call('session/cancel', { sessionId }); }
  archive(sessionId, stopActivity = false) { return this.call('workspace/archiveSession', { sessionId, stopActivity }); }
  pin(sessionId) { return this.call('workspace/pinSession', { sessionId }); }
  deleteSession(sessionId) { return this.call('session/delete', { sessionId }); }
  markUnread(sessionId) { return this.call('session/control', { sessionId, action: 'markUnread' }); }
  unpin(sessionId) { return this.call('workspace/unpinSession', { sessionId }); }
}
