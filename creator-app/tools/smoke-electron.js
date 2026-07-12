'use strict';

const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron');
const appRoot = path.resolve(__dirname, '..');
const timeoutMs = 30000;
let output = '';
let settled = false;
let timer;

function finish(code, message) {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  if (message) process.stderr.write(`${message}\n`);
  if (!child.killed) child.kill('SIGTERM');
  process.exitCode = code;
}

const child = spawn(electronPath, [appRoot], {
  cwd: appRoot,
  env: {
    ...process.env,
    CREATOR_SMOKE_TEST: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function capture(chunk) {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (output.includes('[CREATOR_SMOKE] PASS')) {
    finish(0);
  } else if (output.includes('[CREATOR_SMOKE] FAIL')) {
    finish(1, 'Electron renderer isolation smoke test reported failure.');
  }
}

child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('error', (error) => finish(1, `Failed to launch Electron: ${error.message}`));
child.on('exit', (code, signal) => {
  if (!settled) {
    finish(1, `Electron exited before smoke completion (code=${code}, signal=${signal}).`);
  }
});

timer = setTimeout(() => {
  finish(1, 'Timed out waiting for Electron renderer isolation smoke result.');
}, timeoutMs);
