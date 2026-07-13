import { ipcRenderer } from 'electron';
import { IPC } from '../constants';
import type {
  BotTabData,
  Bridge,
  HeadlessProcessEvent,
  HeadlessStartArgs,
  LegacyPlaintextSettings,
  ProtectedSettingsUpdate,
} from '../types';

const bridge: Bridge = {
  onRelayLog(cb: (tabId: string, msg: string) => void) {
    ipcRenderer.on(IPC.RELAY_LOG, (_e, data) => cb(data.tabId, data.msg));
  },
  onHeadlessEvent(cb: (tabId: string, event: HeadlessProcessEvent) => void) {
    ipcRenderer.on(IPC.HEADLESS_EVENT, (_e, data) => cb(data.tabId, data.event));
  },
  getHookCode(tabId: string, url: string) {
    return ipcRenderer.invoke(IPC.GET_HOOK_CODE, tabId, url);
  },
  setTunnelMode(tabId: string, mode: string, platform?: string) {
    return ipcRenderer.invoke(IPC.SET_TUNNEL_MODE, tabId, mode, platform);
  },
  startRelay(tabId: string) {
    return ipcRenderer.invoke(IPC.START_RELAY, tabId);
  },
  closeTab(tabId: string) {
    return ipcRenderer.invoke(IPC.CLOSE_TAB, tabId);
  },
  getProtectedSettings() {
    return ipcRenderer.invoke(IPC.GET_PROTECTED_SETTINGS);
  },
  saveProtectedSettings(update: ProtectedSettingsUpdate) {
    return ipcRenderer.invoke(IPC.SAVE_PROTECTED_SETTINGS, update);
  },
  migrateLegacySettings(settings: LegacyPlaintextSettings) {
    return ipcRenderer.invoke(IPC.MIGRATE_LEGACY_SETTINGS, settings);
  },
  startBot() {
    return ipcRenderer.invoke(IPC.START_BOT);
  },
  stopBot() {
    return ipcRenderer.invoke(IPC.STOP_BOT);
  },
  clearCookies(platform: string) {
    return ipcRenderer.invoke(IPC.CLEAR_COOKIES, platform);
  },
  onCreateBotTab(cb: (data: BotTabData) => void) {
    ipcRenderer.on(IPC.CREATE_BOT_TAB, (_e, data) => cb(data));
  },
  getCallCreatorCode(scriptFile: string) {
    return ipcRenderer.invoke(IPC.GET_CALL_CREATOR_CODE, scriptFile);
  },
  onBotError(cb: (msg: string) => void) {
    ipcRenderer.on(IPC.BOT_ERROR, (_e, msg) => cb(msg));
  },
  startHeadless(tabId: string, platform: string, args: HeadlessStartArgs) {
    return ipcRenderer.invoke(IPC.START_HEADLESS, tabId, platform, args);
  },
  sendBotCallLink(tabId: string, link: string) {
    return ipcRenderer.invoke(IPC.SEND_BOT_CALL_LINK, tabId, link);
  },
  onCloseBotTab(cb: (data: { tabId: string }) => void) {
    ipcRenderer.on(IPC.CLOSE_BOT_TAB, (_e, data) => cb(data));
  },
  onLoginRequired(cb: (tabId: string, url: string) => void) {
    ipcRenderer.on(IPC.LOGIN_REQUIRED, (_e, data) => cb(data.tabId, data.url));
  },
  onLoginDone(cb: (tabId: string) => void) {
    ipcRenderer.on(IPC.LOGIN_DONE, (_e, data) => cb(data.tabId));
  },
};

const isolatedWindow = window as unknown as Window & { bridge: Bridge };
isolatedWindow.bridge = bridge;

function startTrustedRenderer(): void {
  require('../renderer/index');
  document.documentElement.dataset.creatorRendererReady = 'true';
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startTrustedRenderer, { once: true });
} else {
  startTrustedRenderer();
}
