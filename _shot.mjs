import { spawn } from 'node:child_process';
const child = spawn('node_modules\\electron\\dist\\electron.exe', ['.', '--shot'], { cwd: process.cwd(), stdio: 'ignore' });
await new Promise(r => setTimeout(r, 22000));
try { child.kill(); } catch {}
process.exit(0);
