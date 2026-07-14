import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProtectedSettingsUpdate,
  protectionSummary,
} from './protected-settings-form';

test('blank secret fields keep stored values while non-secret fields are updated', () => {
  assert.deepEqual(buildProtectedSettingsUpdate({
    groupId: ' 42 ',
    userId: ' 123456 ',
    token: '',
    clearToken: false,
    socks: ' 127.0.0.1:1080 ',
    proxyUsername: '',
    proxyPassword: '',
    clearProxyCredentials: false,
  }), {
    bot: { groupId: '42', userId: '123456', token: { action: 'keep' } },
    proxy: {
      socks: '127.0.0.1:1080',
      username: { action: 'keep' },
      password: { action: 'keep' },
    },
  });
});

test('explicit clear and replacement actions cannot be confused with blank keep fields', () => {
  const cleared = buildProtectedSettingsUpdate({
    groupId: '', userId: '', token: 'ignored', clearToken: true,
    socks: '', proxyUsername: 'ignored', proxyPassword: 'ignored', clearProxyCredentials: true,
  });
  assert.deepEqual(cleared.bot.token, { action: 'clear' });
  assert.deepEqual(cleared.proxy.username, { action: 'clear' });
  assert.deepEqual(cleared.proxy.password, { action: 'clear' });

  const replaced = buildProtectedSettingsUpdate({
    groupId: '42', userId: '123', token: ' new-token ', clearToken: false,
    socks: 'proxy:1080', proxyUsername: ' user ', proxyPassword: ' pass with spaces ', clearProxyCredentials: false,
  });
  assert.deepEqual(replaced.bot.token, { action: 'replace', value: 'new-token' });
  assert.deepEqual(replaced.proxy.username, { action: 'replace', value: ' user ' });
  assert.deepEqual(replaced.proxy.password, { action: 'replace', value: ' pass with spaces ' });
});

test('protection summary never contains secret values', () => {
  const summary = protectionSummary({
    protection: { available: true, backend: 'windows-dpapi' },
    bot: { groupId: '42', userId: '123', tokenConfigured: true },
    proxy: { socks: 'proxy:1080', usernameConfigured: true, passwordConfigured: true },
  });
  assert.match(summary, /Windows DPAPI/);
  assert.equal(summary.includes('token'), false);
});


test('proxy username and password can be replaced independently without clearing the other secret', () => {
  const usernameOnly = buildProtectedSettingsUpdate({
    groupId: '', userId: '', token: '', clearToken: false,
    socks: 'proxy:1080', proxyUsername: 'new-user', proxyPassword: '', clearProxyCredentials: false,
  });
  assert.deepEqual(usernameOnly.proxy.username, { action: 'replace', value: 'new-user' });
  assert.deepEqual(usernameOnly.proxy.password, { action: 'keep' });

  const passwordOnly = buildProtectedSettingsUpdate({
    groupId: '', userId: '', token: '', clearToken: false,
    socks: 'proxy:1080', proxyUsername: '', proxyPassword: 'new-pass', clearProxyCredentials: false,
  });
  assert.deepEqual(passwordOnly.proxy.username, { action: 'keep' });
  assert.deepEqual(passwordOnly.proxy.password, { action: 'replace', value: 'new-pass' });
});
