import { BotSettings } from '../types';

export const REDACTED = '<redacted>';

export class BotSecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BotSecurityError';
    this.code = code;
  }
}

export interface ValidatedBotSettings {
  token: string;
  groupId: number;
  allowedUserIds: ReadonlySet<number>;
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BotSecurityError('INVALID_SETTINGS', `${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BotSecurityError('INVALID_SETTINGS', `${label} is outside the supported range`);
  }
  return parsed;
}

export function validateBotSettings(settings: BotSettings): ValidatedBotSettings {
  const token = settings.token.trim();
  if (!token) {
    throw new BotSecurityError('INVALID_SETTINGS', 'VK community token is required');
  }

  const groupId = parsePositiveInteger(settings.groupId, 'VK group ID');
  const rawAllowedIds = settings.userId
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawAllowedIds.length === 0) {
    throw new BotSecurityError('INVALID_SETTINGS', 'At least one allowed VK user ID is required');
  }

  const allowedUserIds = new Set<number>();
  for (const rawId of rawAllowedIds) {
    allowedUserIds.add(parsePositiveInteger(rawId, 'Allowed VK user ID'));
  }

  return { token, groupId, allowedUserIds };
}

export function redactSensitiveText(value: unknown): string {
  let text = typeof value === 'string' ? value : String(value ?? '');

  text = text.replace(
    /\b(?:https?:\/\/|socks5h?:\/\/|socks:\/\/|wbstream:\/\/|dion:\/\/)[^\s"'<>]+/gi,
    '<redacted-url>',
  );
  text = text.replace(
    /((?:proxy-)?authorization\s*[:=]\s*)(?:(?:basic|bearer)\s+)?[^\s,;]+/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`);
  text = text.replace(
    /(--(?:upstream-pass|password|token|cookie)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(
    /([?&]?(?:access_token|refresh_token|token|key|password|pass|secret)=)[^&\s]+/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(
    /(["']?(?:access_token|refresh_token|token|password|pass|secret|cookie|key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(
    /(\b(?:room|room_id|slug|session|session_id)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    `$1${REDACTED}`,
  );

  return text;
}

export function safeErrorMessage(error: unknown, operation: string): string {
  if (error instanceof BotSecurityError) {
    return redactSensitiveText(error.message);
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const suffix = code ? ` (${code})` : error.name && error.name !== 'Error' ? ` (${error.name})` : '';
    return `${operation} failed${suffix}`;
  }

  return `${operation} failed`;
}
