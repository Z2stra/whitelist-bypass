import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('root page has restrictive CSP and no main-world renderer bootstrap', () => {
  const html = source('index.html');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'none'/);
  assert.equal(html.includes("require('./dist/renderer/index.js')"), false);
});

test('root BrowserWindow disables Node integration and enables context isolation', () => {
  const windowSource = source('src/main/window.ts');
  assert.match(windowSource, /nodeIntegration:\s*false/);
  assert.match(windowSource, /contextIsolation:\s*true/);
  assert.match(windowSource, /isTrustedAppUrl\(url, APP_INDEX_URL\)/);
  assert.equal(windowSource.includes("app.on('session-created'"), false);
  assert.equal(windowSource.includes('setPermissionCheckHandler(() => true)'), false);
  assert.equal(windowSource.includes('cb(true)'), false);
});

test('remote webviews have no nodeintegration attributes and use hardened preferences', () => {
  const domSource = source('src/renderer/dom.ts');
  assert.equal(domSource.includes("setAttribute('nodeintegration'"), false);
  assert.equal(domSource.includes("setAttribute('nodeintegrationinsubframes'"), false);
  assert.match(domSource, /REMOTE_WEBVIEW_PREFERENCES/);
});

test('trusted UI boots in isolated preload without exposing a bridge to page main world', () => {
  const preloadSource = source('src/preload/index.ts');
  assert.match(preloadSource, /require\('\.\.\/renderer\/index'\)/);
  assert.match(preloadSource, /creatorRendererReady/);
  assert.equal(preloadSource.includes('contextBridge.exposeInMainWorld'), false);
});

test('all IPC handlers are behind trusted sender and argument validation', () => {
  const ipcSource = source('src/main/ipc.ts');
  assert.match(ipcSource, /assertTrustedIpcSender/);
  assert.match(ipcSource, /isTrustedIpcSenderSnapshot/);
  assert.match(ipcSource, /assertArgumentCount/);
  assert.match(ipcSource, /assertScriptFile/);
  assert.equal(ipcSource.includes("path.join(__dirname, '..', '..', 'scripts', scriptFile"), false);

  const rawHandlers = ipcSource.match(/ipcMain\.handle\(/g) || [];
  assert.equal(rawHandlers.length, 1, 'only the trusted wrapper may call ipcMain.handle');
});

test('Creator CI includes a real Electron main-world isolation smoke test', () => {
  const workflow = source('../.github/workflows/creator-quality.yml');
  const smoke = source('tools/smoke-electron.js');
  assert.match(workflow, /xvfb-run -a npm run smoke:electron/);
  assert.match(smoke, /CREATOR_SMOKE_TEST/);
  assert.match(smoke, /\[CREATOR_SMOKE\] PASS/);
});
