import { app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow, session } from 'electron';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  TabState,
  PortPair,
  TabListEntry,
  Platform,
  TunnelMode,
  RelayMode,
  CallStatus,
  HeadlessStartArgs,
  HeadlessMode,
  UpstreamProxy,
  HeadlessProcessEvent,
} from '../types';
import {
  INITIAL_PORT_BASE,
  IPC,
  RELAY_RESTART_DELAY_MS,
  SESSION_PARTITION,
  VK_COOKIE_DOMAINS,
  YANDEX_COOKIE_DOMAINS,
  DION_COOKIE_DOMAINS,
  WBSTREAM_COOKIE_DOMAINS,
  VK_LOGIN_URL,
  YANDEX_LOGIN_URL,
  DION_LOGIN_URL,
  WBSTREAM_LOGIN_URL,
  VK_AUTH_COOKIE,
  YANDEX_AUTH_COOKIE,
  DION_AUTH_COOKIE,
  WBSTREAM_AUTH_COOKIE,
  LOG_CAPTURE_SNIPPET,
} from '../constants';
import { BotManager } from '../bot/bot-manager';
import { redactSensitiveText } from '../bot/security';
import { resolveResourcePath, binaryName } from './util/paths';
import { classifyHeadlessProcessLine, ProcessLineBuffer } from './headless-process-events';
import {
  createEphemeralCookieFile,
  EphemeralCookieFile,
} from './ephemeral-cookie-file';
import { cookieDomainMatchesRoots } from './cookie-domain-policy';
import { terminateChildProcess } from './process-termination';

interface ProcessOutputOptions {
  headless?: boolean;
  inspect?: (msg: string) => void;
}

interface PendingHeadlessStart {
  tabId: string;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export type SecretLifecycleRunner = <T>(
  operation: () => Promise<T> | T,
) => Promise<T>;

export class TabManager {
  private tabs = new Map<string, TabState>();
  private callStatusCache = new Map<string, CallStatus>();
  private botTabIds = new Set<string>();
  private nextPortBase = INITIAL_PORT_BASE;
  private _mainWindow: BrowserWindow | null = null;
  private _botManager: BotManager | null = null;
  private relayPath: string;
  private headlessVKPath: string;
  private headlessTelemostPath: string;
  private headlessWBStreamPath: string;
  private headlessDionPath: string;
  private hooksDir: string;
  private upstreamProxy: UpstreamProxy = { socks: '', user: '', pass: '' };
  private cookieLeases = new Map<ChildProcess, EphemeralCookieFile>();
  private activeProcesses = new Set<ChildProcess>();
  private secretGeneration = 0;
  private secretLifecycleRunner: SecretLifecycleRunner = (operation) =>
    Promise.resolve().then(operation);
  private pendingHeadlessStarts = new Set<PendingHeadlessStart>();
  private pendingHeadlessByTab = new Map<string, PendingHeadlessStart>();
  private closingTabIds = new Set<string>();
  private tabCloseTasks = new Map<string, Promise<void>>();

  constructor() {
    this.relayPath = resolveResourcePath(
      path.join('relay', binaryName('relay')),
      binaryName('relay'),
    );
    this.headlessVKPath = resolveResourcePath(
      path.join('headless', 'vk', binaryName('headless-vk-creator')),
      binaryName('headless-vk-creator'),
    );
    this.headlessTelemostPath = resolveResourcePath(
      path.join('headless', 'telemost', binaryName('headless-telemost-creator')),
      binaryName('headless-telemost-creator'),
    );
    this.headlessWBStreamPath = resolveResourcePath(
      path.join('headless', 'wbstream', binaryName('headless-wbstream-creator')),
      binaryName('headless-wbstream-creator'),
    );
    this.headlessDionPath = resolveResourcePath(
      path.join('headless', 'dion', binaryName('headless-dion-creator')),
      binaryName('headless-dion-creator'),
    );
    this.hooksDir = app.isPackaged
      ? path.join(process.resourcesPath!, 'hooks')
      : path.join(__dirname, '..', '..', '..', 'hooks');
  }

  get mainWindow(): BrowserWindow | null {
    return this._mainWindow;
  }

  set mainWindow(w: BrowserWindow | null) {
    this._mainWindow = w;
  }

  get botManager(): BotManager | null {
    return this._botManager;
  }

