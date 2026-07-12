import {
  BotSettings,
  HeadlessMode,
  HeadlessStartArgs,
  Platform,
  TunnelMode,
  UpstreamProxy,
} from '../types';

export const MAX_REMOTE_URL_LENGTH = 4096;
export const MAX_TAB_ID_LENGTH = 128;
export const MAX_PROXY_ENDPOINT_LENGTH = 2048;
export const MAX_CREDENTIAL_LENGTH = 1024;
export const MAX_SENSITIVE_RESULT_LENGTH = 4096;

export const REMOTE_WEBVIEW_PREFERENCES = [
  'contextIsolation=yes',
  'sandbox=yes',
  'nodeIntegration=no',
  'nodeIntegrationInSubFrames=no',
  'nodeIntegrationInWorker=no',
  'webSecurity=yes',
  'allowRunningInsecureContent=no',
].join(',');

const REMOTE_HOST_ROOTS = [
  'vk.com',
  'vk.ru',
  'yandex.ru',
  'yandex.com',
  'yandex.net',
  'ya.ru',
  'dion.vc',
  'stream.wb.ru',
  'wb.ru',
  'wildberries.ru',
] as const;

const LEGACY_HOOK_HOST_ROOTS = ['vk.com', 'vk.ru'] as const;
const LEGACY_HOOK_EXACT_HOSTS = new Set(['telemost.yandex.ru']);
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen']);
const ALLOWED_SCRIPT_FILES = new Set([
  'call-checker.js',
  'vk-call-creator.js',
  'tm-call-creator.js',
]);
const TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class TrustPolicyError extends Error {
  readonly code = 'TRUST_POLICY_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'TrustPolicyError';
  }
}

export interface GuestWebPreferencesLike {
  preload?: string;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  nodeIntegrationInWorker?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  webviewTag?: boolean;
  navigateOnDragDrop?: boolean;
  safeDialogs?: boolean;
  spellcheck?: boolean;
}

export interface IpcSenderSnapshot {
  senderId: number;
  expectedSenderId: number;
  frameUrl: string;
  expectedFrameUrl: string;
  isMainFrame: boolean;
}

