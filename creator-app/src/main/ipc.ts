import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { pathToFileURL } from 'url';
import { TabManager } from './tab-manager';
import { BotManager } from '../bot/bot-manager';
import { BotCommandMode } from '../bot/command-mode';
import { safeErrorMessage } from '../bot/security';
import { IPC } from '../constants';
import {
  BotSettings,
  HeadlessStartArgs,
  Platform,
  TunnelMode,
} from '../types';
import {
  TrustPolicyError,
  assertArgumentCount,
  assertHeadlessStartArgs,
  assertOptionalPlatform,
  assertPlatform,
  assertRemoteUrl,
  assertScriptFile,
  assertSensitiveResult,
  assertTabId,
  assertTunnelMode,
  isTrustedIpcSenderSnapshot,
} from './trust-policy';
import {
  ProtectedSettingsError,
  ProtectedSettingsStore,
} from './protected-settings';

const APP_INDEX_PATH = path.join(__dirname, '..', '..', 'index.html');
const APP_INDEX_URL = pathToFileURL(APP_INDEX_PATH).toString();
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..', 'scripts');

type TrustedHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function assertTrustedIpcSender(event: IpcMainInvokeEvent, tabManager: TabManager): void {
  const mainWindow = tabManager.mainWindow;
  const senderFrame = event.senderFrame;
  if (!mainWindow || mainWindow.isDestroyed() || !senderFrame) {
    throw new TrustPolicyError('IPC sender is unavailable');
  }

  const snapshot = {
    senderId: event.sender.id,
    expectedSenderId: mainWindow.webContents.id,
    frameUrl: senderFrame.url,
    expectedFrameUrl: APP_INDEX_URL,
    isMainFrame:
      senderFrame.processId === event.sender.mainFrame.processId &&
      senderFrame.routingId === event.sender.mainFrame.routingId,
  };

  if (!isTrustedIpcSenderSnapshot(snapshot)) {
    throw new TrustPolicyError('IPC sender is not trusted');
  }
}

function registerTrustedHandler(
  channel: string,
  tabManager: TabManager,
  handler: TrustedHandler,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, tabManager);
    return handler(event, ...args);
  });
}

function assertNoArguments(args: unknown[]): void {
  assertArgumentCount(args.length, [0]);
}

