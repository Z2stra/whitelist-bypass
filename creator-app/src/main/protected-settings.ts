import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { isIP } from 'net';
import {
  BotSettings,
  LegacyPlaintextSettings,
  ProtectedSettingsUpdate,
  ProtectedSettingsView,
  SecretValueUpdate,
  UpstreamProxy,
} from '../types';

const PROTECTED_SETTINGS_VERSION = 1;
const MAX_TOKEN_LENGTH = 4096;
const MAX_GROUP_ID_LENGTH = 32;
const MAX_USER_ALLOWLIST_LENGTH = 4096;
const MAX_PROXY_ENDPOINT_LENGTH = 2048;
const MAX_PROXY_CREDENTIAL_LENGTH = 1024;

interface ProtectedSettingsData {
  version: 1;
  bot: BotSettings;
  proxy: UpstreamProxy;
}

interface ProtectedSettingsEnvelope {
  version: 1;
  ciphertext: string;
}

export interface ProtectedSettingsCipherStatus {
  available: boolean;
  backend: string;
  reason?: string;
}

export interface ProtectedSettingsCipher {
  status(): ProtectedSettingsCipherStatus;
  encrypt(plainText: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export class ProtectedSettingsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtectedSettingsError';
    this.code = code;
  }
}

function emptyData(): ProtectedSettingsData {
  return {
    version: PROTECTED_SETTINGS_VERSION,
    bot: { token: '', groupId: '', userId: '' },
    proxy: { socks: '', user: '', pass: '' },
  };
}

function cloneData(data: ProtectedSettingsData): ProtectedSettingsData {
  return {
    version: PROTECTED_SETTINGS_VERSION,
    bot: { ...data.bot },
    proxy: { ...data.proxy },
  };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} must be a string`);
  }
  if (value.length > maxLength) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} is too long`);
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} contains control characters`);
  }
  const normalized = options.trim === false ? value : value.trim();
  if (!options.allowEmpty && normalized.length === 0) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} is required`);
  }
  return normalized;
}


function normalizeSocksEndpoint(value: unknown, label: string): string {
  const endpoint = normalizeString(value, label, MAX_PROXY_ENDPOINT_LENGTH, { allowEmpty: true });
  if (!endpoint) return '';

  let host: string;
  let portText: string;
  if (endpoint.startsWith('[')) {
    const match = endpoint.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match || isIP(match[1]) !== 6) {
      throw new ProtectedSettingsError('INVALID_INPUT', `${label} must be host:port`);
    }
    host = `[${match[1]}]`;
    portText = match[2];
  } else {
    const separator = endpoint.lastIndexOf(':');
    if (separator <= 0 || endpoint.indexOf(':') !== separator) {
      throw new ProtectedSettingsError('INVALID_INPUT', `${label} must be host:port`);
    }
    host = endpoint.slice(0, separator);
    portText = endpoint.slice(separator + 1);
    const isIpv4 = isIP(host) === 4;
    const hostnameValid =
      host.length <= 253 &&
      host.split('.').every((labelPart) =>
        /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(labelPart),
      );
    if (!isIpv4 && !hostnameValid) {
      throw new ProtectedSettingsError('INVALID_INPUT', `${label} contains an invalid host`);
    }
    host = isIpv4 ? host : host.toLowerCase();
  }

  if (!/^\d{1,5}$/.test(portText)) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} contains an invalid port`);
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} contains an invalid port`);
  }
  return `${host}:${port}`;
}

function normalizeOptionalString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { trim?: boolean } = {},
): string {
  if (value === undefined || value === null) return '';
  return normalizeString(value, label, maxLength, { allowEmpty: true, trim: options.trim });
}

function normalizeSecretUpdate(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmptyReplacement: boolean,
): SecretValueUpdate {
  const record = assertRecord(value, `${label} update`);
  const action = record.action;
  if (action === 'keep' || action === 'clear') return { action };
  if (action !== 'replace') {
    throw new ProtectedSettingsError('INVALID_INPUT', `${label} update action is invalid`);
  }
  return {
    action,
    value: normalizeString(record.value, label, maxLength, {
      allowEmpty: allowEmptyReplacement,
      trim: label === 'VK community token',
    }),
  };
}

