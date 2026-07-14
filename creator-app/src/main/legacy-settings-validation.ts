import { LegacyPlaintextSettings, SecretValueUpdate } from '../types';
import {
  ProtectedSettingsError,
  validateProtectedSettingsUpdate,
} from './protected-settings';

function requireOptionalRecord(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalSecretUpdate(value: unknown, trimEmpty: boolean): unknown {
  if (value === undefined || value === null) return { action: 'keep' };
  if (typeof value === 'string' && (trimEmpty ? value.trim() : value).length === 0) {
    return { action: 'keep' };
  }
  return { action: 'replace', value };
}

function replacementValue(update: SecretValueUpdate): string {
  return update.action === 'replace' ? update.value : '';
}

export function validateAndNormalizeLegacySettingsMigration(
  value: unknown,
): LegacyPlaintextSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtectedSettingsError('INVALID_INPUT', 'Legacy settings migration must be an object');
  }
  const record = value as Record<string, unknown>;
  const bot = requireOptionalRecord(record, 'botSettings', 'Legacy bot settings');
  const proxy = requireOptionalRecord(record, 'upstreamProxy', 'Legacy proxy settings');

  const validated = validateProtectedSettingsUpdate({
    bot: {
      groupId: bot?.groupId ?? '',
      userId: bot?.userId ?? '',
      token: optionalSecretUpdate(bot?.token, true),
    },
    proxy: {
      socks: proxy?.socks ?? '',
      username: optionalSecretUpdate(proxy?.user, false),
      password: optionalSecretUpdate(proxy?.pass, false),
    },
  });

  const normalized: LegacyPlaintextSettings = {
    hadLegacy: record.hadLegacy === true,
  };
  if (bot) {
    normalized.botSettings = {
      token: replacementValue(validated.bot.token),
      groupId: validated.bot.groupId,
      userId: validated.bot.userId,
    };
  }
  if (proxy) {
    normalized.upstreamProxy = {
      socks: validated.proxy.socks,
      user: replacementValue(validated.proxy.username),
      pass: replacementValue(validated.proxy.password),
    };
  }
  return normalized;
}
