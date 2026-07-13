import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import { createElectronProtectedSettingsStore } from './electron-protected-settings';
import { ProtectedSettingsStore } from './protected-settings';

function assertSmoke(condition: unknown): asserts condition {
  if (!condition) throw new Error('Protected settings smoke invariant failed');
}

export async function runProtectedSettingsSmoke(
  store: ProtectedSettingsStore,
  filePath: string,
): Promise<void> {
  const suffix = randomBytes(18).toString('base64url');
  const token = `vk-smoke-${suffix}`;
  const username = `user-${suffix}`;
  const password = `pass-${suffix}`;

  const view = await store.applyUpdate({
    bot: {
      groupId: '42',
      userId: '123456',
      token: { action: 'replace', value: token },
    },
    proxy: {
      socks: '127.0.0.1:1080',
      username: { action: 'replace', value: username },
      password: { action: 'replace', value: password },
    },
  });

  assertSmoke(view.protection.available);
  assertSmoke(view.protection.backend === 'windows-dpapi');
  assertSmoke(view.bot.tokenConfigured);
  assertSmoke(view.proxy.usernameConfigured && view.proxy.passwordConfigured);
  const projection = JSON.stringify(view);
  assertSmoke(!projection.includes(token));
  assertSmoke(!projection.includes(username));
  assertSmoke(!projection.includes(password));

  const raw = await fs.readFile(filePath, 'utf8');
  assertSmoke(!raw.includes(token));
  assertSmoke(!raw.includes(username));
  assertSmoke(!raw.includes(password));

  const reloaded = createElectronProtectedSettingsStore(filePath);
  await reloaded.initialize();
  assertSmoke(reloaded.getBotSettings().token === token);
  assertSmoke(reloaded.getUpstreamProxy().user === username);
  assertSmoke(reloaded.getUpstreamProxy().pass === password);
}