  set botManager(bm: BotManager | null) {
    this._botManager = bm;
  }

  setSecretLifecycleRunner(runner: SecretLifecycleRunner): void {
    this.secretLifecycleRunner = runner;
  }

  private runSecretLifecycle<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.secretLifecycleRunner(operation);
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  async allocPorts(): Promise<PortPair> {
    while (true) {
      const dc = this.nextPortBase;
      const pion = this.nextPortBase + 1;
      this.nextPortBase += 2;
      if (await this.isPortFree(dc) && await this.isPortFree(pion)) {
        return { dc, pion };
      }
    }
  }

  async getOrCreateTab(tabId: string): Promise<TabState> {
    if (this.closingTabIds.has(tabId)) {
      throw new Error('Tab is closing');
    }
    if (!this.tabs.has(tabId)) {
      const ports = await this.allocPorts();
      if (this.closingTabIds.has(tabId)) {
        throw new Error('Tab is closing');
      }
      this.tabs.set(tabId, {
        relay: null,
        tunnelMode: TunnelMode.DC,
        platform: Platform.VK,
        dcPort: ports.dc,
        pionPort: ports.pion,
      });
    }
    return this.tabs.get(tabId)!;
  }

  getTab(tabId: string): TabState | undefined {
    return this.tabs.get(tabId);
  }

  deleteTab(tabId: string): void {
    void this.closeTabAndWait(tabId).catch(() => {
      console.error('[MAIN] Tab cleanup failed');
    });
  }

  closeTabAndWait(tabId: string): Promise<void> {
    const existing = this.tabCloseTasks.get(tabId);
    if (existing) return existing;

    const task = this.performTabClose(tabId);
    this.tabCloseTasks.set(tabId, task);
    const forget = (): void => {
      if (this.tabCloseTasks.get(tabId) === task) {
        this.tabCloseTasks.delete(tabId);
      }
    };
    void task.then(forget, forget);
    return task;
  }

  private async performTabClose(tabId: string): Promise<void> {
    this.closingTabIds.add(tabId);
    const pendingStarts = this.cancelPendingHeadlessStarts(
      (pending) => pending.tabId === tabId,
    );
    try {
      await this.runSecretLifecycle(async () => {
        const tab = this.tabs.get(tabId);
        this.tabs.delete(tabId);
        this.botTabIds.delete(tabId);
        this.callStatusCache.delete(tabId);
        if (tab) await this.stopRelayAndWait(tabId, tab);
      });
    } finally {
      await Promise.all(pendingStarts.map((pending) => pending.settled));
      this.closingTabIds.delete(tabId);
    }
  }

  addBotTab(tabId: string): void {
    this.botTabIds.add(tabId);
  }

  removeBotTab(tabId: string): void {
    this.botTabIds.delete(tabId);
  }

  isBotTab(tabId: string): boolean {
    return this.botTabIds.has(tabId);
  }

  setCallStatus(tabId: string, status: CallStatus): void {
    this.callStatusCache.set(tabId, status);
  }

  getCallStatus(tabId: string): CallStatus {
    return this.callStatusCache.get(tabId) || CallStatus.Inactive;
  }

  getTabList(): TabListEntry[] {
    const result: TabListEntry[] = [];
    this.tabs.forEach((tab, tabId) => {
      result.push({
        id: tabId,
        platform: tab.platform,
        mode: tab.tunnelMode,
        isBot: tab.isBot === true,
        callStatus: this.getCallStatus(tabId),
      });
    });
    return result;
  }

  private sendLog(tabId: string, msg: string): void {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      this._mainWindow.webContents.send(IPC.RELAY_LOG, { tabId, msg });
    }
  }

