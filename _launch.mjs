import { spawn } from 'node:child_process';
const child = spawn('node_modules\\electron\\dist\\electron.exe', ['.'], { cwd: process.cwd(), detached: true, stdio: 'ignore' });
child.unref();
console.log('launched pid', child.pid);
process.exit(0);