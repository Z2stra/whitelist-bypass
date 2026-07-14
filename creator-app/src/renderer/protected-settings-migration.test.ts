import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLegacyPlaintextSettings,
  LEGACY_BOT_SETTINGS_KEY,
  LEGACY_UPSTREAM_PROXY_KEY,
  removeLegacyPlaintextSettings,
  StorageLike,
} from './protected-settings-migration';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
}

test('legacy plaintext settings are collected without inventing missing values', () => {
  const storage = new MemoryStorage();
  storage.values.set(LEGACY_BOT_SETTINGS_KEY, JSON.stringify({
    token: 'legacy-token',
    groupId: '42',
    userId: '123456',
  }));
  storage.values.set(LEGACY_UPSTREAM_PROXY_KEY, JSON.stringify({
    socks: '127.0.0.1:1080',
    user: 'legacy-user',
    pass: 'legacy-pass',
  }));
  assert.deepEqual(collectLegacyPlaintextSettings(storage), {
    hadLegacy: true,
    botSettings: { token: 'legacy-token', groupId: '42', userId: '123456' },
    upstreamProxy: { socks: '127.0.0.1:1080', user: 'legacy-user', pass: 'legacy-pass' },
  });
});

test('malformed legacy JSON remains marked for migration and cleanup', () => {
  const storage = new MemoryStorage();
  storage.values.set(LEGACY_BOT_SETTINGS_KEY, '{broken');
  assert.deepEqual(collectLegacyPlaintextSettings(storage), {
    hadLegacy: true,
    botSettings: { token: '', groupId: '', userId: '' },
  });
});

test('legacy keys are removed only by the explicit post-migration cleanup step', () => {
  const storage = new MemoryStorage();
  storage.values.set(LEGACY_BOT_SETTINGS_KEY, 'one');
  storage.values.set(LEGACY_UPSTREAM_PROXY_KEY, 'two');
  collectLegacyPlaintextSettings(storage);
  assert.equal(storage.values.size, 2);
  removeLegacyPlaintextSettings(storage);
  assert.equal(storage.values.size, 0);
});


test('legacy cleanup reports failure when plaintext storage cannot be cleared', () => {
  const values = new Map<string, string>([
    [LEGACY_BOT_SETTINGS_KEY, 'secret'],
    [LEGACY_UPSTREAM_PROXY_KEY, 'secret-proxy'],
  ]);
  const storage: StorageLike = {
    getItem(key) { return values.get(key) ?? null; },
    removeItem() { throw new Error('synthetic storage failure'); },
  };
  assert.equal(removeLegacyPlaintextSettings(storage), false);
  assert.equal(values.get(LEGACY_BOT_SETTINGS_KEY), 'secret');
});
