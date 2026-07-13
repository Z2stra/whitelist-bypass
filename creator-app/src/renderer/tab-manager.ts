import {
  RendererTab,
  BotTabData,
  ProtectedSettingsUpdate,
  ProtectedSettingsView,
  TunnelMode,
  Platform,
  Bridge,
  HeadlessMode,
  HeadlessStartArgs,
  HeadlessProcessEvent,
} from '../types';
import { applyHeadlessProcessEvent } from './headless-event-state';
import {
  collectLegacyPlaintextSettings,
  legacyMigrationIsConfirmed,
  legacySecretsResolvedAfterSave,
  removeLegacyPlaintextSettings,
} from './protected-settings-migration';

declare const window: Window & { bridge: Bridge };

export class RendererTabManager {
  tabs: Record<string, RendererTab> = {};
  activeTabId: string | null = null;
  private nextId = 1;
  botRunning = false;
  settingsView: ProtectedSettingsView = {
    protection: {
      available: false,
      backend: 'unknown',
      warning: 'Protected settings have not been loaded.',
    },
    bot: { groupId: '', userId: '', tokenConfigured: false },
    proxy: { socks: '', usernameConfigured: false, passwordConfigured: false },
  };
  private onRender: () => void;

  constructor(onRender: () => void) {
    this.onRender = onRender;
  }

  async initializeProtectedSettings(): Promise<void> {
    const legacy = collectLegacyPlaintextSettings(localStorage);
    if (legacy.hadLegacy) {
      let migrated = false;
      try {
        const migratedView = await window.bridge.migrateLegacySettings(legacy);
        if (!legacyMigrationIsConfirmed(legacy, migratedView)) {
          throw new Error('Protected migration could not be confirmed.');
        }
        this.settingsView = migratedView;
        migrated = true;
      } catch {
        const current = await window.bridge.getProtectedSettings();
        this.settingsView = {
          ...current,
          protection: {
            ...current.protection,
            warning:
              current.protection.warning ||
              'Legacy plaintext migration is pending. Re-enter and save secrets before live use.',
          },
        };
      }
      if (migrated && !removeLegacyPlaintextSettings(localStorage)) {
        throw new Error('Protected migration succeeded, but legacy plaintext could not be removed.');
      }
    } else {
      this.settingsView = await window.bridge.getProtectedSettings();
    }
    this.onRender();
  }

  async refreshProtectedSettings(): Promise<void> {
    this.settingsView = await window.bridge.getProtectedSettings();
    this.onRender();
  }

  async saveProtectedSettings(update: ProtectedSettingsUpdate): Promise<void> {
    const legacy = collectLegacyPlaintextSettings(localStorage);
    this.settingsView = await window.bridge.saveProtectedSettings(update);
    this.botRunning = false;
    localStorage.setItem('botEnabled', 'false');
    if (!legacySecretsResolvedAfterSave(legacy, update, this.settingsView)) {
      throw new Error(
        'Protected settings were saved, but legacy secrets are not confirmed in protected storage.',
      );
    }
    if (!removeLegacyPlaintextSettings(localStorage)) {
      throw new Error('Protected settings were saved, but legacy plaintext could not be removed.');
    }
    this.onRender();
  }

  hasBotConfiguration(): boolean {
    return (
      this.settingsView.protection.available &&
      this.settingsView.bot.tokenConfigured &&
      this.settingsView.bot.groupId.length > 0 &&
      this.settingsView.bot.userId.length > 0
    );
  }

  createTab(): string {
    const tabId = 'tab-' + this.nextId++;
    this.tabs[tabId] = {
      wv: null,
      url: '',
      mode: TunnelMode.DC,
      relayLogs: '',
      hookLogs: '',
      name: '',
      isBot: false,
    };
    this.selectTab(tabId);
    return tabId;
  }

  switchToHeadless(platform: Platform, joinTarget?: string): void {
    if (!this.activeTabId) return;
    const tab = this.tabs[this.activeTabId];
    if (tab.wv) tab.wv.remove();
    tab.wv = null;
    tab.url = '';
    switch (platform) {
      case Platform.Telemost:
        tab.mode = TunnelMode.HeadlessTelemost;
        if (!tab.isBot) tab.name = 'Telemost';
        break;
      case Platform.WBStream:
        tab.mode = TunnelMode.HeadlessWBStream;
        if (!tab.isBot) tab.name = 'WBStream';
        break;
      case Platform.Dion:
        tab.mode = TunnelMode.HeadlessDion;
        if (!tab.isBot) tab.name = 'DION';
        break;
      default:
        tab.mode = TunnelMode.HeadlessVK;
        if (!tab.isBot) tab.name = 'VK';
    }
    tab.headless = true;
    tab.headlessStarted = false;
    tab.platform = platform;
    tab.callInfo = undefined;
    tab.headlessStatus = undefined;
    tab.tunnelConnected = false;
    tab.relayLogs = '';
    tab.hookLogs = '';
    if (tab.isBot) {
      if (joinTarget) {
        this.startHeadlessCall({ mode: HeadlessMode.Join, target: joinTarget });
      } else {
        this.startHeadlessCall({ mode: HeadlessMode.Create });
      }
    }
    this.onRender();
  }

