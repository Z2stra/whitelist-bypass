import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  COOKIE_TEMP_PREFIX,
  cleanupStaleCookieDirectories,
  createEphemeralCookieFile,
  removeLegacyPersistentCookieFiles,
} from './ephemeral-cookie-file';

test('cookie material is written to a random ephemeral directory and removed by cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-cookie-root-test-'));
  try {
    const secret = 'cookie-secret-value';
    const lease = await createEphemeralCookieFile([{ name: 'session', value: secret }], root);
    assert.equal(path.basename(lease.directory).startsWith(COOKIE_TEMP_PREFIX), true);
    assert.equal(path.dirname(lease.filePath), lease.directory);
    assert.equal((await fs.readFile(lease.filePath, 'utf8')).includes(secret), true);
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(lease.filePath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    await lease.cleanup();
    await assert.rejects(fs.stat(lease.directory), /ENOENT/);
    await lease.cleanup();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale cookie cleanup preserves fresh directories and removes old ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-cookie-stale-test-'));
  try {
    const oldDir = await fs.mkdtemp(path.join(root, COOKIE_TEMP_PREFIX));
    const freshDir = await fs.mkdtemp(path.join(root, COOKIE_TEMP_PREFIX));
    const now = Date.now();
    await fs.utimes(oldDir, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));
    const removed = await cleanupStaleCookieDirectories(root, 24 * 60 * 60 * 1000, now);
    assert.equal(removed, 1);
    await assert.rejects(fs.stat(oldDir), /ENOENT/);
    assert.equal((await fs.stat(freshDir)).isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy persistent plaintext cookie JSON files are deleted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wlb-cookie-legacy-test-'));
  try {
    for (const name of ['cookies-vk.json', 'cookies-telemost.json', 'cookies-wbstream.json']) {
      await fs.writeFile(path.join(root, name), 'secret-cookie-json', 'utf8');
    }
    await fs.writeFile(path.join(root, 'unrelated.json'), 'keep', 'utf8');
    assert.equal(await removeLegacyPersistentCookieFiles(root), 3);
    assert.equal(await fs.readFile(path.join(root, 'unrelated.json'), 'utf8'), 'keep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