  private sendHeadlessEvent(tabId: string, event: HeadlessProcessEvent): void {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      this._mainWindow.webContents.send(IPC.HEADLESS_EVENT, { tabId, event });
    }
  }

  private attachProcessOutput(
    proc: ChildProcess,
    tabId: string,
    options: ProcessOutputOptions = {},
  ): void {
    const processLine = (rawLine: string): void => {
      const msg = rawLine.trim();
      if (!msg) return;

      options.inspect?.(msg);

      let diagnostic = redactSensitiveText(msg);
      if (options.headless) {
        const classified = classifyHeadlessProcessLine(msg);
        diagnostic = classified.diagnostic;
        if (classified.event) this.sendHeadlessEvent(tabId, classified.event);
      }

      console.log(`[process:${tabId}]`, diagnostic);
      this.sendLog(tabId, diagnostic);
    };

    const attachStream = (stream: NodeJS.ReadableStream | null | undefined): void => {
      if (!stream) return;
      const buffer = new ProcessLineBuffer();
      stream.on('data', (data: Buffer | string) => {
        buffer.push(data).forEach(processLine);
      });
      const flush = (): void => {
        buffer.flush().forEach(processLine);
      };
      stream.on('end', flush);
      stream.on('close', flush);
    };

    attachStream(proc.stdout);
    attachStream(proc.stderr);
  }

  async sendBotCallLink(tabId: string, link: string): Promise<void> {
    return this.runSecretLifecycle(async () => {
      if (!this.botTabIds.has(tabId) || !this._botManager) return;
      const tab = this.tabs.get(tabId);
      if (!tab || tab.peerId == null) return;
      console.log(`[MAIN] Sending headless result for bot tab ${tabId}`);
      await this._botManager.sendMessage(tab.peerId, link);
    });
  }

  setUpstreamProxy(proxy: UpstreamProxy): void {
    this.upstreamProxy = {
      socks: (proxy?.socks || '').trim(),
      user: proxy?.user || '',
      pass: proxy?.pass || '',
    };
  }

  private appendUpstreamArgs(args: string[]): void {
    if (!this.upstreamProxy.socks) return;
    args.push('--upstream-socks', this.upstreamProxy.socks);
    if (this.upstreamProxy.user) args.push('--upstream-user', this.upstreamProxy.user);
    if (this.upstreamProxy.pass) args.push('--upstream-pass', this.upstreamProxy.pass);
  }

  async startRelay(tabId: string, tab: TabState): Promise<void> {
    await this.stopRelayAndWait(tabId, tab);
    if (this.tabs.get(tabId) !== tab) return;
    const port = tab.tunnelMode === TunnelMode.PionVideo ? tab.pionPort : tab.dcPort;
    let relayMode: RelayMode = RelayMode.DCCreator;
    if (tab.tunnelMode === TunnelMode.PionVideo) {
      relayMode = tab.platform === Platform.Telemost
        ? RelayMode.TelemostVideoCreator
        : RelayMode.VKVideoCreator;
    }
    const relayArgs = ['--mode', relayMode, '--ws-port', String(port)];
    this.appendUpstreamArgs(relayArgs);
    const proc = spawn(this.relayPath, relayArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.trackProcess(proc);
    tab.relay = proc;
    this.attachProcessOutput(proc, tabId);
    proc.on('close', (code) => {
      if (tab.relay === proc) tab.relay = null;
      this.sendLog(tabId, `Relay exited with code ${code}`);
    });
  }

  private headlessConfig(platform: Platform): {
    tunnelMode: TunnelMode;
    authCookie: string;
    loginUrl: string;
    cookieDomains: string[];
    platformName: string;
    binaryPath: string;
  } | null {
    switch (platform) {
      case Platform.Telemost:
        return {
          tunnelMode: TunnelMode.HeadlessTelemost,
          authCookie: YANDEX_AUTH_COOKIE,
          loginUrl: YANDEX_LOGIN_URL,
          cookieDomains: YANDEX_COOKIE_DOMAINS,
          platformName: 'Yandex',
          binaryPath: this.headlessTelemostPath,
        };
      case Platform.Dion:
        return {
          tunnelMode: TunnelMode.HeadlessDion,
          authCookie: DION_AUTH_COOKIE,
          loginUrl: DION_LOGIN_URL,
          cookieDomains: DION_COOKIE_DOMAINS,
          platformName: 'DION',
          binaryPath: this.headlessDionPath,
        };
      case Platform.VK:
        return {
          tunnelMode: TunnelMode.HeadlessVK,
          authCookie: VK_AUTH_COOKIE,
          loginUrl: VK_LOGIN_URL,
          cookieDomains: VK_COOKIE_DOMAINS,
          platformName: 'VK',
          binaryPath: this.headlessVKPath,
        };
      case Platform.WBStream:
        return {
          tunnelMode: TunnelMode.HeadlessWBStream,
          authCookie: WBSTREAM_AUTH_COOKIE,
          loginUrl: WBSTREAM_LOGIN_URL,
          cookieDomains: WBSTREAM_COOKIE_DOMAINS,
          platformName: 'WB Stream',
          binaryPath: this.headlessWBStreamPath,
        };
      default:
        return null;
    }
  }

  private joinFlagFor(platform: Platform): string | null {
    switch (platform) {
      case Platform.VK:
        return '--vk-link';
      case Platform.Telemost:
        return '--tm-link';
      case Platform.WBStream:
      case Platform.Dion:
        return '--room';
      default:
        return null;
    }
  }

  async startHeadless(tabId: string, platform: Platform, args: HeadlessStartArgs): Promise<void> {
    const pending = this.beginHeadlessStart(tabId);
    const signal = pending.controller.signal;
    let loginRequested = false;
    try {
      if (!this.headlessStartIsActive(pending)) return;
      const tab = await this.getOrCreateTab(tabId);
      if (!this.headlessStartIsActive(pending, tab)) return;

      tab.platform = platform;
      const joinTarget = args.mode === HeadlessMode.Join ? (args.target || '').trim() : '';
      if (args.mode === HeadlessMode.Join && !joinTarget) {
        this.sendLog(tabId, 'Join requested but no target link/room provided.');
        return;
      }

      const config = this.headlessConfig(platform);
      if (!config) {
        this.sendLog(tabId, `Unsupported headless platform: ${platform}`);
        return;
      }
      tab.tunnelMode = config.tunnelMode;
      let cookies = await this.getCookiesForDomains(config.cookieDomains);
      if (!this.headlessStartIsActive(pending, tab)) return;

      const refreshCookie = platform === Platform.WBStream ? 'wbx-refresh' : config.authCookie;
      const needsLogin = !cookies.some((cookie) => cookie.name === refreshCookie);
      if (needsLogin) {
        if (tab.isBot) {
          const reply = `Please log into ${config.platformName} in the creator app first, then try again.`;
          this.sendLog(tabId, reply);
          if (this.headlessStartIsActive(pending, tab)) {
            await this.sendBotCallLink(tabId, reply);
          }
          return;
        }

        this.sendLog(tabId, `No ${config.platformName} session found, opening login.`);
        if (this._mainWindow && !this._mainWindow.isDestroyed()) {
          this._mainWindow.webContents.send(IPC.LOGIN_REQUIRED, { tabId, url: config.loginUrl });
          loginRequested = true;
        }

        let loginCompleted: boolean;
        if (platform === Platform.WBStream) {
          this.sendLog(tabId, 'Waiting for x_wbaas_token, wbx-refresh, wbx-validation-key...');
          loginCompleted = await this.waitForCookies(
            ['x_wbaas_token', 'wbx-refresh', 'wbx-validation-key'],
            config.cookieDomains,
            signal,
          );
        } else if (platform === Platform.Dion) {
          this.sendLog(tabId, 'Waiting for vc-refresh-token, vc-access-token...');
          loginCompleted = await this.waitForCookies(
            ['vc-refresh-token', 'vc-access-token'],
            config.cookieDomains,
            signal,
          );
        } else {
          loginCompleted = await this.waitForLogin(
            config.cookieDomains,
            config.authCookie,
            signal,
          );
        }
        if (!loginCompleted || !this.headlessStartIsActive(pending, tab)) return;

        if (this._mainWindow && !this._mainWindow.isDestroyed()) {
          this._mainWindow.webContents.send(IPC.LOGIN_DONE, { tabId });
        }
        loginRequested = false;
        this.sendLog(tabId, `${config.platformName} login captured.`);
        cookies = await this.getCookiesForDomains(config.cookieDomains);
      }
      if (!this.headlessStartIsActive(pending, tab)) return;

      this.sendLog(tabId, `${config.platformName} session cookies prepared (${cookies.length}).`);
      await this.runSecretLifecycle(async () => {
        if (!this.headlessStartIsActive(pending, tab)) return;
        await this.stopRelayAndWait(tabId, tab);
        if (!this.headlessStartIsActive(pending, tab)) return;

        const cookieLease = await createEphemeralCookieFile(cookies);
        if (!this.headlessStartIsActive(pending, tab)) {
          if (!(await cookieLease.cleanup())) {
            throw new Error('Temporary cookie material could not be removed');
          }
          return;
        }

        const spawnArgs = ['--resources', 'default', '--cookies', cookieLease.filePath];
        if (joinTarget) {
          const flag = this.joinFlagFor(platform);
          if (flag) spawnArgs.push(flag, joinTarget);
        }
        this.appendUpstreamArgs(spawnArgs);
        const launchGeneration = this.secretGeneration;
        let proc: ChildProcess;
        try {
          proc = spawn(config.binaryPath, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          await cookieLease.cleanup();
          throw error;
        }
        this.trackProcess(proc);
        this.trackCookieLease(proc, cookieLease);
        tab.relay = proc;
        let sawAuthFailure = false;
        this.attachProcessOutput(proc, tabId, {
          headless: true,
          inspect: (msg) => {
            if (
              msg.includes('status 401') ||
              msg.includes('"UnauthorizedError"') ||
              msg.includes('"error":"unauthorized') ||
              msg.includes('empty access_token')
            ) {
              sawAuthFailure = true;
            }
          },
        });
        proc.on('close', async (code) => {
          const wasCurrent = this.tabs.get(tabId) === tab && tab.relay === proc;
          if (tab.relay === proc) tab.relay = null;
          this.sendLog(tabId, `Headless exited with code ${code}`);
          if (
            sawAuthFailure &&
            wasCurrent &&
            launchGeneration === this.secretGeneration
          ) {
            await this.clearAuthCookies(config.cookieDomains, config.authCookie);
            if (
              this.tabs.get(tabId) === tab &&
              tab.relay == null &&
              launchGeneration === this.secretGeneration
            ) {
              void this.startHeadless(tabId, platform, args);
            }
          }
        });
      });
    } finally {
      const wasLatest = this.pendingHeadlessByTab.get(tabId) === pending;
      if (loginRequested && signal.aborted && wasLatest) {
        if (this._mainWindow && !this._mainWindow.isDestroyed()) {
          this._mainWindow.webContents.send(IPC.LOGIN_DONE, { tabId });
        }
      }
      this.finishHeadlessStart(pending);
    }
  }

  private beginHeadlessStart(tabId: string): PendingHeadlessStart {
    this.pendingHeadlessByTab.get(tabId)?.controller.abort();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const pending: PendingHeadlessStart = {
      tabId,
      controller: new AbortController(),
      settled,
      resolveSettled,
    };
    this.pendingHeadlessStarts.add(pending);
    this.pendingHeadlessByTab.set(tabId, pending);
    return pending;
  }

  private finishHeadlessStart(pending: PendingHeadlessStart): void {
    this.pendingHeadlessStarts.delete(pending);
    if (this.pendingHeadlessByTab.get(pending.tabId) === pending) {
      this.pendingHeadlessByTab.delete(pending.tabId);
    }
    pending.resolveSettled();
  }

  private headlessStartIsActive(pending: PendingHeadlessStart, tab?: TabState): boolean {
    return (
      !pending.controller.signal.aborted &&
      !this.closingTabIds.has(pending.tabId) &&
      this.pendingHeadlessByTab.get(pending.tabId) === pending &&
      (tab === undefined || this.tabs.get(pending.tabId) === tab)
    );
  }

  private cancelPendingHeadlessStarts(
    predicate: (pending: PendingHeadlessStart) => boolean,
  ): PendingHeadlessStart[] {
    const pending = Array.from(this.pendingHeadlessStarts).filter(predicate);
    pending.forEach((start) => start.controller.abort());
    return pending;
  }

  private async clearAuthCookies(cookieDomains: string[], authCookieName: string): Promise<void> {
    const ses = session.fromPartition(SESSION_PARTITION);
    const matches = await ses.cookies.get({ name: authCookieName });
    for (const cookie of matches) {
      if (!cookie.domain || !cookieDomainMatchesRoots(cookie.domain, cookieDomains)) continue;
      const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const url = `https://${host}${cookie.path || '/'}`;
      try {
        await ses.cookies.remove(url, cookie.name);
      } catch {
        console.log('[COOKIES] failed to remove an authentication cookie');
      }
    }
  }

  async clearPlatformCookies(platform: Platform): Promise<number> {
    const config = this.headlessConfig(platform);
    if (!config) return 0;
    const ses = session.fromPartition(SESSION_PARTITION);
    const all = await ses.cookies.get({});
    let removed = 0;
    for (const cookie of all) {
      if (!cookie.domain || !cookieDomainMatchesRoots(cookie.domain, config.cookieDomains)) continue;
      const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const url = `https://${host}${cookie.path || '/'}`;
      try {
        await ses.cookies.remove(url, cookie.name);
        removed++;
      } catch {
        console.log('[COOKIES] failed to remove a platform cookie');
      }
    }
    console.log(`[COOKIES] cleared ${removed} cookies for ${platform}`);
    return removed;
  }

  private waitForLogin(
    cookieDomains: string[],
    authCookieName: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const ses = session.fromPartition(SESSION_PARTITION);
      let finished = false;
      const cleanup = (): void => {
        ses.cookies.removeListener('changed', onChanged);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (completed: boolean): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(completed);
      };
      const fail = (error: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => finish(false);
      const onChanged = (
        _event: Electron.Event,
        cookie: Electron.Cookie,
        _cause: string,
        removed: boolean,
      ): void => {
        if (removed) return;
        if (cookie.name !== authCookieName) return;
        if (!cookie.domain || !cookieDomainMatchesRoots(cookie.domain, cookieDomains)) return;
        finish(true);
      };

      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      ses.cookies.on('changed', onChanged);
      ses.cookies.get({ name: authCookieName }).then((found) => {
        if (found.some((cookie) =>
          cookie.domain != null && cookieDomainMatchesRoots(cookie.domain, cookieDomains)
        )) {
          finish(true);
        }
      }).catch(fail);
    });
  }

  invalidateSecretConsumers(): Promise<void> {
    this.secretGeneration += 1;
    const pending = this.cancelPendingHeadlessStarts(() => true);
    return Promise.all(pending.map((start) => start.settled)).then(() => undefined);
  }

  private trackProcess(proc: ChildProcess): void {
    this.activeProcesses.add(proc);
    const forget = (): void => {
      this.activeProcesses.delete(proc);
    };
    proc.once('close', forget);
    proc.once('error', () => {
      if (proc.pid == null || proc.exitCode !== null || proc.signalCode !== null) forget();
    });
  }

  private trackCookieLease(proc: ChildProcess, lease: EphemeralCookieFile): void {
    this.cookieLeases.set(proc, lease);
    const cleanup = (): void => {
      void this.cleanupCookieLease(proc);
    };
    proc.once('error', cleanup);
    proc.once('close', cleanup);
  }

  private async cleanupCookieLease(proc: ChildProcess): Promise<boolean> {
    const lease = this.cookieLeases.get(proc);
    if (!lease) return true;
    const cleaned = await lease.cleanup();
    if (cleaned) this.cookieLeases.delete(proc);
    return cleaned;
  }

  private async stopRelayAndWait(tabId: string, tab: TabState): Promise<void> {
    const proc = tab.relay;
    if (!proc) return;
    tab.relay = null;
    console.log(`[${tabId}] stopping process pid=${proc.pid}`);
    await terminateChildProcess(proc);
    this.activeProcesses.delete(proc);
    if (!(await this.cleanupCookieLease(proc))) {
      throw new Error('Temporary cookie material could not be removed');
    }
  }

  killRelay(tabId: string, tab: TabState): void {
    if (!tab.relay) return;
    const proc = tab.relay;
    tab.relay = null;
    console.log(`[${tabId}] killing process pid=${proc.pid}`);
    try {
      proc.kill();
    } catch {}
    if (proc.pid == null || proc.exitCode !== null || proc.signalCode !== null) {
      void this.cleanupCookieLease(proc);
    }
  }

  async stopAllRelaysAndWait(): Promise<void> {
    const processes = new Set<ChildProcess>([
      ...this.activeProcesses,
      ...this.cookieLeases.keys(),
    ]);
    this.tabs.forEach((tab) => {
      if (tab.relay) processes.add(tab.relay);
      tab.relay = null;
    });

    await Promise.all(Array.from(processes).map(async (proc) => {
      await terminateChildProcess(proc);
      this.activeProcesses.delete(proc);
      if (!(await this.cleanupCookieLease(proc))) {
        throw new Error('Temporary cookie material could not be removed');
      }
    }));
  }

  killAllRelays(): void {
    this.tabs.forEach((tab, tabId) => this.killRelay(tabId, tab));
    for (const proc of Array.from(this.activeProcesses)) {
      try {
        proc.kill();
      } catch {}
    }
    for (const [proc, lease] of Array.from(this.cookieLeases.entries())) {
      if (lease.cleanupSync()) this.cookieLeases.delete(proc);
    }
  }

  async loadHook(tabId: string, url: string, tab: TabState): Promise<string> {
    const isDion = url.includes('dion.vc');
    const isTelemost = url.includes('telemost.yandex');
    if (isDion) {
      tab.platform = Platform.Dion;
      return LOG_CAPTURE_SNIPPET;
    }
    tab.platform = isTelemost ? Platform.Telemost : Platform.VK;

    if (isTelemost || tab.tunnelMode === TunnelMode.PionVideo) {
      const hookFile = isTelemost ? 'video-telemost.js' : 'video-vk.js';
      const hook = await fs.readFile(path.join(this.hooksDir, hookFile), 'utf8');
      return LOG_CAPTURE_SNIPPET + `window.PION_PORT=${tab.pionPort};window.IS_CREATOR=true;` + hook;
    }

    const hook = await fs.readFile(path.join(this.hooksDir, 'dc-creator-vk.js'), 'utf8');
    return LOG_CAPTURE_SNIPPET + `window.WS_PORT=${tab.dcPort};` + hook;
  }

  async setTunnelMode(tabId: string, mode: TunnelMode, platform?: Platform): Promise<void> {
    const tab = await this.getOrCreateTab(tabId);
    tab.tunnelMode = mode;
    if (platform) tab.platform = platform;
    if (
      mode === TunnelMode.HeadlessVK ||
      mode === TunnelMode.HeadlessTelemost ||
      mode === TunnelMode.HeadlessWBStream ||
      mode === TunnelMode.HeadlessDion
    ) return;
    await this.stopRelayAndWait(tabId, tab);
    await new Promise((resolve) => setTimeout(resolve, RELAY_RESTART_DELAY_MS));
    if (this.tabs.get(tabId) !== tab) return;
    await this.startRelay(tabId, tab);
  }

  private async getCookiesForDomains(domains: string[]): Promise<{ name: string; value: string }[]> {
    const ses = session.fromPartition(SESSION_PARTITION);
    const all = await ses.cookies.get({});
    return all
      .filter((cookie) => cookie.domain != null && cookieDomainMatchesRoots(cookie.domain, domains))
      .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  }

  private waitForCookies(
    names: string[],
    cookieDomains: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const ses = session.fromPartition(SESSION_PARTITION);
      const remaining = new Set(names);
      let finished = false;
      const cleanup = (): void => {
        ses.cookies.removeListener('changed', onChanged);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (completed: boolean): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(completed);
      };
      const fail = (error: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => finish(false);
      const onChanged = (
        _event: Electron.Event,
        cookie: Electron.Cookie,
        _cause: string,
        removed: boolean,
      ): void => {
        if (removed) return;
        if (!remaining.has(cookie.name)) return;
        if (!cookie.domain || !cookieDomainMatchesRoots(cookie.domain, cookieDomains)) return;
        remaining.delete(cookie.name);
        if (remaining.size === 0) finish(true);
      };

      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      ses.cookies.on('changed', onChanged);
      Promise.all(names.map((name) => ses.cookies.get({ name }))).then((results) => {
        results.forEach((found, index) => {
          if (found.some((cookie) =>
            cookie.domain != null && cookieDomainMatchesRoots(cookie.domain, cookieDomains)
          )) {
            remaining.delete(names[index]);
          }
        });
        if (remaining.size === 0) finish(true);
      }).catch(fail);
    });
  }

  async setWBStreamDeviceId(id: string): Promise<void> {
    if (!id) return;
    const ses = session.fromPartition(SESSION_PARTITION);
    const existing = await ses.cookies.get({ url: 'https://stream.wb.ru/', name: '__wb_device_id' });
    if (existing.length > 0 && existing[0].value === id) return;
    try {
      await ses.cookies.set({
        url: 'https://stream.wb.ru/',
        name: '__wb_device_id',
        value: id,
        domain: 'stream.wb.ru',
        path: '/',
        secure: true,
        httpOnly: false,
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5,
      });
      console.log('[wb-device-id] persisted');
    } catch {
      console.log('[wb-device-id] failed to persist');
    }
  }
}
