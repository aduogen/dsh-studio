// Engine manager: owns the dsh web kernel process and the authenticated RPC channel.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_EXE = 'E:\\工具\\DeepSeek harness\\DeepSeek Harness.exe';
const DSH_CLI = 'E:\\工具\\DeepSeek harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';
// Overlay that turns on ranked full-text session search (the web bundle leaves it off).
const SEARCH_PATCH = new URL('../patches/enable-search.yml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Reuses the desktop profile's provider declarations (models and env-var names only).
const PROVIDERS_PATCH = new URL('../patches/providers.yml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// The engine reads provider keys from the environment, while DSH stores them in
// its credential file under "refs". Copy those refs into the child environment so
// the engine can reach the same providers the desktop app uses.
const CREDENTIALS = path.join(os.homedir(), '.dsh', '.credentials.yaml');

function loadCredentialEnv() {
  const env = {};
  let text = "";
  try { text = fs.readFileSync(CREDENTIALS, "utf8"); } catch { return env; }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (/^\S/.test(line)) { inRefs = false; continue; }
    const m = /^\s+([A-Z][A-Z0-9_]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (value !== "") env[m[1]] = value;
  }
  return env;
}
const URL_RE = /http:\/\/[^\s]+\?token=[A-Za-z0-9_-]+/;

export class Engine {
  constructor() {
    this.child = null;
    this.origin = null;
    this.cookie = null;
    this.token = null;
    this.starting = null;
    this.logLines = [];
  }

  log(line) {
    this.logLines.push(line);
    if (this.logLines.length > 400) this.logLines.shift();
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.#doStart();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #doStart() {
    if (this.child) this.stop();

    const args = ['--expose-internals', DSH_CLI];
    if (fs.existsSync(PROVIDERS_PATCH)) args.push('--patch', PROVIDERS_PATCH);
    if (fs.existsSync(SEARCH_PATCH)) args.push('--patch', SEARCH_PATCH);
    args.push('--profile', 'web', '--no-open', '--port', '0');
    const child = spawn(DSH_EXE, args, {
      env: { ...process.env, ...loadCredentialEnv(), ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    this.child = child;

    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('engine did not print a URL in 90s. Output: ' + buf.slice(-600))), 90000);
      const scan = (chunk) => {
        const text = chunk.toString();
        buf += text;
        this.log(text.trim());
        const m = URL_RE.exec(buf);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('engine exited early (code ' + code + '): ' + buf.slice(-600))); });
    });

    const u = new URL(url);
    this.origin = u.origin;
    this.token = u.searchParams.get('token');

    // Exchange the launch token for the session cookie.
    const auth = await this.#raw('GET', '/?token=' + encodeURIComponent(this.token));
    const setCookie = auth.headers['set-cookie'];
    if (!setCookie) throw new Error('engine refused the launch token (status ' + auth.status + ')');
    this.cookie = String(setCookie).split(';')[0];
    this.log('engine ready at ' + this.origin);
    return { origin: this.origin };
  }

  #raw(method, requestPath, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.origin);
      const headers = {};
      if (this.cookie) headers.cookie = this.cookie;
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const req = http.request({ host: u.hostname, port: u.port, path: requestPath, method, headers, agent: false, timeout: 60000 }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('engine request timeout')); });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  // One typed RPC call. The kernel wants exactly one plain-object args field named _request.
  async call(endpoint, args = {}, argField = '_request') {
    if (!this.origin) await this.start();
    const payload = JSON.stringify({
      type: 'client-request',
      rpcId: 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      method: endpoint,
      payload: { args: argField === null ? {} : { [argField]: {}, ...args } },
    });
    const res = await this.#raw('POST', '/api/' + endpoint, payload);
    if (res.status === 401) {
      // cookie expired: re-authenticate once
      const auth = await this.#raw('GET', '/?token=' + encodeURIComponent(this.token));
      const setCookie = auth.headers['set-cookie'];
      if (setCookie) this.cookie = String(setCookie).split(';')[0];
      const retry = await this.#raw('POST', '/api/' + endpoint, payload);
      return this.#unwrap(endpoint, retry);
    }
    return this.#unwrap(endpoint, res);
  }

  #unwrap(endpoint, res) {
    if (res.status === 404) throw new Error('unknown endpoint "' + endpoint + '"');
    let parsed;
    try { parsed = JSON.parse(res.body); } catch { throw new Error('bad engine response for ' + endpoint + ': ' + res.body.slice(0, 200)); }
    const result = parsed.result;
    if (!result) throw new Error('engine returned no result for ' + endpoint);
    if (result.ok === false) throw new Error(result.error?.code + ': ' + result.error?.message);
    return result.value;
  }

  stop() {
    if (!this.child) return;
    try { this.child.kill(); } catch {}
    this.child = null;
    this.origin = null;
    this.cookie = null;
  }
}
