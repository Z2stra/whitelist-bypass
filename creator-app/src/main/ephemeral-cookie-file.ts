import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const COOKIE_TEMP_PREFIX = 'whitelist-bypass-cookies-';
export const DEFAULT_STALE_COOKIE_AGE_MS = 24 * 60 * 60 * 1000;

export interface EphemeralCookieFile {
  filePath: string;
  directory: string;
  cleanup(): Promise<void>;
  cleanupSync(): void;
}

export async function createEphemeralCookieFile(
  cookies: unknown,
  rootDirectory = os.tmpdir(),
): Promise<EphemeralCookieFile> {
  await fs.mkdir(rootDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(rootDirectory, COOKIE_TEMP_PREFIX));
  await fs.chmod(directory, 0o700).catch(() => {});
  const filePath = path.join(directory, 'cookies.json');
  try {
    await fs.writeFile(filePath, JSON.stringify(cookies), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return {
    filePath,
    directory,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    },
    cleanupSync() {
      if (cleaned) return;
      cleaned = true;
      try {
        fsSync.rmSync(directory, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function cleanupStaleCookieDirectories(
  rootDirectory = os.tmpdir(),
  maxAgeMs = DEFAULT_STALE_COOKIE_AGE_MS,
  now = Date.now(),
): Promise<number> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(rootDirectory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(COOKIE_TEMP_PREFIX)) continue;
    const directory = path.join(rootDirectory, entry.name);
    try {
      const stat = await fs.stat(directory);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

export async function removeLegacyPersistentCookieFiles(userDataDirectory: string): Promise<number> {
  const legacyNames = [
    'cookies-vk.json',
    'cookies-telemost.json',
    'cookies-yandex.json',
    'cookies-wbstream.json',
    'cookies-dion.json',
  ];
  let removed = 0;
  for (const name of legacyNames) {
    try {
      await fs.unlink(path.join(userDataDirectory, name));
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Best-effort cleanup. The caller must not log paths or cookie content.
      }
    }
  }
  return removed;
}