  startHeadlessCall(args: HeadlessStartArgs): void {
    if (!this.activeTabId) return;
    const tab = this.tabs[this.activeTabId];
    if (!tab || !tab.headless || !tab.platform) return;
    tab.headlessStarted = true;
    tab.headlessStatus = 'Starting...';
    tab.callInfo = undefined;
    window.bridge.startHeadless(this.activeTabId, tab.platform, args);
    this.onRender();
  }

  createBotTab(data: BotTabData): void {
    if (!this.tabs[data.tabId]) {
      const isHeadless =
        data.mode === TunnelMode.HeadlessVK ||
        data.mode === TunnelMode.HeadlessTelemost ||
        data.mode === TunnelMode.HeadlessWBStream ||
        data.mode === TunnelMode.HeadlessDion;
      let platformName = 'VK';
      if (data.platform === Platform.Telemost) platformName = 'Telemost';
      else if (data.platform === Platform.WBStream) platformName = 'WBStream';
      else if (data.platform === Platform.Dion) platformName = 'DION';
      const botName = isHeadless ? `Bot-${platformName}` : `Bot-${platformName} (legacy)`;
      this.tabs[data.tabId] = {
        wv: null,
        url: '',
        mode: data.mode,
        relayLogs: '',
        hookLogs: '',
        name: botName,
        isBot: true,
        peerId: data.peerId,
        platform: data.platform,
        joinedByLink: !!data.joinTarget,
      };
    }
    this.selectTab(data.tabId);
  }

  closeTab(tabId: string): void {
    const tab = this.tabs[tabId];
    if (tab?.wv) tab.wv.remove();
    if (tab?.loginWebview) tab.loginWebview.remove();
    window.bridge.closeTab(tabId);
    delete this.tabs[tabId];
    if (this.activeTabId === tabId) {
      const ids = Object.keys(this.tabs);
      this.activeTabId = ids.length > 0 ? ids[ids.length - 1] : null;
    }
    this.onRender();
  }

  selectTab(tabId: string): void {
    this.saveCurrentTabLogs();
    this.activeTabId = tabId;
    this.onRender();
  }

  saveCurrentTabLogs(): void {
    if (this.activeTabId && this.tabs[this.activeTabId]) {
      const relayEl = document.getElementById('relayLog');
      const hookEl = document.getElementById('hookLog');
      if (relayEl) this.tabs[this.activeTabId].relayLogs = relayEl.textContent || '';
      if (hookEl) this.tabs[this.activeTabId].hookLogs = hookEl.textContent || '';
    }
  }

  getActiveTab(): RendererTab | null {
    if (!this.activeTabId) return null;
    return this.tabs[this.activeTabId] || null;
  }

  getTabLabel(tab: RendererTab): string {
    if (tab.name) return tab.name;
    if (tab.url) {
      if (tab.url.includes('vk.com')) return 'VK (legacy)';
      if (tab.url.includes('telemost')) return 'Telemost (legacy)';
      if (tab.url.includes('dion.vc')) return 'DION';
    }
    return 'New';
  }

  appendRelayLog(tabId: string, msg: string): void {
    const tab = this.tabs[tabId];
    if (!tab) return;
    tab.relayLogs += (tab.relayLogs ? '\n' : '') + msg;
    if (tabId === this.activeTabId) {
      const el = document.getElementById('relayLog');
      if (el) {
        if (el.textContent!.length > 0) el.textContent += '\n';
        el.textContent += msg;
        el.scrollTop = el.scrollHeight;
      }
    }
  }

  handleHeadlessEvent(tabId: string, event: HeadlessProcessEvent): void {
    const tab = this.tabs[tabId];
    if (!tab) return;

    const result = applyHeadlessProcessEvent(tab, event);
    if (result.botReply) {
      void window.bridge.sendBotCallLink(tabId, result.botReply).catch(() => {
        tab.headlessStatus = 'Failed to send bot response';
        if (tabId === this.activeTabId) this.onRender();
      });
    }

    if (result.changed && tabId === this.activeTabId) this.onRender();
  }

  setTunnelMode(mode: string): void {
    if (!this.activeTabId) return;
    const tab = this.tabs[this.activeTabId];
    if (!tab) return;
    tab.mode = mode as TunnelMode;
    window.bridge.setTunnelMode(this.activeTabId, mode).then(() => {
      if (tab.wv) {
        tab.wv.executeJavaScript('window.__hookInstalled = false').catch(() => {});
        tab.wv.reload();
      }
    });
  }

  async toggleBot(): Promise<void> {
    if (this.botRunning) {
      await window.bridge.stopBot();
      this.botRunning = false;
      localStorage.setItem('botEnabled', 'false');
      this.onRender();
      return;
    }

    if (!this.hasBotConfiguration()) {
      throw new Error('Configure a protected VK token, group ID and allowed user ID first.');
    }
    const result = await window.bridge.startBot();
    if (!result.success) {
      throw new Error(result.error || 'VK bot failed to start.');
    }
    this.botRunning = true;
    localStorage.setItem('botEnabled', 'true');
    this.onRender();
  }

  async autoStartBot(): Promise<void> {
    if (localStorage.getItem('botEnabled') !== 'true') return;
    if (!this.hasBotConfiguration()) {
      localStorage.setItem('botEnabled', 'false');
      return;
    }
    const result = await window.bridge.startBot();
    if (!result.success) {
      localStorage.setItem('botEnabled', 'false');
      return;
    }
    this.botRunning = true;
    this.onRender();
  }
}
