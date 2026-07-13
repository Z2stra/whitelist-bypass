import {
  BotSettings,
  LegacyPlaintextSettings,
  ProtectedSettingsUpdate,
  ProtectedSettingsView,
  SecretValueUpdate,
  UpstreamProxy,
} from '../types';

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

function trimmedText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function opaqueText(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function legacyMigrationIsConfirmed(
  legacy: LegacyPlaintextSettings,
  view: ProtectedSettingsView,
): boolean {
  if (!legacy.hadLegacy) return true;
  if (!view.protection.available) return false;
  if (trimmedText(legacy.botSettings?.token) && !view.bot.tokenConfigured) return false;
  if (trimmedText(legacy.botSettings?.groupId) && !view.bot.groupId) return false;
  if (trimmedText(legacy.botSettings?.userId) && !view.bot.userId) return false;
  if (trimmedText(legacy.upstreamProxy?.socks) && !view.proxy.socks) return false;
  if (opaqueText(legacy.upstreamProxy?.user) && !view.proxy.usernameConfigured) return false;
  if (opaqueText(legacy.upstreamProxy?.pass) && !view.proxy.passwordConfigured) return false;
  return true;
}

function secretResolved(
  legacyValue: string | undefined,
  update: SecretValueUpdate,
  configured: boolean,
  opaque: boolean,
): boolean {
  const present = opaque ? opaqueText(legacyValue) : trimmedText(legacyValue);
  return !present || update.action !== 'keep' || configured;
}

export function legacySecretsResolvedAfterSave(
  legacy: LegacyPlaintextSettings,
  update: ProtectedSettingsUpdate,
  view: ProtectedSettingsView,
): boolean {
  if (!legacy.hadLegacy) return true;
  if (!view.protection.available) return false;
  return (
    secretResolved(legacy.botSettings?.token, update.bot.token, view.bot.tokenConfigured, false) &&
    secretResolved(legacy.upstreamProxy?.user, update.proxy.username, view.proxy.usernameConfigured, true) &&
    secretResolved(legacy.upstreamProxy?.pass, update.proxy.password, view.proxy.passwordConfigured, true)
  );
}
