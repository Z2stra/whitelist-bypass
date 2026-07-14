import { app, protocol } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { TabManager } from './tab-manager';
import { createWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { resolveBotCommandMode } from '../bot/command-mode';
import { createElectronProtectedSettingsStore } from './electron-protected-settings';
import { runProtectedSettingsSmoke } from './protected-settings-smoke';
import { resolveProtectedStorageSmokeDirectory } from './protected-settings-smoke-policy';
import {
  cleanupStaleCookieDirectories,
  removeLegacyPersistentCookieFiles,
} from './ephemeral-cookie-file';

const tabManager = new TabManager();
const protectedStorageSmokeRequested = process.argv.includes('--protected-storage-smoke');
const protectedStorageSmokeDirectory = resolveProtectedStorageSmokeDirectory(
  protectedStorageSmokeRequested,
  process.env.CREATOR_PROTECTED_STORAGE_SMOKE_DIR,
  os.tmpdir(),
);
if (protectedStorageSmokeDirectory) app.setPath('userData', protectedStorageSmokeDirectory);
const botCommandMode = resolveBotCommandMode(process.argv);

protocol.registerSchemesAsPrivileged([
  { scheme: 'wbstream', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = tabManager.mainWindow;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    if (protectedStorageSmokeRequested && !protectedStorageSmokeDirectory) {
      throw new Error('Protected-storage smoke directory is invalid');
    }

    const protectedSettingsPath = path.join(
      app.getPath('userData'),
      'protected-settings.v1.json',
    );
    const protectedSettings = createElectronProtectedSettingsStore(protectedSettingsPath);
    await protectedSettings.initialize();
    if (protectedStorageSmokeRequested) {
      await runProtectedSettingsSmoke(protectedSettings, protectedSettingsPath);
      console.log('[PROTECTED_SETTINGS_SMOKE] PASS');
      app.exit(0);
      return;
    }
    try {
      tabManager.setUpstreamProxy(protectedSettings.getUpstreamProxy());
    } catch {
      tabManager.setUpstreamProxy({ socks: '', user: '', pass: '' });
    }

    await cleanupStaleCookieDirectories(os.tmpdir(), 0);
    await removeLegacyPersistentCookieFiles(app.getPath('userData'));

    registerIpcHandlers(tabManager, protectedSettings, botCommandMode);
    protocol.handle('wbstream', () => new Response(null, { status: 204 }));
    const win = createWindow(tabManager);
    tabManager.mainWindow = win;
  }).catch(() => {
    if (protectedStorageSmokeRequested) {
      console.error('[PROTECTED_SETTINGS_SMOKE] FAIL');
      app.exit(1);
      return;
    }
    console.error('[MAIN] Creator initialization failed');
    app.quit();
  });
}

let gracefulShutdownStarted = false;

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (gracefulShutdownStarted) return;
  event.preventDefault();
  gracefulShutdownStarted = true;
  void tabManager.stopAllRelaysAndWait()
    .catch(() => tabManager.killAllRelays())
    .finally(() => app.quit());
});

process.on('exit', () => tabManager.killAllRelays());
const exitAfterCleanup = (): void => {
  if (gracefulShutdownStarted) return;
  gracefulShutdownStarted = true;
  void tabManager.stopAllRelaysAndWait()
    .catch(() => tabManager.killAllRelays())
    .finally(() => process.exit());
};
process.on('SIGINT', exitAfterCleanup);
process.on('SIGTERM', exitAfterCleanup);
