import { app, BrowserWindow, session, Session, WebContents } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TabManager } from './tab-manager';
import { VkAutoclick } from '../autoclick/vk';
import { TelemostAutoclick } from '../autoclick/telemost';
import { SESSION_PARTITION, USER_AGENT, WINDOW_WIDTH, WINDOW_HEIGHT } from '../constants';
import { Platform } from '../types';
import { parseCallStatus, extractTaggedCallLink } from './util/log-tags';
import { safeErrorMessage } from '../bot/security';
import {
  REMOTE_WEBVIEW_PREFERENCES,
  hardenGuestWebPreferences,
  isAllowedPermission,
  isAllowedPopupUrl,
  isAllowedRemoteUrl,
  isLegacyHookUrl,
  isTrustedAppUrl,
} from './trust-policy';
import {
  WB_DEVICE_ID_STORAGE_KEY,
  isWBDeviceIdSourceUrl,
  normalizeWBDeviceId,
} from './wb-device-id';

const APP_INDEX_PATH = path.join(__dirname, '..', '..', 'index.html');
const APP_INDEX_URL = pathToFileURL(APP_INDEX_PATH).toString();
const WB_DEVICE_ID_POLL_INTERVAL_MS = 1000;
const WB_DEVICE_ID_READ_SCRIPT =
  `window.localStorage.getItem(${JSON.stringify(WB_DEVICE_ID_STORAGE_KEY)})`;

function relaxLegacyCspOnly(ses: Session): void {
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (
      (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') ||
      !isLegacyHookUrl(details.url)
    ) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders: headers });
  });
}

function securePopupOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    show: true,
    webPreferences: {
      partition: SESSION_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  };
}

function installNavigationPolicy(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedRemoteUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedRemoteUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedPopupUrl(url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: securePopupOptions() };
  });
  contents.on('did-create-window', (child) => {
    installNavigationPolicy(child.webContents);
  });
}

function configureRemoteSession(ses: Session): void {
  relaxLegacyCspOnly(ses);
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    callback(isAllowedPermission(permission, requestingUrl));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl || requestingOrigin || webContents?.getURL() || '';
    return isAllowedPermission(permission, requestingUrl);
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.setUserAgent(USER_AGENT);
}

function installRemoteWebviewPolicy(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== SESSION_PARTITION || !isAllowedRemoteUrl(params.src)) {
      event.preventDefault();
      return;
    }

    delete params.preload;
    delete params.nodeintegration;
    delete params.nodeintegrationinsubframes;
    params.webpreferences = REMOTE_WEBVIEW_PREFERENCES;
    hardenGuestWebPreferences(webPreferences);
  });
}

