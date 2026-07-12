import fetch, { RequestInit, Response } from 'node-fetch';
import { BotSettings, TabConfig, TabListEntry, TunnelMode, Platform, BotCommand } from '../types';
import {
  VK_API_VERSION,
  VK_API_BASE_URL,
  BOT_POLL_RETRY_DELAY_MS,
  BOT_POLL_WAIT_SECONDS,
} from '../constants';
import {
  createMainKeyboard,
  createListKeyboard,
  createWaitingKeyboard,
  findTabByShortId,
  generateShortId,
  padShortId,
} from './keyboard';
import {
  BotSecurityError,
  safeErrorMessage,
  validateBotSettings,
  ValidatedBotSettings,
} from './security';

type CreateTabFn = (config: TabConfig) => Promise<void> | void;
type GetTabsFn = () => TabListEntry[];
type CloseTabFn = (tabId: string) => void;
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type SleepFn = (milliseconds: number) => Promise<void>;

interface VkApiError {
  error_code: number;
}

interface VkApiResponse {
  response?: unknown;
  error?: VkApiError;
}

interface LongPollData {
  ts?: string;
  failed?: number;
  updates?: unknown[];
}

interface LongPollServerData {
  server?: string;
  key?: string;
  ts?: string;
}

interface VkMessage {
  text?: string;
  from_id: number;
  peer_id: number;
  payload?: string;
}

interface ButtonPayload {
  cmd: BotCommand;
  mode?: string;
  id?: string;
}

export interface BotManagerOptions {
  fetch?: FetchFn;
  sleep?: SleepFn;
  random?: () => number;
  apiTimeoutMs?: number;
  pollTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_TIMEOUT_MS = (BOT_POLL_WAIT_SECONDS + 5) * 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;

export function calculateBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  randomValue: number,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBaseMs = Math.max(1, Math.floor(baseMs));
  const safeMaxMs = Math.max(safeBaseMs, Math.floor(maxMs));
  const exponential = Math.min(safeMaxMs, safeBaseMs * 2 ** (safeAttempt - 1));
  const boundedRandom = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0;
  const jitter = Math.floor(exponential * 0.25 * boundedRandom);
  return Math.min(safeMaxMs, exponential + jitter);
}

export class BotManager {
  private readonly settings: ValidatedBotSettings;
  private readonly onCreateTab: CreateTabFn;
  private readonly onGetTabs: GetTabsFn;
  private readonly onCloseTab: CloseTabFn;
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: SleepFn;
  private readonly randomFn: () => number;
  private readonly apiTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly activeRequests = new Set<AbortController>();

  private ts: string | null = null;
  private key: string | null = null;
  private server: string | null = null;
  private running = false;
  private runGeneration = 0;
  private pollTask: Promise<void> | null = null;
  private awaitingJoinLink = new Set<number>();

  onError: ((msg: string) => void) | null = null;