function applySecretUpdate(current: string, update: SecretValueUpdate): string {
  if (update.action === 'keep') return current;
  if (update.action === 'clear') return '';
  return update.value;
}

function normalizeUpdate(value: unknown): ProtectedSettingsUpdate {
  const record = assertRecord(value, 'Protected settings update');
  const bot = assertRecord(record.bot, 'Bot settings update');
  const proxy = assertRecord(record.proxy, 'Proxy settings update');
  return {
    bot: {
      groupId: normalizeString(bot.groupId, 'VK group ID', MAX_GROUP_ID_LENGTH, { allowEmpty: true }),
      userId: normalizeString(bot.userId, 'VK user allowlist', MAX_USER_ALLOWLIST_LENGTH, { allowEmpty: true }),
      token: normalizeSecretUpdate(bot.token, 'VK community token', MAX_TOKEN_LENGTH, false),
    },
    proxy: {
      socks: normalizeSocksEndpoint(proxy.socks, 'SOCKS endpoint'),
      username: normalizeSecretUpdate(proxy.username, 'Proxy username', MAX_PROXY_CREDENTIAL_LENGTH, true),
      password: normalizeSecretUpdate(proxy.password, 'Proxy password', MAX_PROXY_CREDENTIAL_LENGTH, true),
    },
  };
}

export function validateProtectedSettingsUpdate(value: unknown): ProtectedSettingsUpdate {
  return normalizeUpdate(value);
}

function normalizeLegacy(value: unknown): LegacyPlaintextSettings {
  const record = assertRecord(value, 'Legacy settings migration');
  const hadLegacy = record.hadLegacy === true;
  let botSettings: BotSettings | undefined;
  let upstreamProxy: UpstreamProxy | undefined;

  if (record.botSettings && typeof record.botSettings === 'object' && !Array.isArray(record.botSettings)) {
    const bot = record.botSettings as Record<string, unknown>;
    botSettings = {
      token: normalizeOptionalString(bot.token, 'Legacy VK community token', MAX_TOKEN_LENGTH),
      groupId: normalizeOptionalString(bot.groupId, 'Legacy VK group ID', MAX_GROUP_ID_LENGTH),
      userId: normalizeOptionalString(bot.userId, 'Legacy VK user allowlist', MAX_USER_ALLOWLIST_LENGTH),
    };
  }

  if (record.upstreamProxy && typeof record.upstreamProxy === 'object' && !Array.isArray(record.upstreamProxy)) {
    const proxy = record.upstreamProxy as Record<string, unknown>;
    upstreamProxy = {
      socks: normalizeSocksEndpoint(proxy.socks ?? '', 'Legacy SOCKS endpoint'),
      user: normalizeOptionalString(proxy.user, 'Legacy proxy username', MAX_PROXY_CREDENTIAL_LENGTH, { trim: false }),
      pass: normalizeOptionalString(proxy.pass, 'Legacy proxy password', MAX_PROXY_CREDENTIAL_LENGTH, { trim: false }),
    };
  }

  return { hadLegacy, botSettings, upstreamProxy };
}

function parsePlaintext(value: string): ProtectedSettingsData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProtectedSettingsError('CORRUPT_STORE', 'Protected settings payload is invalid');
  }
  const record = assertRecord(parsed, 'Protected settings payload');
  if (record.version !== PROTECTED_SETTINGS_VERSION) {
    throw new ProtectedSettingsError('UNSUPPORTED_STORE_VERSION', 'Protected settings version is unsupported');
  }
  const bot = assertRecord(record.bot, 'Protected bot settings');
  const proxy = assertRecord(record.proxy, 'Protected proxy settings');
  return {
    version: PROTECTED_SETTINGS_VERSION,
    bot: {
      token: normalizeString(bot.token, 'VK community token', MAX_TOKEN_LENGTH, { allowEmpty: true }),
      groupId: normalizeString(bot.groupId, 'VK group ID', MAX_GROUP_ID_LENGTH, { allowEmpty: true }),
      userId: normalizeString(bot.userId, 'VK user allowlist', MAX_USER_ALLOWLIST_LENGTH, { allowEmpty: true }),
    },
    proxy: {
      socks: normalizeSocksEndpoint(proxy.socks, 'SOCKS endpoint'),
      user: normalizeString(proxy.user, 'Proxy username', MAX_PROXY_CREDENTIAL_LENGTH, { allowEmpty: true, trim: false }),
      pass: normalizeString(proxy.pass, 'Proxy password', MAX_PROXY_CREDENTIAL_LENGTH, { allowEmpty: true, trim: false }),
    },
  };
}

