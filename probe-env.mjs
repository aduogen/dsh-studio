import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const src = fs.readFileSync('electron/engine.mjs','utf8');
const fn = new Function('fs','os','path', src.match(/function loadCredentialEnv[\s\S]*?\n\}/)[0] + '\nreturn loadCredentialEnv;');
const load = fn(fs, os, path);
const env = load();
console.log('credential env keys:', Object.keys(env).join(', '));
console.log('count:', Object.keys(env).length);