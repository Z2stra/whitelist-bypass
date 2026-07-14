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
  assert.match(manager, /hasPendingLegacyPlaintext\(\)/);
  assert.match(manager, /autoStartBot[\s\S]*hasPendingLegacyPlaintext\(\)[\s\S]*botEnabled[\s\S]*false/);
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

test('cookie export is removed, child cookie files are ephemeral and WB device IDs are not logged', () => {
  const html = source('index.html');
  const constants = source('src/constants.ts');
  const preload = source('src/preload/index.ts');
  const manager = source('src/main/tab-manager.ts');
  const windowSource = source('src/main/window.ts');
  const wbDeviceId = source('src/main/wb-device-id.ts');
  const cookiePolicy = source('src/main/cookie-domain-policy.ts');

  assert.equal(html.includes('btnExportCookies'), false);
  assert.equal(constants.includes('EXPORT_COOKIES'), false);
  assert.equal(preload.includes('exportCookies'), false);
  assert.match(manager, /createEphemeralCookieFile/);
  assert.equal(manager.includes('buildCookiesZip'), false);
  assert.equal(manager.includes("app.getPath('userData'), `cookies-${platform}.json`"), false);
  assert.match(manager, /cookieDomainMatchesRoots/);
  assert.match(manager, /waitForCookies\([\s\S]*signal: AbortSignal/);
  assert.match(manager, /pass: proxy\?\.pass \|\| ''/);
  assert.match(cookiePolicy, /domain === root \|\| domain\.endsWith/);
  assert.equal(manager.includes('persisted ${id}'), false);

  assert.equal(windowSource.includes("console.log('[WB_DEVICE_ID]'"), false);
  assert.equal(windowSource.includes('Storage.prototype.setItem'), false);
  assert.doesNotMatch(windowSource, /console-message[\s\S]*parseWBDeviceId/);
  assert.match(windowSource, /executeJavaScript\(WB_DEVICE_ID_READ_SCRIPT, true\)/);
  assert.match(windowSource, /normalizeWBDeviceId\(value\)/);
  assert.match(wbDeviceId, /MAX_WB_DEVICE_ID_LENGTH/);
  assert.match(wbDeviceId, /url\.protocol === 'https:'[\s\S]*stream\.wb\.ru/);
});

test('protected settings rotation does not hold the lifecycle queue while login is pending', () => {
  const index = source('src/main/index.ts');
  const ipc = source('src/main/ipc.ts');
  const manager = source('src/main/tab-manager.ts');
  const form = source('src/renderer/protected-settings-form.ts');

  assert.match(index, /app\.requestSingleInstanceLock\(\)/);
  assert.match(index, /app\.on\('second-instance'/);
  assert.match(ipc, /tabManager\.setSecretLifecycleRunner\(runSecretLifecycle\)/);

  const startHeadlessStart = ipc.indexOf('registerTrustedHandler(IPC.START_HEADLESS');
  const closeTabStart = ipc.indexOf('registerTrustedHandler(IPC.CLOSE_TAB', startHeadlessStart);
  assert.notEqual(startHeadlessStart, -1);
  assert.notEqual(closeTabStart, -1);
  const startHeadlessHandler = ipc.slice(startHeadlessStart, closeTabStart);
  assert.match(startHeadlessHandler, /tabManager\.startHeadless/);
  assert.doesNotMatch(startHeadlessHandler, /runSecretLifecycle/);

  const startHeadlessMethod = manager.slice(
    manager.indexOf('async startHeadless('),
    manager.indexOf('private beginHeadlessStart', manager.indexOf('async startHeadless(')),
  );
  assert.match(startHeadlessMethod, /waitForLogin\([\s\S]*signal/);
  assert.match(startHeadlessMethod, /waitForCookies\([\s\S]*signal/);
  assert.match(startHeadlessMethod, /await this\.runSecretLifecycle/);
  assert.ok(
    startHeadlessMethod.indexOf('await this.waitFor') <
      startHeadlessMethod.indexOf('await this.runSecretLifecycle'),
    'login waits must complete before the credential lifecycle lock is acquired',
  );

  const rotationStart = ipc.indexOf('const rotateSecretConsumers');
  const firstHandlerStart = ipc.indexOf('registerTrustedHandler', rotationStart);
  const rotation = ipc.slice(rotationStart, firstHandlerStart);
  assert.match(rotation, /invalidateSecretConsumers\(\)/);
  assert.match(rotation, /runSecretLifecycle/);
  assert.ok(
    rotation.indexOf('invalidateSecretConsumers()') < rotation.indexOf('runSecretLifecycle'),
    'pending login waits must be aborted before credential rotation enters the queue',
  );
  assert.match(rotation, /finally[\s\S]*await pendingHeadlessStarts/);

  const saveStart = ipc.indexOf('registerTrustedHandler(IPC.SAVE_PROTECTED_SETTINGS');
  const saveEnd = ipc.indexOf('registerTrustedHandler(IPC.START_BOT', saveStart);
  const saveHandler = ipc.slice(saveStart, saveEnd);
  assert.match(saveHandler, /validateProtectedSettingsUpdate/);
  assert.match(saveHandler, /rotateSecretConsumers/);
  assert.ok(
    saveHandler.indexOf('validateProtectedSettingsUpdate') <
      saveHandler.indexOf('rotateSecretConsumers'),
    'settings input must be validated before consumers are invalidated',
  );

  assert.match(manager, /async stopAllRelaysAndWait/);
  assert.match(manager, /activeProcesses = new Set<ChildProcess>/);
  assert.match(manager, /await terminateChildProcess\(proc\)/);
  assert.equal(manager.includes("user: (proxy?.user || '').trim()"), false);
  assert.match(form, /username:\s*username.length > 0[\s\S]*action: 'replace', value: username/);
  assert.match(form, /password:\s*password.length > 0[\s\S]*action: 'replace', value: password/);
});

test('tab close, bot replies and legacy migration share the safe lifecycle boundary', () => {
  const ipc = source('src/main/ipc.ts');
  const manager = source('src/main/tab-manager.ts');
  const validation = source('src/main/legacy-settings-validation.ts');

  const closeStart = ipc.indexOf('registerTrustedHandler(IPC.CLOSE_TAB');
  const closeEnd = ipc.indexOf('registerTrustedHandler(IPC.GET_PROTECTED_SETTINGS', closeStart);
  const closeHandler = ipc.slice(closeStart, closeEnd);
  assert.match(closeHandler, /closeTabAndWait/);
  assert.doesNotMatch(closeHandler, /deleteTab\(/);

  assert.match(manager, /closeTabAndWait\(tabId: string\): Promise<void>/);
  assert.match(manager, /cancelPendingHeadlessStarts/);
  assert.match(manager, /await this\.runSecretLifecycle[\s\S]*await this\.stopRelayAndWait/);
  assert.match(manager, /await Promise\.all\(pendingStarts\.map\(\(pending\) => pending\.settled\)\)/);
  assert.match(manager, /cleanupCookieLease/);

  const sendStart = manager.indexOf('async sendBotCallLink');
  const sendEnd = manager.indexOf('setUpstreamProxy', sendStart);
  const sendMethod = manager.slice(sendStart, sendEnd);
  assert.match(sendMethod, /return this\.runSecretLifecycle/);
  assert.match(source('src/main/window.ts'), /tabManager[\s\S]*\.sendBotCallLink/);

  const migrateStart = ipc.indexOf('registerTrustedHandler(IPC.MIGRATE_LEGACY_SETTINGS');
  const migrateEnd = ipc.indexOf('registerTrustedHandler(IPC.SAVE_PROTECTED_SETTINGS', migrateStart);
  const migrateHandler = ipc.slice(migrateStart, migrateEnd);
  assert.match(migrateHandler, /validateAndNormalizeLegacySettingsMigration/);
  assert.match(migrateHandler, /rotateSecretConsumers/);
  assert.ok(
    migrateHandler.indexOf('validateAndNormalizeLegacySettingsMigration') <
      migrateHandler.indexOf('rotateSecretConsumers'),
    'legacy migration must validate before any bot or process is stopped',
  );
  assert.match(validation, /validateProtectedSettingsUpdate/);
  assert.match(validation, /Proxy username/);
});