function parseEnvelope(value: string): ProtectedSettingsEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProtectedSettingsError('CORRUPT_STORE', 'Protected settings envelope is invalid');
  }
  const record = assertRecord(parsed, 'Protected settings envelope');
  if (record.version !== PROTECTED_SETTINGS_VERSION) {
    const code = typeof record.version === 'number'
      ? 'UNSUPPORTED_STORE_VERSION'
      : 'CORRUPT_STORE';
    throw new ProtectedSettingsError(
      code,
      code === 'UNSUPPORTED_STORE_VERSION'
        ? 'Protected settings were created by a newer Creator version'
        : 'Protected settings envelope is invalid',
    );
  }
  if (typeof record.ciphertext !== 'string') {
    throw new ProtectedSettingsError('CORRUPT_STORE', 'Protected settings envelope is invalid');
  }
  if (
    record.ciphertext.length === 0 ||
    record.ciphertext.length > 256 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext)
  ) {
    throw new ProtectedSettingsError('CORRUPT_STORE', 'Protected settings ciphertext is invalid');
  }
  return { version: PROTECTED_SETTINGS_VERSION, ciphertext: record.ciphertext };
}

export class ProtectedSettingsStore {
  private data = emptyData();
  private cipherStatus: ProtectedSettingsCipherStatus = {
    available: false,
    backend: 'unknown',
    reason: 'Protected settings are not initialized',
  };
  private warning: string | undefined;
  private blockingError: ProtectedSettingsError | undefined;
  private initialized = false;
  private filePresent = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly cipher: ProtectedSettingsCipher,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.cipherStatus = this.cipher.status();
    } catch {
      this.cipherStatus = {
        available: false,
        backend: 'unknown',
        reason: 'OS-protected encryption could not be initialized',
      };
    }

    this.initialized = true;
    if (!this.cipherStatus.available) return;

    let envelopeText: string;
    try {
      envelopeText = await fs.readFile(this.filePath, 'utf8');
      this.filePresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new ProtectedSettingsError('STORE_READ_FAILED', 'Protected settings could not be read');
    }

    try {
      const envelope = parseEnvelope(envelopeText);
      const encrypted = Buffer.from(envelope.ciphertext, 'base64');
      const plaintext = this.cipher.decrypt(encrypted);
      this.data = parsePlaintext(plaintext);
    } catch (error) {
      if (error instanceof ProtectedSettingsError && error.code === 'UNSUPPORTED_STORE_VERSION') {
        this.blockingError = error;
        this.warning =
          'Protected settings were created by a newer Creator version. Update Creator before changing credentials.';
        return;
      }
      const quarantined = await this.quarantineCorruptStore();
      this.data = emptyData();
      this.filePresent = !quarantined;
      this.warning = quarantined
        ? 'Protected settings could not be decrypted and were moved aside; re-enter credentials.'
        : 'Protected settings could not be decrypted; the original file could not be moved aside.';
    }
  }

  getView(): ProtectedSettingsView {
    this.assertInitialized();
    return {
      protection: {
        available: this.cipherStatus.available && !this.blockingError,
        backend: this.cipherStatus.backend,
        warning: this.warning || this.cipherStatus.reason,
      },
      bot: {
        groupId: this.data.bot.groupId,
        userId: this.data.bot.userId,
        tokenConfigured: this.data.bot.token.length > 0,
      },
      proxy: {
        socks: this.data.proxy.socks,
        usernameConfigured: this.data.proxy.user.length > 0,
        passwordConfigured: this.data.proxy.pass.length > 0,
      },
    };
  }

  getBotSettings(): BotSettings {
    this.assertAvailable();
    return { ...this.data.bot };
  }

  getUpstreamProxy(): UpstreamProxy {
    this.assertAvailable();
    return { ...this.data.proxy };
  }

  ensureWritable(): void {
    this.assertAvailable();
  }

  async applyUpdate(value: unknown): Promise<ProtectedSettingsView> {
    this.assertAvailable();
    const update = normalizeUpdate(value);
    return this.runWrite(async () => {
      const next = cloneData(this.data);
      next.bot.groupId = update.bot.groupId;
      next.bot.userId = update.bot.userId;
      next.bot.token = applySecretUpdate(next.bot.token, update.bot.token);
      next.proxy.socks = update.proxy.socks;
      next.proxy.user = applySecretUpdate(next.proxy.user, update.proxy.username);
      next.proxy.pass = applySecretUpdate(next.proxy.pass, update.proxy.password);
      await this.persist(next);
      this.data = next;
      this.warning = undefined;
      return this.getView();
    });
  }

  async migrateLegacy(value: unknown): Promise<ProtectedSettingsView> {
    this.assertAvailable();
    const legacy = normalizeLegacy(value);
    return this.runWrite(async () => {
      const next = cloneData(this.data);
      let changed = false;

      const fill = (current: string, candidate: string | undefined): string => {
        if (current || !candidate) return current;
        changed = true;
        return candidate;
      };

      if (legacy.botSettings) {
        next.bot.token = fill(next.bot.token, legacy.botSettings.token);
        next.bot.groupId = fill(next.bot.groupId, legacy.botSettings.groupId);
        next.bot.userId = fill(next.bot.userId, legacy.botSettings.userId);
      }
      if (legacy.upstreamProxy) {
        next.proxy.socks = fill(next.proxy.socks, legacy.upstreamProxy.socks);
        next.proxy.user = fill(next.proxy.user, legacy.upstreamProxy.user);
        next.proxy.pass = fill(next.proxy.pass, legacy.upstreamProxy.pass);
      }

      if (changed || (legacy.hadLegacy && !this.filePresent)) {
        await this.persist(next);
        this.data = next;
        this.warning = undefined;
      }
      return this.getView();
    });
  }

  private runWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new ProtectedSettingsError('NOT_INITIALIZED', 'Protected settings are not initialized');
    }
  }

  private assertAvailable(): void {
    this.assertInitialized();
    if (!this.cipherStatus.available) {
      throw new ProtectedSettingsError(
        'ENCRYPTION_UNAVAILABLE',
        this.cipherStatus.reason || 'OS-protected encryption is unavailable',
      );
    }
    if (this.blockingError) {
      throw new ProtectedSettingsError(this.blockingError.code, this.blockingError.message);
    }
  }

  private async persist(data: ProtectedSettingsData): Promise<void> {
    const plaintext = JSON.stringify(data);
    let encrypted: Buffer;
    try {
      encrypted = this.cipher.encrypt(plaintext);
    } catch {
      throw new ProtectedSettingsError('ENCRYPTION_FAILED', 'Protected settings encryption failed');
    }

    const envelope: ProtectedSettingsEnvelope = {
      version: PROTECTED_SETTINGS_VERSION,
      ciphertext: encrypted.toString('base64'),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(envelope), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      // libuv implements replacement semantics for rename on supported platforms.
      // If replacement fails, preserve the previous protected file rather than unlinking it.
      await fs.rename(tempPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => {});
      this.filePresent = true;
    } catch {
      await fs.unlink(tempPath).catch(() => {});
      throw new ProtectedSettingsError('STORE_WRITE_FAILED', 'Protected settings could not be saved');
    }
  }

  private async quarantineCorruptStore(): Promise<boolean> {
    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.filePath, quarantinePath);
      return true;
    } catch {
      return false;
    }
  }
}