export function registerIpcHandlers(
  tabManager: TabManager,
  protectedSettings: ProtectedSettingsStore,
  botCommandMode: BotCommandMode = BotCommandMode.Operational,
): void {
  registerTrustedHandler(IPC.GET_HOOK_CODE, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [2]);
    const tabId = assertTabId(args[0]);
    const url = assertRemoteUrl(args[1]);
    const tab = await tabManager.getOrCreateTab(tabId);
    return tabManager.loadHook(tabId, url, tab);
  });

  registerTrustedHandler(IPC.GET_CALL_CREATOR_CODE, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [1]);
    const scriptFile = assertScriptFile(args[0]);
    const filePath = path.resolve(SCRIPTS_ROOT, scriptFile);
    if (path.dirname(filePath) !== SCRIPTS_ROOT) {
      throw new TrustPolicyError('Script path escaped the allowlisted directory');
    }
    return fs.readFile(filePath, 'utf8');
  });

  registerTrustedHandler(IPC.SET_TUNNEL_MODE, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [2, 3]);
    const tabId = assertTabId(args[0]);
    const mode = assertTunnelMode(args[1]);
    const platform = assertOptionalPlatform(args[2]);
    await tabManager.setTunnelMode(tabId, mode, platform);
  });

  registerTrustedHandler(IPC.START_RELAY, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [1]);
    const tabId = assertTabId(args[0]);
    const tab = await tabManager.getOrCreateTab(tabId);
    tabManager.startRelay(tabId, tab);
  });

  registerTrustedHandler(IPC.START_HEADLESS, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [3]);
    const tabId = assertTabId(args[0]);
    const platform = assertPlatform(args[1]);
    const startArgs = assertHeadlessStartArgs(args[2]);
    await tabManager.startHeadless(tabId, platform, startArgs);
  });

  registerTrustedHandler(IPC.CLOSE_TAB, tabManager, (_event, ...args) => {
    assertArgumentCount(args.length, [1]);
    tabManager.deleteTab(assertTabId(args[0]));
  });

  registerTrustedHandler(IPC.GET_PROTECTED_SETTINGS, tabManager, (_event, ...args) => {
    assertNoArguments(args);
    return protectedSettings.getView();
  });

  registerTrustedHandler(IPC.MIGRATE_LEGACY_SETTINGS, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [1]);
    const view = await protectedSettings.migrateLegacy(args[0]);
    tabManager.setUpstreamProxy(protectedSettings.getUpstreamProxy());
    return view;
  });

  registerTrustedHandler(IPC.SAVE_PROTECTED_SETTINGS, tabManager, async (_event, ...args) => {
    assertArgumentCount(args.length, [1]);
    const view = await protectedSettings.applyUpdate(args[0]);
    if (tabManager.botManager) {
      tabManager.botManager.stop();
      tabManager.botManager = null;
    }
    tabManager.killAllRelays();
    tabManager.setUpstreamProxy(protectedSettings.getUpstreamProxy());
    return view;
  });

  registerTrustedHandler(IPC.START_BOT, tabManager, async (_event, ...args) => {
    assertNoArguments(args);
    let settings: BotSettings;
    try {
      settings = protectedSettings.getBotSettings();
    } catch (error) {
      const message = error instanceof ProtectedSettingsError
        ? error.message
        : safeErrorMessage(error, 'Protected VK bot settings');
      return { success: false, error: message };
    }

    if (tabManager.botManager) {
      tabManager.botManager.stop();
      tabManager.botManager = null;
    }

    try {
      const bm = new BotManager(
        settings,
        async (tabConfig) => {
          if (!tabManager.mainWindow || tabManager.mainWindow.isDestroyed()) return;
          const tabId = 'bot-tab-' + Date.now();
          const tab = await tabManager.getOrCreateTab(tabId);
          tab.tunnelMode = tabConfig.mode;
          tab.platform = tabConfig.platform || Platform.VK;
          tab.peerId = tabConfig.peerId;
          tab.isBot = true;
          tabManager.addBotTab(tabId);
          tabManager.mainWindow.webContents.send(IPC.CREATE_BOT_TAB, {
            tabId,
            mode: tabConfig.mode,
            peerId: tabConfig.peerId,
            platform: tabConfig.platform || Platform.VK,
            joinTarget: tabConfig.joinTarget,
          });
          console.log('[BOT] Created tab; mode:', tabConfig.mode, 'platform:', tabConfig.platform);
        },
        () => tabManager.getTabList(),
        (tabId) => {
          tabManager.deleteTab(tabId);
          console.log('[BOT] Closed tab');
          if (tabManager.mainWindow && !tabManager.mainWindow.isDestroyed()) {
            tabManager.mainWindow.webContents.send(IPC.CLOSE_BOT_TAB, { tabId });
          }
        },
        { commandMode: botCommandMode },
      );
      bm.onError = (msg: string) => {
        if (tabManager.mainWindow && !tabManager.mainWindow.isDestroyed()) {
          tabManager.mainWindow.webContents.send(IPC.BOT_ERROR, msg);
        }
      };
      tabManager.botManager = bm;
      const started = await bm.start();
      if (!started) {
        if (tabManager.botManager === bm) tabManager.botManager = null;
        return { success: false };
      }
      return { success: true };
    } catch (error) {
      const message = safeErrorMessage(error, 'VK bot configuration');
      if (tabManager.mainWindow && !tabManager.mainWindow.isDestroyed()) {
        tabManager.mainWindow.webContents.send(IPC.BOT_ERROR, message);
      }
      return { success: false, error: message };
    }
  });

  registerTrustedHandler(IPC.STOP_BOT, tabManager, (_event, ...args) => {
    assertNoArguments(args);
    if (tabManager.botManager) {
      tabManager.botManager.stop();
      tabManager.botManager = null;
    }
    return { success: true };
  });

  registerTrustedHandler(IPC.CLEAR_COOKIES, tabManager, (_event, ...args) => {
    assertArgumentCount(args.length, [1]);
    return tabManager.clearPlatformCookies(assertPlatform(args[0]));
  });

  registerTrustedHandler(IPC.SEND_BOT_CALL_LINK, tabManager, (_event, ...args) => {
    assertArgumentCount(args.length, [2]);
    const tabId = assertTabId(args[0]);
    const result = assertSensitiveResult(args[1]);
    return tabManager.sendBotCallLink(tabId, result);
  });

}