function hostMatchesRoot(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function parseHttpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REMOTE_URL_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isAllowedRemoteUrl(raw: unknown): boolean {
  const parsed = parseHttpsUrl(raw);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return REMOTE_HOST_ROOTS.some((root) => hostMatchesRoot(hostname, root));
}

export function isAllowedPopupUrl(raw: unknown): boolean {
  return raw === 'about:blank' || isAllowedRemoteUrl(raw);
}

export function isLegacyHookUrl(raw: unknown): boolean {
  const parsed = parseHttpsUrl(raw);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return (
    LEGACY_HOOK_EXACT_HOSTS.has(hostname) ||
    LEGACY_HOOK_HOST_ROOTS.some((root) => hostMatchesRoot(hostname, root))
  );
}

function normalizeTrustedFileLocation(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_REMOTE_URL_LENGTH) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'file:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.hostname && parsed.hostname !== 'localhost') return null;
    let pathname = decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.toLowerCase();
    return `${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

export function isTrustedAppUrl(raw: unknown, expectedRaw: unknown): boolean {
  const actual = normalizeTrustedFileLocation(raw);
  const expected = normalizeTrustedFileLocation(expectedRaw);
  return actual !== null && expected !== null && actual === expected;
}

export function isAllowedPermission(permission: string, requestingUrl: unknown): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAllowedRemoteUrl(requestingUrl);
}

export function hardenGuestWebPreferences(preferences: GuestWebPreferencesLike): void {
  delete preferences.preload;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.nodeIntegrationInWorker = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;
  preferences.webviewTag = false;
  preferences.navigateOnDragDrop = false;
  preferences.safeDialogs = true;
  preferences.spellcheck = false;
}

export function isTrustedIpcSenderSnapshot(snapshot: IpcSenderSnapshot): boolean {
  return (
    snapshot.senderId === snapshot.expectedSenderId &&
    snapshot.isMainFrame &&
    isTrustedAppUrl(snapshot.frameUrl, snapshot.expectedFrameUrl)
  );
}

function assertString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') {
    throw new TrustPolicyError(`${label} must be a string`);
  }
  if (value.length > maxLength) {
    throw new TrustPolicyError(`${label} is too long`);
  }
  if (/[\x00\r\n]/.test(value)) {
    throw new TrustPolicyError(`${label} contains control characters`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw new TrustPolicyError(`${label} is required`);
  }
  return trimmed;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrustPolicyError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertArgumentCount(actual: number, allowed: readonly number[]): void {
  if (!allowed.includes(actual)) {
    throw new TrustPolicyError('Unexpected IPC argument count');
  }
}

export function assertTabId(value: unknown): string {
  const tabId = assertString(value, 'Tab ID', MAX_TAB_ID_LENGTH);
  if (!TAB_ID_PATTERN.test(tabId)) {
    throw new TrustPolicyError('Tab ID contains unsupported characters');
  }
  return tabId;
}

export function assertPlatform(value: unknown): Platform {
  if (!Object.values(Platform).includes(value as Platform)) {
    throw new TrustPolicyError('Unsupported platform');
  }
  return value as Platform;
}

export function assertOptionalPlatform(value: unknown): Platform | undefined {
  if (value === undefined) return undefined;
  return assertPlatform(value);
}

export function assertTunnelMode(value: unknown): TunnelMode {
  if (!Object.values(TunnelMode).includes(value as TunnelMode)) {
    throw new TrustPolicyError('Unsupported tunnel mode');
  }
  return value as TunnelMode;
}

export function assertRemoteUrl(value: unknown): string {
  const url = assertString(value, 'Remote URL', MAX_REMOTE_URL_LENGTH);
  if (!isAllowedRemoteUrl(url)) {
    throw new TrustPolicyError('Remote URL is outside the platform allowlist');
  }
  return url;
}

export function assertScriptFile(value: unknown): string {
  const scriptFile = assertString(value, 'Script file', 128);
  if (!ALLOWED_SCRIPT_FILES.has(scriptFile)) {
    throw new TrustPolicyError('Script file is not allowlisted');
  }
  return scriptFile;
}

export function assertHeadlessStartArgs(value: unknown): HeadlessStartArgs {
  const record = assertRecord(value, 'Headless start arguments');
  if (!Object.values(HeadlessMode).includes(record.mode as HeadlessMode)) {
    throw new TrustPolicyError('Unsupported headless start mode');
  }
  const mode = record.mode as HeadlessMode;
  if (mode === HeadlessMode.Join) {
    return {
      mode,
      target: assertString(record.target, 'Join target', MAX_SENSITIVE_RESULT_LENGTH),
    };
  }
  if (record.target !== undefined && record.target !== '') {
    throw new TrustPolicyError('Create mode does not accept a join target');
  }
  return { mode };
}

export function assertBotSettingsShape(value: unknown): BotSettings {
  const record = assertRecord(value, 'VK bot settings');
  return {
    token: assertString(record.token, 'VK community token', MAX_SENSITIVE_RESULT_LENGTH),
    groupId: assertString(record.groupId, 'VK group ID', 32),
    userId: assertString(record.userId, 'VK user allowlist', 4096),
  };
}

export function assertUpstreamProxy(value: unknown): UpstreamProxy {
  const record = assertRecord(value, 'Upstream proxy');
  return {
    socks: assertString(record.socks, 'SOCKS endpoint', MAX_PROXY_ENDPOINT_LENGTH, true),
    user: assertString(record.user, 'Proxy username', MAX_CREDENTIAL_LENGTH, true),
    pass: assertString(record.pass, 'Proxy password', MAX_CREDENTIAL_LENGTH, true),
  };
}

export function assertSensitiveResult(value: unknown): string {
  return assertString(value, 'Sensitive result', MAX_SENSITIVE_RESULT_LENGTH);
}