  constructor(
    settings: BotSettings,
    onCreateTab: CreateTabFn,
    onGetTabs: GetTabsFn,
    onCloseTab: CloseTabFn,
    options: BotManagerOptions = {},
  ) {
    this.settings = validateBotSettings(settings);
    this.onCreateTab = onCreateTab;
    this.onGetTabs = onGetTabs;
    this.onCloseTab = onCloseTab;
    this.fetchFn = options.fetch || fetch;
    this.sleepFn = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.randomFn = options.random || Math.random;
    this.apiTimeoutMs = options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.retryBaseMs = options.retryBaseMs ?? BOT_POLL_RETRY_DELAY_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  private isRunActive(generation: number): boolean {
    return this.running && generation === this.runGeneration;
  }

  private async fetchJson(
    operation: string,
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    this.activeRequests.add(controller);

    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new BotSecurityError('HTTP_ERROR', `${operation} returned HTTP ${response.status}`);
      }
      try {
        return await response.json();
      } catch (error) {
        if (timedOut || controller.signal.aborted) throw error;
        throw new BotSecurityError('INVALID_RESPONSE', `${operation} returned invalid JSON`);
      }
    } catch (error) {
      if (error instanceof BotSecurityError) throw error;
      if (timedOut) {
        throw new BotSecurityError('TIMEOUT', `${operation} timed out`);
      }
      if (controller.signal.aborted) {
        throw new BotSecurityError('CANCELLED', `${operation} cancelled`);
      }
      throw new BotSecurityError('NETWORK_ERROR', safeErrorMessage(error, operation));
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(controller);
    }
  }

  private async api(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const body = new URLSearchParams();
    body.set('v', VK_API_VERSION);
    body.set('access_token', this.settings.token);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }

    const operation = `VK API ${method}`;
    const data = (await this.fetchJson(
      operation,
      `${VK_API_BASE_URL}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
      this.apiTimeoutMs,
    )) as VkApiResponse;

    if (!data || typeof data !== 'object') {
      throw new BotSecurityError('INVALID_RESPONSE', `${operation} returned an invalid response`);
    }
    if (data.error) {
      const code = Number.isFinite(data.error.error_code) ? data.error.error_code : 'unknown';
      throw new BotSecurityError('VK_API_ERROR', `${operation} failed (code ${code})`);
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'response')) {
      throw new BotSecurityError('INVALID_RESPONSE', `${operation} response is missing`);
    }
    return data.response;
  }

  private async getLongPollServer(): Promise<void> {
    const data = (await this.api('groups.getLongPollServer', {
      group_id: this.settings.groupId,
    })) as LongPollServerData;

    if (
      !data ||
      typeof data.server !== 'string' ||
      typeof data.key !== 'string' ||
      typeof data.ts !== 'string' ||
      !data.key ||
      !data.ts
    ) {
      throw new BotSecurityError('INVALID_RESPONSE', 'VK Long Poll configuration is invalid');
    }

    let serverUrl: URL;
    try {
      serverUrl = new URL(data.server);
    } catch (_) {
      throw new BotSecurityError('INVALID_RESPONSE', 'VK Long Poll server URL is invalid');
    }
    if (serverUrl.protocol !== 'https:' || serverUrl.username || serverUrl.password) {
      throw new BotSecurityError('INVALID_RESPONSE', 'VK Long Poll server must use HTTPS without URL credentials');
    }

    this.server = serverUrl.toString();
    this.key = data.key;
    this.ts = data.ts;
  }

  async start(): Promise<boolean> {
    if (this.running) return true;

    const generation = ++this.runGeneration;
    this.running = true;
    console.log('[BOT] Starting');

    try {
      await this.getLongPollServer();
      if (!this.isRunActive(generation)) return false;
      console.log('[BOT] Long Poll ready');
      this.pollTask = this.pollLoop(generation);
      void this.pollTask;
      return true;
    } catch (error) {
      if (!this.isRunActive(generation)) return false;
      this.running = false;
      const message = safeErrorMessage(error, 'VK bot startup');
      console.error('[BOT]', message);
      this.onError?.(message);
      return false;
    }
  }

  stop(): void {
    this.running = false;
    this.runGeneration += 1;
    this.awaitingJoinLink.clear();
    this.server = null;
    this.key = null;
    this.ts = null;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    this.pollTask = null;
    console.log('[BOT] Stopped');
  }

  private async pollOnce(): Promise<LongPollData> {
    if (!this.server || !this.key || !this.ts) {
      throw new BotSecurityError('INVALID_STATE', 'VK Long Poll is not initialized');
    }

    const url = new URL(this.server);
    url.searchParams.set('act', 'a_check');
    url.searchParams.set('key', this.key);
    url.searchParams.set('ts', this.ts);
    url.searchParams.set('wait', String(BOT_POLL_WAIT_SECONDS));

    const data = (await this.fetchJson('VK Long Poll', url.toString(), { method: 'GET' }, this.pollTimeoutMs)) as LongPollData;
    if (!data || typeof data !== 'object') {
      throw new BotSecurityError('INVALID_RESPONSE', 'VK Long Poll returned an invalid response');
    }
    return data;
  }

  private async pollLoop(generation: number): Promise<void> {
    let consecutiveFailures = 0;

    while (this.isRunActive(generation)) {
      try {
        const data = await this.pollOnce();
        if (!this.isRunActive(generation)) return;
        consecutiveFailures = 0;

        if (data.failed) {
          if (data.failed === 1 && typeof data.ts === 'string') {
            this.ts = data.ts;
          } else {
            await this.getLongPollServer();
          }
          continue;
        }

        if (typeof data.ts === 'string') this.ts = data.ts;
        for (const update of Array.isArray(data.updates) ? data.updates : []) {
          if (!this.isRunActive(generation)) return;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.isRunActive(generation)) return;
        if (error instanceof BotSecurityError && error.code === 'CANCELLED') return;

        consecutiveFailures += 1;
        const message = safeErrorMessage(error, 'VK Long Poll');
        console.error('[BOT]', message);
        const delay = calculateBackoffMs(
          consecutiveFailures,
          this.retryBaseMs,
          this.retryMaxMs,
          this.randomFn(),
        );
        try {
          await this.sleepFn(delay);
        } catch (_) {
          return;
        }
      }
    }
  }

  private async handleUpdate(update: unknown): Promise<void> {
    if (!update || typeof update !== 'object') return;
    const candidate = update as { type?: string; object?: { message?: VkMessage } };
    if (candidate.type !== 'message_new' || !candidate.object?.message) return;

    const message = candidate.object.message;
    if (!Number.isSafeInteger(message.from_id) || !Number.isSafeInteger(message.peer_id)) return;

    const fromId = message.from_id;
    const peerId = message.peer_id;
    if (!this.settings.allowedUserIds.has(fromId)) return;
    if (peerId !== fromId) {
      console.warn('[BOT] Ignored authorized message outside a private dialog');
      return;
    }

    let text = (message.text || '').trim();
    let payload: ButtonPayload | null = null;
    if (message.payload) {
      try {
        const parsed = JSON.parse(message.payload) as ButtonPayload;
        if (parsed && typeof parsed.cmd === 'string') payload = parsed;
      } catch (_) {}
    }

    console.log('[BOT] Authorized private message received');

    if (text === '/start' || text === 'start') {
      await this.showMenu(peerId);
      return;
    }

    if (payload?.cmd) {
      const handled = await this.handlePayloadCommand(payload, peerId);
      if (handled) return;
      let cmdPrefix: string | null = null;
      if (payload.cmd === BotCommand.VK) cmdPrefix = '/vk';
      else if (payload.cmd === BotCommand.TM) cmdPrefix = '/tm';
      else if (payload.cmd === BotCommand.WB) cmdPrefix = '/wb';
      else if (payload.cmd === BotCommand.Dion) cmdPrefix = '/dion';
      if (cmdPrefix && payload.mode) text = `${cmdPrefix} ${payload.mode}`;
    }

    const wasAwaiting = this.awaitingJoinLink.has(peerId);
    const joinLink = this.detectJoinLink(text);
    if (joinLink) {
      this.awaitingJoinLink.delete(peerId);
      console.log('[BOT] Join link detected for', joinLink.platform);
      await this.onCreateTab({
        mode: this.headlessModeFor(joinLink.platform),
        peerId,
        platform: joinLink.platform,
        joinTarget: joinLink.target,
      });
      await this.sendMessage(peerId, `Joining ${this.platformLabel(joinLink.platform)} call`, createMainKeyboard());
      return;
    }

    if (wasAwaiting) {
      await this.sendMessage(
        peerId,
        "Couldn't detect a VK / Telemost / WBStream / DION link in that message. Paste a join link or press Back.",
        createWaitingKeyboard(),
      );
      return;
    }

    await this.handleTextCommand(text, peerId);
  }

  private detectJoinLink(text: string): { platform: Platform; target: string } | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('wbstream://') || lower.includes('stream.wb.ru')) {
      return { platform: Platform.WBStream, target: trimmed };
    }
    if (lower.includes('telemost.yandex')) {
      return { platform: Platform.Telemost, target: trimmed };
    }
    if (lower.startsWith('dion://') || lower.includes('dion.vc')) {
      return { platform: Platform.Dion, target: trimmed };
    }
    if (lower.includes('vk.com/call/join')) {
      return { platform: Platform.VK, target: trimmed };
    }
    return null;
  }

  private headlessModeFor(platform: Platform): TunnelMode {
    switch (platform) {
      case Platform.Telemost: return TunnelMode.HeadlessTelemost;
      case Platform.WBStream: return TunnelMode.HeadlessWBStream;
      case Platform.Dion: return TunnelMode.HeadlessDion;
      default: return TunnelMode.HeadlessVK;
    }
  }

  private platformLabel(platform: Platform): string {
    switch (platform) {
      case Platform.Telemost: return 'Telemost';
      case Platform.WBStream: return 'WB Stream';
      case Platform.Dion: return 'DION';
      default: return 'VK';
    }
  }

  private async handlePayloadCommand(payload: ButtonPayload, peerId: number): Promise<boolean> {
    if (payload.cmd === BotCommand.Noop) return true;
    if (payload.cmd === BotCommand.JoinPrompt) {
      this.awaitingJoinLink.add(peerId);
      await this.sendMessage(peerId, 'Paste a join link', createWaitingKeyboard());
      return true;
    }
    this.awaitingJoinLink.delete(peerId);
    if (payload.cmd === BotCommand.List) {
      await this.showList(peerId);
      return true;
    }
    if (payload.cmd === BotCommand.Menu) {
      await this.showMenu(peerId);
      return true;
    }
    if (payload.cmd === BotCommand.Close && payload.id) {
      const tabsList = this.onGetTabs();
      const tab = tabsList.find((entry) => entry.id === payload.id);
      if (tab) {
        const shortId = padShortId(generateShortId(tab.id));
        this.onCloseTab(tab.id);
        await this.sendMessage(peerId, `${tab.platform} ${tab.mode} ${shortId} closed`, createMainKeyboard());
      }
      return true;
    }
    return false;
  }

  private parseTunnelMode(text: string, platform: Platform): TunnelMode {
    if (platform === Platform.WBStream) return TunnelMode.HeadlessWBStream;
    if (platform === Platform.Dion) return TunnelMode.HeadlessDion;
    if (text.includes('headless')) {
      return platform === Platform.VK ? TunnelMode.HeadlessVK : TunnelMode.HeadlessTelemost;
    }
    if (text.includes('video')) return TunnelMode.PionVideo;
    return TunnelMode.DC;
  }

  private tunnelModeLabel(mode: TunnelMode): string {
    switch (mode) {
      case TunnelMode.HeadlessVK:
      case TunnelMode.HeadlessTelemost:
      case TunnelMode.HeadlessWBStream:
      case TunnelMode.HeadlessDion:
        return 'Headless';
      case TunnelMode.PionVideo:
        return 'Video';
      default:
        return 'DC';
    }
  }

  private async handleTextCommand(text: string, peerId: number): Promise<void> {
    if (text.startsWith('/vk')) {
      const mode = this.parseTunnelMode(text, Platform.VK);
      console.log('[BOT] Creating VK tab with mode:', mode);
      await this.onCreateTab({ mode, peerId, platform: Platform.VK });
      await this.sendMessage(peerId, `Creating VK call (${this.tunnelModeLabel(mode)})`, createMainKeyboard());
    } else if (text.startsWith('/tm')) {
      const mode = this.parseTunnelMode(text, Platform.Telemost);
      console.log('[BOT] Creating Telemost tab with mode:', mode);
      await this.onCreateTab({ mode, peerId, platform: Platform.Telemost });
      await this.sendMessage(peerId, `Creating Telemost call (${this.tunnelModeLabel(mode)})`, createMainKeyboard());
    } else if (text.startsWith('/wb')) {
      const mode = this.parseTunnelMode(text, Platform.WBStream);
      console.log('[BOT] Creating WB Stream tab with mode:', mode);
      await this.onCreateTab({ mode, peerId, platform: Platform.WBStream });
      await this.sendMessage(peerId, `Creating WB Stream room (${this.tunnelModeLabel(mode)})`, createMainKeyboard());
    } else if (text.startsWith('/dion')) {
      const mode = this.parseTunnelMode(text, Platform.Dion);
      console.log('[BOT] Creating DION tab with mode:', mode);
      await this.onCreateTab({ mode, peerId, platform: Platform.Dion });
      await this.sendMessage(peerId, `Creating DION room (${this.tunnelModeLabel(mode)})`, createMainKeyboard());
    } else if (text === '/list') {
      await this.showList(peerId);
    } else if (text.startsWith('/close ')) {
      const targetShortId = text.split(' ')[1];
      console.log('[BOT] Close request received');
      const tabsList = this.onGetTabs();
      const tab = findTabByShortId(tabsList, targetShortId);
      if (!tab) {
        await this.sendMessage(peerId, `Tab ${targetShortId} not found`, createMainKeyboard());
      } else {
        this.onCloseTab(tab.id);
        await this.sendMessage(peerId, `${tab.platform} ${tab.mode} ${targetShortId} closed`, createMainKeyboard());
      }
    }
  }

  async sendMessage(peerId: number, text: string, keyboard?: unknown): Promise<void> {
    const params: Record<string, unknown> = {
      peer_id: peerId,
      message: text,
      random_id: Math.floor(this.randomFn() * 1_000_000_000),
    };
    if (keyboard) params.keyboard = JSON.stringify(keyboard);
    await this.api('messages.send', params);
    console.log('[BOT] Message sent');
  }

  private async showMenu(peerId: number): Promise<void> {
    await this.sendMessage(peerId, 'Select mode:', createMainKeyboard());
  }

  private async showList(peerId: number): Promise<void> {
    const tabsList = this.onGetTabs();
    if (tabsList.length === 0) {
      await this.sendMessage(peerId, 'No active tabs', createMainKeyboard());
    } else {
      await this.sendMessage(peerId, 'Select tab to close:', createListKeyboard(tabsList));
    }
  }
}
