import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtectedSettingsError } from './protected-settings';
import { validateAndNormalizeLegacySettingsMigration } from './legacy-settings-validation';

test('legacy migration is fully validated and normalized before consumers are stopped', () => {
  const normalized = validateAndNormalizeLegacySettingsMigration({
    hadLegacy: true,
    botSettings: {
      token: '  community-token  ',
      groupId: ' 42 ',
      userId: ' 123, 456 ',
    },
    upstreamProxy: {
      socks: 'PROXY.EXAMPLE:1080',
      user: ' proxy user ',
      pass: ' proxy pass ',
    },
  });

  assert.deepEqual(normalized, {
    hadLegacy: true,
    botSettings: {
      token: 'community-token',
      groupId: '42',
      userId: '123, 456',
    },
    upstreamProxy: {
      socks: 'proxy.example:1080',
      user: ' proxy user ',
      pass: ' proxy pass ',
    },
  });
});

test('invalid legacy migration input is rejected without a partial normalized result', () => {
  for (const invalid of [
    null,
    { hadLegacy: true, botSettings: [] },
    { hadLegacy: true, botSettings: { token: 123 } },
    { hadLegacy: true, upstreamProxy: { socks: 'user:pass@127.0.0.1:1080' } },
  ]) {
    assert.throws(
      () => validateAndNormalizeLegacySettingsMigration(invalid),
      (error: Error) => error instanceof ProtectedSettingsError && error.code === 'INVALID_INPUT',
    );
  }
});
