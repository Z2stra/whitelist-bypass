import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_WEBVIEW_PREFERENCES,
  TrustPolicyError,
  assertArgumentCount,
  assertBotSettingsShape,
  assertHeadlessStartArgs,
  assertOptionalPlatform,
  assertPlatform,
  assertRemoteUrl,
  assertScriptFile,
  assertSensitiveResult,
  assertTabId,
  assertTunnelMode,
  assertUpstreamProxy,
  hardenGuestWebPreferences,
  isAllowedPermission,
  isAllowedPopupUrl,
  isAllowedRemoteUrl,
  isLegacyHookUrl,
  isTrustedAppUrl,
  isTrustedIpcSenderSnapshot,
} from './trust-policy';
import { HeadlessMode, Platform, TunnelMode } from '../types';

test('remote URL allowlist accepts intended platform origins and subdomains', () => {
  for (const url of [
    'https://vk.com/im',
    'https://login.vk.com/',
    'https://telemost.yandex.ru/j/abc',
    'https://passport.yandex.ru/auth',
    'https://stream.wb.ru/room/abc',
    'https://dion.vc/event/abc',
  ]) {
    assert.equal(isAllowedRemoteUrl(url), true, url);
  }
});

test('remote URL allowlist rejects lookalikes, credentials, custom ports and unsafe schemes', () => {
  for (const url of [
    'http://vk.com/im',
    'https://vk.com:4443/im',
    'https://vk.com.evil.example/',
    'https://evilvk.com/',
    'https://user:pass@vk.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://evil.example/',
  ]) {
    assert.equal(isAllowedRemoteUrl(url), false, url);
  }
});

test('popup policy permits a secure blank bootstrap but rejects unsafe targets', () => {
  assert.equal(isAllowedPopupUrl('about:blank'), true);
  assert.equal(isAllowedPopupUrl('https://vk.com/login'), true);
  assert.equal(isAllowedPopupUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedPopupUrl('https://evil.example/'), false);
});

test('legacy CSP relaxation is limited to VK and Telemost documents', () => {
  assert.equal(isLegacyHookUrl('https://vk.com/call'), true);
  assert.equal(isLegacyHookUrl('https://calls.vk.com/room'), true);
  assert.equal(isLegacyHookUrl('https://telemost.yandex.ru/j/abc'), true);
  assert.equal(isLegacyHookUrl('https://passport.yandex.ru/auth'), false);
  assert.equal(isLegacyHookUrl('https://stream.wb.ru/'), false);
});

test('permission policy defaults to deny and only admits media/fullscreen on active call originstmp/evil.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    nodeIntegrationInWorker: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    webviewTag: true,
  };

  hardenGuestWebPreferences(preferences);

  assert.equal('preload' in preferences, false);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.nodeIntegrationInWorker, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.allowRunningInsecureContent, false);
  assert.equal(preferences.webviewTag, false);
  assert.match(REMOTE_WEBVIEW_PREFERENCES, /sandbox=yes/);
  assert.match(REMOTE_WEBVIEW_PREFERENCES, /nodeIntegration=no/);
});

test('trusted app URL and IPC sender require the exact local application document', () => {
  const expectedAppUrl = 'file:///opt/app/index.html';
  assert.equal(isTrustedAppUrl('file:///D:/APP/index.html', 'file:///d:/app/index.html'), true);
  assert.equal(isTrustedAppUrl(expectedAppUrl, expectedAppUrl), true);
  assert.equal(isTrustedAppUrl('file:///tmp/other/index.html', expectedAppUrl), false);
  assert.equal(isTrustedAppUrl('file:///opt/app/index.html?view=1', expectedAppUrl), true);
  assert.equal(isTrustedAppUrl('https://vk.com/index.html', expectedAppUrl), false);

  const valid = {
    senderId: 7,
    expectedSenderId: 7,
    frameUrl: expectedAppUrl,
    expectedFrameUrl: expectedAppUrl,
    isMainFrame: true,
  };
  assert.equal(isTrustedIpcSenderSnapshot(valid), true);
  assert.equal(isTrustedIpcSenderSnapshot({ ...valid, senderId: 8 }), false);
  assert.equal(isTrustedIpcSenderSnapshot({ ...valid, isMainFrame: false }), false);
  assert.equal(
    isTrustedIpcSenderSnapshot({ ...valid, frameUrl: 'file:///tmp/other/index.html' }),
    false,
  );
});