export function createWindow(tabManager: TabManager): BrowserWindow {
  const ses = session.fromPartition(SESSION_PARTITION);
  configureRemoteSession(ses);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  installRemoteWebviewPolicy(win);
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url, APP_INDEX_URL)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.CREATOR_SMOKE_TEST === '1') {
    win.webContents.on('did-finish-load', () => {
      void win.webContents
        .executeJavaScript(`({
          rendererReady: document.documentElement.dataset.creatorRendererReady === 'true',
          requireType: typeof globalThis.require,
          bridgeType: typeof globalThis.bridge,
        })`)
        .then((state: { rendererReady: boolean; requireType: string; bridgeType: string }) => {
          if (
            state.rendererReady &&
            state.requireType === 'undefined' &&
            state.bridgeType === 'undefined'
          ) {
            console.log('[CREATOR_SMOKE] PASS');
            return;
          }
          console.error('[CREATOR_SMOKE] FAIL');
        })
        .catch(() => {
          console.error('[CREATOR_SMOKE] FAIL');
        });
    });
  }

  void win.loadFile(APP_INDEX_PATH);
  win.on('closed', () => {
    tabManager.mainWindow = null;
  });

  const autoclickers = new Map<number, { telemost: TelemostAutoclick; vk: VkAutoclick }>();
  const wbDeviceIdPollers = new Map<number, ReturnType<typeof setInterval>>();
  const wbDeviceIdReads = new Set<number>();

  const stopWBDeviceIdPolling = (contentsId: number): void => {
    const timer = wbDeviceIdPollers.get(contentsId);
    if (timer) clearInterval(timer);
    wbDeviceIdPollers.delete(contentsId);
  };

  const captureWBDeviceId = async (contents: WebContents): Promise<void> => {
    if (contents.isDestroyed() || !isWBDeviceIdSourceUrl(contents.getURL())) return;
    if (wbDeviceIdReads.has(contents.id)) return;
    wbDeviceIdReads.add(contents.id);
    try {
      const value = await contents.executeJavaScript(WB_DEVICE_ID_READ_SCRIPT, true);
      if (!isWBDeviceIdSourceUrl(contents.getURL())) return;
      const deviceId = normalizeWBDeviceId(value);
      if (deviceId) await tabManager.setWBStreamDeviceId(deviceId);
    } catch {
      // The page can navigate or be destroyed between the origin check and the read.
    } finally {
      wbDeviceIdReads.delete(contents.id);
    }
  };

  const syncWBDeviceIdPolling = (contents: WebContents): void => {
    stopWBDeviceIdPolling(contents.id);
    if (contents.isDestroyed() || !isWBDeviceIdSourceUrl(contents.getURL())) return;
    void captureWBDeviceId(contents);
    const timer = setInterval(() => {
      void captureWBDeviceId(contents);
    }, WB_DEVICE_ID_POLL_INTERVAL_MS);
    wbDeviceIdPollers.set(contents.id, timer);
  };

  win.webContents.on('did-attach-webview', (_event, wvContents) => {
    if (!isAllowedRemoteUrl(wvContents.getURL())) {
      wvContents.close();
      return;
    }

    installNavigationPolicy(wvContents);

    if (!app.isPackaged) {
      wvContents.on('before-input-event', (_inputEvent, input) => {
        if (input.key === 'F12') wvContents.openDevTools();
      });
    }

    wvContents.on('dom-ready', () => {
      syncWBDeviceIdPolling(wvContents);
    });

    wvContents.on('did-navigate', (_navigateEvent, url) => {
      if (!isAllowedRemoteUrl(url)) return;
      syncWBDeviceIdPolling(wvContents);
      const wcId = wvContents.id;
      if (!autoclickers.has(wcId)) {
        autoclickers.set(wcId, {
          telemost: new TelemostAutoclick(),
          vk: new VkAutoclick(),
        });
      }
      const ac = autoclickers.get(wcId)!;
      if (url.includes('telemost.yandex')) {
        ac.vk.stop();
        ac.telemost.attach(wvContents);
      } else if (url.includes('vk.com')) {
        ac.telemost.stop();
        ac.vk.attach(wvContents);
      } else {
        ac.telemost.stop();
        ac.vk.stop();
      }
    });

    wvContents.on('did-navigate-in-page', () => {
      syncWBDeviceIdPolling(wvContents);
    });

    wvContents.on('console-message', (_consoleEvent, _level, msg) => {
      if (msg.includes('state: disconnected') || msg.includes('state: failed')) {
        const ac = autoclickers.get(wvContents.id);
        if (ac) ac.vk.kickDisconnected();
      }

      handleBotCallLink(tabManager, msg, Platform.VK);
      handleBotCallLink(tabManager, msg, Platform.Telemost);

      const callStatus = parseCallStatus(msg);
      if (callStatus) {
        console.log('[MAIN] Cached call status update');
        tabManager.setCallStatus(callStatus.tabId, callStatus.status);
      }
    });

    wvContents.on('destroyed', () => {
      stopWBDeviceIdPolling(wvContents.id);
      wbDeviceIdReads.delete(wvContents.id);
      const ac = autoclickers.get(wvContents.id);
      if (ac) {
        ac.telemost.stop();
        ac.vk.stop();
        autoclickers.delete(wvContents.id);
      }
    });
  });

  return win;
}

function handleBotCallLink(tabManager: TabManager, msg: string, platform: Platform): void {
  const tagged = extractTaggedCallLink(msg, platform);
  if (!tagged) return;
  const tab = tabManager.getTab(tagged.tabId);
  if (!tab || tab.peerId == null) {
    console.log(`[MAIN] ${platform} call link captured without an associated peer`);
    return;
  }
  void tabManager
    .sendBotCallLink(tagged.tabId, tagged.link)
    .catch((error) => console.error(safeErrorMessage(error, 'Legacy bot link delivery')));
}
