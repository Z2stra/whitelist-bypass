'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronPath = require('electron');
const appRoot = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-protected-storage-smoke-'));
const timeoutMs = 45000;
let output = '';
let settled = false;
let sawPass = false;
let timer;

function cleanup() {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {}
}

function finish(code, message, kill = false) {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  if (message) process.stderr.write(`${message}\n`);
  if (kill && !child.killed) child.kill();
  cleanup();
  process.exitCode = code;
}

const child = spawn(electronPath, [appRoot, '--protected-storage-smoke'], {
  cwd: appRoot,
  windowsHide: true,
  env: {
    ...process.env,
    CREATOR_PROTECTED_STORAGE_SMOKE_DIR: userData,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function capture(chunk) {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (output.includes('[PROTECTED_SETTINGS_SMOKE] PASS')) sawPass = true;
  if (output.includes('[PROTECTED_SETTINGS_SMOKE] FAIL')) {
    finish(1, 'Electron protected-settings smoke reported failure.', true);
  }
}

child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('error', (error) => finish(1, `Failed to launch Electron: ${error.message}`, true));
child.on('exit', (code, signal) => {
  if (sawPass && code === 0) {
    finish(0);
    return;
  }
  finish(
    1,
    `Electron exited before protected-settings smoke completion (code=${code}, signal=${signal}).`,
  );
});

timer = setTimeout(() => {
  finish(1, 'Timed out waiting for Electron protected-settings smoke result.', true);
}, timeoutMs);
