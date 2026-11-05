import { spawn } from 'node:child_process';
import fs from 'node:fs';
const out = fs.openSync('dd.out.log','w');
const err = fs.openSync('dd.err.log','w');
const child = spawn('node_modules\\electron\\dist\\electron.exe', ['.', '--dump'], { cwd: process.cwd(), stdio: ['ignore', out, err] });
await new Promise(r => setTimeout(r, 110000));
try { child.kill(); } catch {}
process.exit(0);