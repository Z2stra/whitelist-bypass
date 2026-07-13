import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('renderer no longer persists or receives long-lived VK/proxy secrets', () => {
  const manager = source('src/renderer/tab-manager.ts');
  const renderer = source('src/renderer/index.ts');
  const preload = source('src/preload/index.ts');
  const types = source('src/types.ts');

  assert.equal(manager.includes("localStorage.getItem('botSettings')"), false);
  assert.equal(manager.includes("localStorage.setItem('botSettings'"), false);
  assert.equal(manager.includes("localStorage.getItem('upstreamProxy')"), false);
  assert.equal(manager.includes("localStorage.setItem('upstreamProxy'"), false);
  assert.equal(renderer.includes('tm.botSettings'), false);
  assert.equal(renderer.includes('tm.upstreamProxy'), false);
  assert.match(preload, /startBot\(\)\s*{/);
  assert.doesNotMatch(preload, /startBot\([^)]*settings/);
  assert.doesNotMatch(preload, /setUpstreamProxy/);
  assert.match(types, /tokenConfigured:\s*boolean/);
  assert.match(types, /passwordConfigured:\s*boolean/);
  assert.match(manager, /saveProtectedSettings[\s\S]*removeLegacyPlaintextSettings\(localStorage\)/);
  assert.match(renderer, /clearTransientSecretInputs/);
  assert.match(renderer, /closeSettings\(\): void \{[\s\S]*clearTransientSecretInputs\(\)/);
});

test('main process owns safeStorage and protected file persistence', () => {
  const adapter = source('src/main/electron-protected-settings.ts');
  const store = source('src/main/protected-settings.ts');
  const policy = source('src/main/safe-storage-policy.ts');
  const index = source('src/main/index.ts');
  const ipc = source('src/main/ipc.ts');
  const workflow = source('../.github/workflows/creator-quality.yml');
  const packageJson = source('package.json');

  assert.match(adapter, /safeStorage\.encryptString/);
  assert.match(adapter, /safeStorage\.decryptString/);
  assert.match(policy, /basic_text/);
  assert.match(store, /ciphertext/);
  assert.doesNotMatch(store, /console\.(?:log|warn|error)/);
  assert.equal(store.includes('fs.unlink(this.filePath)'), false);
  assert.match(index, /protected-settings\.v1\.json/);
  assert.match(ipc, /assertNoArguments\(args\);[\s\S]*protectedSettings\.getBotSettings\(\)/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /npm run smoke:protected-storage/);
  assert.match(packageJson, /smoke:protected-storage/);
});

test('cookie export is removed and child cookie files are ephemeral', () => {
  const html = source('index.html');
  const constants = source('src/constants.ts');
  const preload = source('src/preload/index.ts');
  const manager = source('src/main/tab-manager.ts');
  const cookiePolicy = source('src/main/cookie-domain-policy.ts');

  assert.equal(html.includes('btnExportCookies'), false);
  assert.equal(constants.includes('EXPORT_COOKIES'), false);
  assert.equal(preload.includes('exportCookies'), false);
  assert.match(manager, /createEphemeralCookieFile/);
  assert.equal(manager.includes('buildCookiesZip'), false);
  assert.equal(manager.includes("app.getPath('userData'), `cookies-${platform}.json`"), false);
  assert.match(manager, /cookieDomainMatchesRoots/);
  assert.match(manager, /waitForCookies\(names: string\[\], cookieDomains: string\[\]\)/);
  assert.match(manager, /pass: proxy\?\.pass \|\| ''/);
  assert.match(cookiePolicy, /domain === root \|\| domain\.endsWith/);
  assert.equal(manager.includes('persisted ${id}'), false);
});
