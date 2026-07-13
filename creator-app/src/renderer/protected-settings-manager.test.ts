import test from 'node:test';
import assert from 'node:assert/strict';
import { RendererTabManager } from './tab-manager';
import { ProtectedSettingsView } from '../types';
import { LEGACY_BOT_SETTINGS_KEY, LEGACY_UPSTREAM_PROXY_KEY } from './protected-settings-migration';

class MemoryStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}


class FailingCleanupStorage extends MemoryStorage {
  removeItem(_key: string): void {
    throw new Error('synthetic cleanup failure');
  }
}

const VIEW: ProtectedSettingsView = {
  protection: { available: true, backend: 'windows-dpapi' },
  bot: { groupId: '42', userId: '123456', tokenConfigured: true },
  proxy: { socks: '127.0.0.1:1080', usernameConfigured: true, passwordConfigured: true },
};

function installGlobals(storage: MemoryStorage, bridge: Record<string, unknown>): () => void {
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const previousStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
  (globalThis as unknown as { window: unknown }).window = { bridge };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  return () => {
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
    (globalThis as unknown as { localStorage?: unknown }).localStorage = previousStorage;
  };
}

test('legacy plaintext is removed only after confirmed protected migration', async () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_BOT_SETTINGS_KEY, JSON.stringify({ token: 'legacy', groupId: '42', userId: '1' }));
  storage.setItem(LEGACY_UPSTREAM_PROXY_KEY, JSON.stringify({ socks: '', user: '', pass: '' }));
  const restore = installGlobals(storage, {
    migrateLegacySettings: async () => VIEW,
    getProtectedSettings: async () => VIEW,
  });
  try {
    const manager = new RendererTabManager(() => {});
    await manager.initializeProtectedSettings();
    assert.equal(storage.getItem(LEGACY_BOT_SETTINGS_KEY), null);
    assert.equal(storage.getItem(LEGACY_UPSTREAM_PROXY_KEY), null);
  } finally {
    restore();
  }
});

test('failed migration keeps plaintext until a later protected save succeeds', async () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_BOT_SETTINGS_KEY, JSON.stringify({ token: 'legacy', groupId: '42', userId: '1' }));
  const restore = installGlobals(storage, {
    migrateLegacySettings: async () => { throw new Error('synthetic migration failure'); },
    getProtectedSettings: async () => VIEW,
    saveProtectedSettings: async () => VIEW,
  });
  try {
    const manager = new RendererTabManager(() => {});
    await manager.initializeProtectedSettings();
    assert.notEqual(storage.getItem(LEGACY_BOT_SETTINGS_KEY), null);
    await manager.saveProtectedSettings({
      bot: { groupId: '42', userId: '1', token: { action: 'keep' } },
      proxy: { socks: '', username: { action: 'keep' }, password: { action: 'keep' } },
    });
    assert.equal(storage.getItem(LEGACY_BOT_SETTINGS_KEY), null);
  } finally {
    restore();
  }
});


test('successful protected migration does not hide a legacy plaintext cleanup failure', async () => {
  const storage = new FailingCleanupStorage();
  storage.setItem(LEGACY_BOT_SETTINGS_KEY, JSON.stringify({ token: 'legacy', groupId: '42', userId: '1' }));
  const restore = installGlobals(storage, {
    migrateLegacySettings: async () => VIEW,
    getProtectedSettings: async () => VIEW,
  });
  try {
    const manager = new RendererTabManager(() => {});
    await assert.rejects(
      manager.initializeProtectedSettings(),
      /legacy plaintext could not be removed/,
    );
    assert.notEqual(storage.getItem(LEGACY_BOT_SETTINGS_KEY), null);
  } finally {
    restore();
  }
});


test('migration confirmation refuses to delete a legacy secret missing from protected projection', async () => {
  const storage = new MemoryStorage();
  storage.setItem(
    LEGACY_BOT_SETTINGS_KEY,
    JSON.stringify({ token: 'legacy-token', groupId: '42', userId: '1' }),
  );
  const unconfirmed = {
    ...VIEW,
    bot: { ...VIEW.bot, tokenConfigured: false },
  };
  const restore = installGlobals(storage, {
    migrateLegacySettings: async () => unconfirmed,
    getProtectedSettings: async () => unconfirmed,
  });
  try {
    const manager = new RendererTabManager(() => {});
    await manager.initializeProtectedSettings();
    assert.notEqual(storage.getItem(LEGACY_BOT_SETTINGS_KEY), null);
  } finally {
    restore();
  }
});

test('a later keep-only save cannot delete a legacy token that was never protected', async () => {
  const storage = new MemoryStorage();
  storage.setItem(
    LEGACY_BOT_SETTINGS_KEY,
    JSON.stringify({ token: 'legacy-token', groupId: '42', userId: '1' }),
  );
  const unconfirmed = {
    ...VIEW,
    bot: { ...VIEW.bot, tokenConfigured: false },
  };
  const restore = installGlobals(storage, {
    saveProtectedSettings: async () => unconfirmed,
  });
  try {
    const manager = new RendererTabManager(() => {});
    await assert.rejects(
      manager.saveProtectedSettings({
        bot: { groupId: '42', userId: '1', token: { action: 'keep' } },
        proxy: { socks: '', username: { action: 'keep' }, password: { action: 'keep' } },
      }),
      /legacy secrets are not confirmed/,
    );
    assert.notEqual(storage.getItem(LEGACY_BOT_SETTINGS_KEY), null);
    assert.equal(manager.botRunning, false);
  } finally {
    restore();
  }
});
