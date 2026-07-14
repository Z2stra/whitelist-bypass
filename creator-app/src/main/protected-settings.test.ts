import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ProtectedSettingsCipher,
  ProtectedSettingsError,
  ProtectedSettingsStore,
} from './protected-settings';
import { evaluateSafeStorageStatus } from './safe-storage-policy';

class XorCipher implements ProtectedSettingsCipher {
  constructor(private readonly available = true) {}

  status() {
    return this.available
      ? { available: true, backend: 'test-keyring' }
      : { available: false, backend: 'unavailable', reason: 'test encryption unavailable' };
  }

  encrypt(plainText: string): Buffer {
    const input = Buffer.from(plainText, 'utf8');
    const output = Buffer.alloc(input.length);
    for (let index = 0; index < input.length; index += 1) output[index] = input[index] ^ 0x5a;
    return output;
  }

  decrypt(encrypted: Buffer): string {
    const output = Buffer.alloc(encrypted.length);
    for (let index = 0; index < encrypted.length; index += 1) output[index] = encrypted[index] ^ 0x5a;
    return output.toString('utf8');
  }
}

async function withTempStore(
  run: (store: ProtectedSettingsStore, filePath: string, directory: string) => Promise<void>,
  cipher: ProtectedSettingsCipher = new XorCipher(),
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-protected-settings-test-'));
  const filePath = path.join(directory, 'protected-settings.v1.json');
  try {
    const store = new ProtectedSettingsStore(filePath, cipher);
    await store.initialize();
    await run(store, filePath, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const INITIAL_UPDATE = {
  bot: {
    groupId: '42',
    userId: '123456',
    token: { action: 'replace', value: 'community-secret-token' },
  },
  proxy: {
    socks: '127.0.0.1:1080',
    username: { action: 'replace', value: 'proxy-user' },
    password: { action: 'replace', value: 'proxy-password' },
  },
} as const;

test('protected settings are encrypted at rest and renderer projection contains no secrets', async () => {
  await withTempStore(async (store, filePath) => {
    const view = await store.applyUpdate(INITIAL_UPDATE);
    assert.equal(view.protection.available, true);
    assert.equal(view.bot.tokenConfigured, true);
    assert.equal(view.proxy.usernameConfigured, true);
    assert.equal(view.proxy.passwordConfigured, true);
    assert.equal(JSON.stringify(view).includes('community-secret-token'), false);
    assert.equal(JSON.stringify(view).includes('proxy-password'), false);
    assert.deepEqual(store.getBotSettings(), {
      token: 'community-secret-token',
      groupId: '42',
      userId: '123456',
    });
    assert.deepEqual(store.getUpstreamProxy(), {
      socks: '127.0.0.1:1080',
      user: 'proxy-user',
      pass: 'proxy-password',
    });

    const raw = await fs.readFile(filePath, 'utf8');
    for (const secret of ['community-secret-token', 'proxy-user', 'proxy-password']) {
      assert.equal(raw.includes(secret), false, `${secret} appeared in the protected file`);
    }

    const reloaded = new ProtectedSettingsStore(filePath, new XorCipher());
    await reloaded.initialize();
    assert.deepEqual(reloaded.getBotSettings(), store.getBotSettings());
    assert.deepEqual(reloaded.getUpstreamProxy(), store.getUpstreamProxy());
  });
});

test('updates have explicit keep, replace and clear semantics', async () => {
  await withTempStore(async (store) => {
    await store.applyUpdate(INITIAL_UPDATE);
    await store.applyUpdate({
      bot: {
        groupId: '43',
        userId: '654321',
        token: { action: 'keep' },
      },
      proxy: {
        socks: '',
        username: { action: 'clear' },
        password: { action: 'replace', value: 'new-password' },
      },
    });
    assert.deepEqual(store.getBotSettings(), {
      token: 'community-secret-token',
      groupId: '43',
      userId: '654321',
    });
    assert.deepEqual(store.getUpstreamProxy(), {
      socks: '',
      user: '',
      pass: 'new-password',
    });

    await store.applyUpdate({
      bot: { groupId: '', userId: '', token: { action: 'clear' } },
      proxy: {
        socks: '',
        username: { action: 'clear' },
        password: { action: 'clear' },
      },
    });
    assert.equal(store.getView().bot.tokenConfigured, false);
    assert.equal(store.getView().proxy.passwordConfigured, false);
  });
});

test('legacy migration is encrypted, idempotent and never overwrites protected values', async () => {
  await withTempStore(async (store, filePath) => {
    const view = await store.migrateLegacy({
      hadLegacy: true,
      botSettings: { token: 'legacy-token', groupId: '42', userId: '123456' },
      upstreamProxy: { socks: '127.0.0.1:1080', user: 'legacy-user', pass: 'legacy-pass' },
    });
    assert.equal(view.bot.tokenConfigured, true);
    assert.deepEqual(store.getBotSettings(), {
      token: 'legacy-token',
      groupId: '42',
      userId: '123456',
    });

    await store.migrateLegacy({
      hadLegacy: true,
      botSettings: { token: 'overwrite-token', groupId: '99', userId: '999' },
      upstreamProxy: { socks: 'evil:1', user: 'overwrite', pass: 'overwrite' },
    });
    assert.equal(store.getBotSettings().token, 'legacy-token');
    assert.equal(store.getUpstreamProxy().pass, 'legacy-pass');
    const raw = await fs.readFile(filePath, 'utf8');
    assert.equal(raw.includes('legacy-token'), false);
  });
});

test('unavailable OS encryption refuses writes and preserves the absence of a store file', async () => {
  await withTempStore(async (store, filePath) => {
    assert.equal(store.getView().protection.available, false);
    await assert.rejects(
      store.applyUpdate(INITIAL_UPDATE),
      (error: Error) => error instanceof ProtectedSettingsError && error.code === 'ENCRYPTION_UNAVAILABLE',
    );
    await assert.rejects(fs.stat(filePath), /ENOENT/);
  }, new XorCipher(false));
});

test('corrupt protected settings are quarantined without exposing their contents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-corrupt-settings-test-'));
  const filePath = path.join(directory, 'protected-settings.v1.json');
  try {
    await fs.writeFile(filePath, '{not-json', 'utf8');
    const store = new ProtectedSettingsStore(filePath, new XorCipher());
    await store.initialize();
    const view = store.getView();
    assert.equal(view.bot.tokenConfigured, false);
    assert.match(view.protection.warning || '', /moved aside/);
    const files = await fs.readdir(directory);
    assert.equal(files.some((name) => name.startsWith('protected-settings.v1.json.corrupt-')), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('safeStorage status rejects Linux basic_text and identifies Windows DPAPI', () => {
  assert.deepEqual(evaluateSafeStorageStatus('win32', true), {
    available: true,
    backend: 'windows-dpapi',
  });
  assert.equal(evaluateSafeStorageStatus('linux', true, 'basic_text').available, false);
  assert.equal(evaluateSafeStorageStatus('linux', true, 'gnome_libsecret').available, true);
  assert.equal(evaluateSafeStorageStatus('win32', false).available, false);
});

test('concurrent protected updates are serialized and leave a decryptable final store', async () => {
  await withTempStore(async (store, filePath) => {
    await store.applyUpdate(INITIAL_UPDATE);
    await Promise.all([
      store.applyUpdate({
        bot: { groupId: '100', userId: '200', token: { action: 'keep' } },
        proxy: { socks: 'first:1', username: { action: 'keep' }, password: { action: 'keep' } },
      }),
      store.applyUpdate({
        bot: { groupId: '300', userId: '400', token: { action: 'keep' } },
        proxy: { socks: 'second:2', username: { action: 'keep' }, password: { action: 'keep' } },
      }),
    ]);

    assert.deepEqual(store.getBotSettings(), {
      token: 'community-secret-token',
      groupId: '300',
      userId: '400',
    });
    assert.equal(store.getUpstreamProxy().socks, 'second:2');

    const reloaded = new ProtectedSettingsStore(filePath, new XorCipher());
    await reloaded.initialize();
    assert.deepEqual(reloaded.getBotSettings(), store.getBotSettings());
    assert.deepEqual(reloaded.getUpstreamProxy(), store.getUpstreamProxy());
  });
});

test('SOCKS endpoint is strictly host:port and cannot smuggle credentials into the renderer projection', async () => {
  await withTempStore(async (store) => {
    for (const endpoint of ['127.0.0.1:1080', 'localhost:1080', 'proxy.example:443', '[::1]:1080']) {
      const view = await store.applyUpdate({
        bot: { groupId: '', userId: '', token: { action: 'keep' } },
        proxy: {
          socks: endpoint,
          username: { action: 'keep' },
          password: { action: 'keep' },
        },
      });
      assert.equal(view.proxy.socks, endpoint.toLowerCase());
    }

    for (const endpoint of [
      'socks5://user:pass@127.0.0.1:1080',
      'user:pass@127.0.0.1:1080',
      '127.0.0.1:0',
      '127.0.0.1:65536',
      '127.0.0.1',
      'evil host:1080',
    ]) {
      await assert.rejects(
        store.applyUpdate({
          bot: { groupId: '', userId: '', token: { action: 'keep' } },
          proxy: {
            socks: endpoint,
            username: { action: 'keep' },
            password: { action: 'keep' },
          },
        }),
        ProtectedSettingsError,
      );
    }
  });
});

test('proxy credentials are opaque and survive protected-store round trips byte-for-byte', async () => {
  await withTempStore(async (store, filePath) => {
    const username = ' user with spaces ';
    const password = ' pass with spaces ';
    await store.applyUpdate({
      bot: { groupId: '', userId: '', token: { action: 'keep' } },
      proxy: {
        socks: '127.0.0.1:1080',
        username: { action: 'replace', value: username },
        password: { action: 'replace', value: password },
      },
    });
    assert.deepEqual(store.getUpstreamProxy(), {
      socks: '127.0.0.1:1080',
      user: username,
      pass: password,
    });

    const reloaded = new ProtectedSettingsStore(filePath, new XorCipher());
    await reloaded.initialize();
    assert.deepEqual(reloaded.getUpstreamProxy(), store.getUpstreamProxy());
  });
});


test('newer protected-store versions are preserved in place and block downgrade writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-newer-settings-test-'));
  const filePath = path.join(directory, 'protected-settings.v1.json');
  const original = JSON.stringify({ version: 2, ciphertext: 'QUJDRA==' });
  try {
    await fs.writeFile(filePath, original, 'utf8');
    const store = new ProtectedSettingsStore(filePath, new XorCipher());
    await store.initialize();
    const view = store.getView();
    assert.equal(view.protection.available, false);
    assert.match(view.protection.warning || '', /newer Creator version/);
    await assert.rejects(
      store.applyUpdate(INITIAL_UPDATE),
      (error: Error) =>
        error instanceof ProtectedSettingsError && error.code === 'UNSUPPORTED_STORE_VERSION',
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    const files = await fs.readdir(directory);
    assert.equal(files.some((name) => name.includes('.corrupt-')), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
