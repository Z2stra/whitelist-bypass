import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BotSecurityError,
  REDACTED,
  redactSensitiveText,
  safeErrorMessage,
  validateBotSettings,
} from './security';

test('validateBotSettings requires token, group ID, and a non-empty allowlist', () => {
  assert.throws(
    () => validateBotSettings({ token: '', groupId: '42', userId: '123' }),
    /community token is required/,
  );
  assert.throws(
    () => validateBotSettings({ token: 'token', groupId: '0', userId: '123' }),
    /group ID must be a positive integer/,
  );
  assert.throws(
    () => validateBotSettings({ token: 'token', groupId: '42', userId: ' , ' }),
    /At least one allowed VK user ID is required/,
  );
  assert.throws(
    () => validateBotSettings({ token: 'token', groupId: '42', userId: '123,abc' }),
    /Allowed VK user ID must be a positive integer/,
  );
});

test('validateBotSettings normalizes and deduplicates allowed user IDs', () => {
  const validated = validateBotSettings({
    token: '  community-token  ',
    groupId: ' 42 ',
    userId: '123, 456,123',
  });

  assert.equal(validated.token, 'community-token');
  assert.equal(validated.groupId, 42);
  assert.deepEqual([...validated.allowedUserIds], [123, 456]);
});

test('redactSensitiveText removes known credential and link formats', () => {
  const input = [
    'https://lp.vk.com/wh123?act=a_check&key=LONG_POLL_KEY&ts=1',
    'Authorization: Basic dXNlcjpwYXNz',
    'Proxy-Authorization=Bearer bearer-secret',
    'Cookie: remixsid=session-secret; other=value',
    'Set-Cookie: vc-refresh-token=refresh-secret',
    'socks5://alice:proxy-secret@127.0.0.1:1080',
    '--upstream-pass cli-secret',
    'access_token=vk-secret',
    'token: "json-secret"',
    'room=private-room-id',
    'https://vk.com/call/join/private-link',
    'wbstream://private-room',
    'dion://private-slug',
  ].join('\n');

  const redacted = redactSensitiveText(input);
  for (const secret of [
    'LONG_POLL_KEY',
    'dXNlcjpwYXNz',
    'bearer-secret',
    'session-secret',
    'refresh-secret',
    'proxy-secret',
    'cli-secret',
    'vk-secret',
    'json-secret',
    'private-room-id',
    'private-link',
    'private-room',
    'private-slug',
  ]) {
    assert.equal(redacted.includes(secret), false, `secret was not redacted: ${secret}`);
  }
  assert.ok(redacted.includes(REDACTED));
  assert.ok(redacted.includes('<redacted-url>'));
});

test('safeErrorMessage never repeats a raw network URL or Long Poll key', () => {
  const error = new Error(
    'request to https://lp.vk.com/check?act=a_check&key=LONG_POLL_SECRET&ts=1 failed',
  );
  (error as NodeJS.ErrnoException).code = 'ECONNRESET';

  const safe = safeErrorMessage(error, 'VK Long Poll');
  assert.equal(safe, 'VK Long Poll failed (ECONNRESET)');
  assert.equal(safe.includes('LONG_POLL_SECRET'), false);
  assert.equal(safe.includes('https://'), false);
});

test('safeErrorMessage preserves only explicitly safe BotSecurityError messages', () => {
  const error = new BotSecurityError('HTTP_ERROR', 'VK API messages.send returned HTTP 503');
  assert.equal(safeErrorMessage(error, 'ignored'), 'VK API messages.send returned HTTP 503');
});