test('call script allowlist rejects traversal and unknown files', () => {
  assert.equal(assertScriptFile('call-checker.js'), 'call-checker.js');
  assert.equal(assertScriptFile('vk-call-creator.js'), 'vk-call-creator.js');
  assert.throws(() => assertScriptFile('../package.json'), TrustPolicyError);
  assert.throws(() => assertScriptFile('evil.js'), TrustPolicyError);
});

test('IPC scalar validators reject malformed values', () => {
  assert.equal(assertTabId('bot-tab-123'), 'bot-tab-123');
  assert.throws(() => assertTabId('../tab'), TrustPolicyError);
  assert.equal(assertPlatform(Platform.VK), Platform.VK);
  assert.equal(assertOptionalPlatform(undefined), undefined);
  assert.throws(() => assertPlatform('evil'), TrustPolicyError);
  assert.equal(assertTunnelMode(TunnelMode.HeadlessVK), TunnelMode.HeadlessVK);
  assert.throws(() => assertTunnelMode('root-shell'), TrustPolicyError);
  assert.equal(assertRemoteUrl('https://vk.com/im'), 'https://vk.com/im');
  assert.throws(() => assertRemoteUrl('https://evil.example/'), TrustPolicyError);
  assert.doesNotThrow(() => assertArgumentCount(2, [2, 3]));
  assert.throws(() => assertArgumentCount(4, [2, 3]), TrustPolicyError);
});

test('headless arguments enforce mode/target invariants', () => {
  assert.deepEqual(assertHeadlessStartArgs({ mode: HeadlessMode.Create }), {
    mode: HeadlessMode.Create,
  });
  assert.deepEqual(
    assertHeadlessStartArgs({ mode: HeadlessMode.Join, target: 'https://vk.com/call/join/x' }),
    { mode: HeadlessMode.Join, target: 'https://vk.com/call/join/x' },
  );
  assert.throws(
    () => assertHeadlessStartArgs({ mode: HeadlessMode.Join, target: '' }),
    TrustPolicyError,
  );
  assert.throws(
    () => assertHeadlessStartArgs({ mode: HeadlessMode.Create, target: 'unexpected' }),
    TrustPolicyError,
  );
});

test('settings, proxy and sensitive-result validators reject malformed or oversized values', () => {
  assert.deepEqual(
    assertBotSettingsShape({ token: 'token', groupId: '42', userId: '100' }),
    { token: 'token', groupId: '42', userId: '100' },
  );
  assert.throws(() => assertBotSettingsShape(null), TrustPolicyError);
  assert.throws(
    () => assertBotSettingsShape({ token: 1, groupId: '42', userId: '100' }),
    TrustPolicyError,
  );

  assert.deepEqual(assertUpstreamProxy({ socks: '', user: '', pass: '' }), {
    socks: '',
    user: '',
    pass: '',
  });
  assert.throws(() => assertUpstreamProxy({ socks: [], user: '', pass: '' }), TrustPolicyError);
  assert.throws(
    () => assertUpstreamProxy({ socks: '127.0.0.1:1080\tignored', user: '', pass: '' }),
    TrustPolicyError,
  );
  assert.equal(assertSensitiveResult('Joined successfully'), 'Joined successfully');
  assert.throws(() => assertSensitiveResult('line\tbreak'), TrustPolicyError);
  assert.throws(() => assertSensitiveResult('x'.repeat(5000)), TrustPolicyError);
});
