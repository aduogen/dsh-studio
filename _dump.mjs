import { spawn } from 'node:child_process';
const child = spawn('node_modules\\electron\\dist\\electron.exe', ['.', '--dump'], { cwd: process.cwd(), stdio: 'ignore' });
await new Promise(r => setTimeout(r, 25000));
try { child.kill(); } catch {}
process.exit(0);
