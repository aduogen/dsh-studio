// Runs probe-ui.js inside the live renderer and prints its result.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BUDGET_MS = Number(process.argv[2] ?? 90) * 1000;
try { fs.unlinkSync(path.join(process.cwd(), 'dom.json')); } catch {}

const child = spawn(
  path.join('node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--dump'],
  { cwd: process.cwd(), stdio: 'ignore' }
);

const started = Date.now();
while (Date.now() - started < BUDGET_MS) {
  await new Promise((r) => setTimeout(r, 1500));
  if (fs.existsSync(path.join(process.cwd(), 'dom.json'))) break;
}
try { child.kill(); } catch {}

const out = path.join(process.cwd(), 'dom.json');
if (fs.existsSync(out)) {
  console.log(fs.readFileSync(out, 'utf8'));
} else {
  const boot = path.join(process.cwd(), 'boot.log');
  console.log('NO RESULT. boot.log tail:');
  if (fs.existsSync(boot)) console.log(fs.readFileSync(boot, 'utf8').split('\n').slice(-8).join('\n'));
}
