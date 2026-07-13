import { BotSettings, LegacyPlaintextSettings, UpstreamProxy } from '../types';

export const LEGACY_BOT_SETTINGS_KEY = 'botSettings';
export const LEGACY_UPSTREAM_PROXY_KEY = 'upstreamProxy';
const MAX_LEGACY_VALUE_LENGTH = 32 * 1024;

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.length > MAX_LEGACY_VALUE_LENGTH) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

export function collectLegacyPlaintextSettings(storage: StorageLike): LegacyPlaintextSettings {
  const rawBot = storage.getItem(LEGACY_BOT_SETTINGS_KEY);
  const rawProxy = storage.getItem(LEGACY_UPSTREAM_PROXY_KEY);
  const bot = parseObject(rawBot);
  const proxy = parseObject(rawProxy);
  const result: LegacyPlaintextSettings = {
    hadLegacy: rawBot !== null || rawProxy !== null,
  };

  if (rawBot !== null) {
    const botSettings: BotSettings = {
      token: stringField(bot, 'token'),
      groupId: stringField(bot, 'groupId'),
      userId: stringField(bot, 'userId'),
    };
    result.botSettings = botSettings;
  }
  if (rawProxy !== null) {
    const upstreamProxy: UpstreamProxy = {
      socks: stringField(proxy, 'socks'),
      user: stringField(proxy, 'user'),
      pass: stringField(proxy, 'pass'),
    };
    result.upstreamProxy = upstreamProxy;
  }
  return result;
}

export function removeLegacyPlaintextSettings(storage: StorageLike): boolean {
  try {
    storage.removeItem(LEGACY_BOT_SETTINGS_KEY);
    storage.removeItem(LEGACY_UPSTREAM_PROXY_KEY);
    return (
      storage.getItem(LEGACY_BOT_SETTINGS_KEY) === null &&
      storage.getItem(LEGACY_UPSTREAM_PROXY_KEY) === null
    );
  } catch {
    return false;
  }
}
