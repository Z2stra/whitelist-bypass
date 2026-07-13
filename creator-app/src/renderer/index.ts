import { RendererTabManager } from './tab-manager';
import {
  renderTabs,
  renderContent,
  renderBotButton,
  loadURL,
  startHookLogPoller,
  showError,
  closeError,
  clearLog,
  saveLogs,
  copyToClipboard,
  renameTab,
  attachLoginWebview,
  detachLoginWebview,
} from './dom';
import { VK_IM_URL, TELEMOST_URL } from '../constants';
import {
  buildProtectedSettingsUpdate,
  protectionSummary,
} from './protected-settings-form';
import {
  Platform,
  Bridge,
  BotTabData,
  LogPanel,
  TunnelMode,
  HeadlessMode,
  HeadlessProcessEvent,
} from '../types';

declare const window: Window & { bridge: Bridge };

const tm = new RendererTabManager(() => {
  renderTabs(tm);
  renderContent(tm);
  renderBotButton(tm);
});

function bindTabBarEvents(): void {
  document.getElementById('tabBar')!.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.dataset.action;
    const tabEl = target.closest('[data-tab-id]') as HTMLElement | null;
    const tabId = tabEl?.dataset.tabId;

    if (action === 'add-tab') {
      tm.createTab();
      return;
    }
    if (action === 'close' && tabId) {
      event.stopPropagation();
      tm.closeTab(tabId);
      return;
    }
    if (action === 'rename' && tabId) {
      event.stopPropagation();
      renameTab(tm, tabId, tabEl!);
      return;
    }
    if (tabId) {
      tm.selectTab(tabId);
    }
  });
}

function bindToolbarEvents(): void {
  document.getElementById('btnVk')!.addEventListener('click', () => loadURL(tm, VK_IM_URL));
  document.getElementById('btnTelemost')!.addEventListener('click', () => loadURL(tm, TELEMOST_URL));
  document.getElementById('btnHeadlessVK')!.addEventListener('click', () => tm.switchToHeadless(Platform.VK));
  document.getElementById('btnHeadlessTM')!.addEventListener('click', () => tm.switchToHeadless(Platform.Telemost));
  document.getElementById('btnHeadlessWB')!.addEventListener('click', () => tm.switchToHeadless(Platform.WBStream));
  document.getElementById('btnHeadlessDion')!.addEventListener('click', () => tm.switchToHeadless(Platform.Dion));
  document.getElementById('modeSelect')!.addEventListener('change', (event) => {
    tm.setTunnelMode((event.target as HTMLSelectElement).value);
  });
  document.getElementById('btnSaveLogs')!.addEventListener('click', saveLogs);
}

function bindActionBarEvents(): void {
  document.getElementById('btnSettings')!.addEventListener('click', () => {
    void openSettings();
  });
  document.getElementById('tabBot')!.addEventListener('click', () => {
    void (async () => {
      if (!tm.hasBotConfiguration()) {
        await openSettings();
        return;
      }
      try {
        await tm.toggleBot();
      } catch (error) {
        showError(error instanceof Error ? error.message : 'VK bot operation failed.');
      }
    })();
  });
}

function bindSettingsEvents(): void {
  document.getElementById('btnSettingsCancel')!.addEventListener('click', closeSettings);
  const tokenInput = document.getElementById('vkToken') as HTMLInputElement;
  const clearToken = document.getElementById('clearVkToken') as HTMLInputElement;
  const proxyUser = document.getElementById('upstreamUser') as HTMLInputElement;
  const proxyPass = document.getElementById('upstreamPass') as HTMLInputElement;
  const clearProxy = document.getElementById('clearUpstreamCredentials') as HTMLInputElement;

  clearToken.addEventListener('change', () => {
    tokenInput.disabled = clearToken.checked;
    if (clearToken.checked) tokenInput.value = '';
  });
  clearProxy.addEventListener('change', () => {
    proxyUser.disabled = clearProxy.checked;
    proxyPass.disabled = clearProxy.checked;
    if (clearProxy.checked) {
      proxyUser.value = '';
      proxyPass.value = '';
    }
  });

  document.getElementById('btnSettingsSave')!.addEventListener('click', () => {
    void (async () => {
      const saveButton = document.getElementById('btnSettingsSave') as HTMLButtonElement;
      saveButton.disabled = true;
      try {
        const update = buildProtectedSettingsUpdate({
          token: tokenInput.value,
          clearToken: clearToken.checked,
          groupId: (document.getElementById('vkGroupId') as HTMLInputElement).value,
          userId: (document.getElementById('vkUserId') as HTMLInputElement).value,
          socks: (document.getElementById('upstreamSocks') as HTMLInputElement).value,
          proxyUsername: proxyUser.value,
          proxyPassword: proxyPass.value,
          clearProxyCredentials: clearProxy.checked,
        });
        await tm.saveProtectedSettings(update);
        tokenInput.value = '';
        proxyUser.value = '';
        proxyPass.value = '';
        closeSettings();
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Protected settings could not be saved.');
      } finally {
        saveButton.disabled = false;
      }
    })();
  });

  document.querySelectorAll('.btn-clear-cookies').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const platform = (btn as HTMLElement).dataset.platform!;
      const status = document.getElementById('clearCookiesStatus')!;
      status.textContent = `Clearing ${platform} cookies...`;
      try {
        const removed = await window.bridge.clearCookies(platform);
        status.textContent = `Cleared ${removed} ${platform} cookies. Log in again to use it.`;
      } catch {
        status.textContent = `Failed to clear ${platform} cookies.`;
      }
    });
  });
}

function bindErrorPopup(): void {
  document.getElementById('errorPopup')!.addEventListener('click', closeError);
  document.querySelector('#errorPopup .popup')!.addEventListener('click', (event) => event.stopPropagation());
  document.getElementById('btnErrorClose')!.addEventListener('click', closeError);
}

function bindLogEvents(): void {
  document.getElementById('btnClearRelay')!.addEventListener('click', () => clearLog(LogPanel.Relay));
  document.getElementById('btnClearHook')!.addEventListener('click', () => clearLog(LogPanel.Hook));
  document.getElementById('btnSaveLogsHeadless')!.addEventListener('click', saveLogs);
}

function bindHeadlessEvents(): void {
  document.getElementById('headlessJoinLink')!.addEventListener('click', (event) => {
    copyToClipboard((event.target as HTMLElement).textContent || '');
  });
  document.getElementById('headlessInfo')!.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const copyTarget = target.dataset.copy;
    if (copyTarget) {
      const sourceEl = document.getElementById(copyTarget);
      if (sourceEl) copyToClipboard(sourceEl.textContent || '');
    }
  });
  document.getElementById('btnHeadlessCreate')!.addEventListener('click', () => {
    clearHeadlessJoinError();
    tm.startHeadlessCall({ mode: HeadlessMode.Create });
  });
  document.getElementById('btnHeadlessJoin')!.addEventListener('click', () => {
    const targetInput = document.getElementById('headlessStartTarget') as HTMLInputElement;
    const target = targetInput.value.trim();
    if (!target) {
      showHeadlessJoinError('Enter a room or link to join.');
      targetInput.focus();
      return;
    }
    clearHeadlessJoinError();
    tm.startHeadlessCall({ mode: HeadlessMode.Join, target });
  });
  document.getElementById('headlessStartTarget')!.addEventListener('input', (event) => {
    const tab = tm.getActiveTab();
    if (tab) tab.headlessStartTarget = (event.target as HTMLInputElement).value;
    clearHeadlessJoinError();
  });
}

function showHeadlessJoinError(msg: string): void {
  const errEl = document.getElementById('headlessStartError')!;
  const input = document.getElementById('headlessStartTarget') as HTMLInputElement;
  errEl.textContent = msg;
  input.classList.add('invalid');
}

function clearHeadlessJoinError(): void {
  const errEl = document.getElementById('headlessStartError')!;
  const input = document.getElementById('headlessStartTarget') as HTMLInputElement;
  errEl.textContent = '';
  input.classList.remove('invalid');
}

async function openSettings(): Promise<void> {
  try {
    await tm.refreshProtectedSettings();
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Protected settings could not be loaded.');
    return;
  }

  const view = tm.settingsView;
  const tokenInput = document.getElementById('vkToken') as HTMLInputElement;
  const proxyUser = document.getElementById('upstreamUser') as HTMLInputElement;
  const proxyPass = document.getElementById('upstreamPass') as HTMLInputElement;
  const clearToken = document.getElementById('clearVkToken') as HTMLInputElement;
  const clearProxy = document.getElementById('clearUpstreamCredentials') as HTMLInputElement;

  tokenInput.value = '';
  tokenInput.placeholder = view.bot.tokenConfigured
    ? 'Stored securely — leave blank to keep'
    : 'vk1.a.xxx...';
  proxyUser.value = '';
  proxyUser.placeholder = view.proxy.usernameConfigured
    ? 'Stored securely — re-enter both fields to replace'
    : 'optional';
  proxyPass.value = '';
  proxyPass.placeholder = view.proxy.passwordConfigured
    ? 'Stored securely — re-enter both fields to replace'
    : 'optional';
  clearToken.checked = false;
  clearProxy.checked = false;
  tokenInput.disabled = false;
  proxyUser.disabled = false;
  proxyPass.disabled = false;

  (document.getElementById('vkGroupId') as HTMLInputElement).value = view.bot.groupId;
  (document.getElementById('vkUserId') as HTMLInputElement).value = view.bot.userId;
  (document.getElementById('upstreamSocks') as HTMLInputElement).value = view.proxy.socks;
  document.getElementById('protectedSettingsStatus')!.textContent = protectionSummary(view);
  document.getElementById('clearCookiesStatus')!.textContent = '';
  (document.getElementById('btnSettingsSave') as HTMLButtonElement).disabled =
    !view.protection.available;
  document.getElementById('settingsPopup')!.classList.add('visible');
}

function clearTransientSecretInputs(): void {
  const tokenInput = document.getElementById('vkToken') as HTMLInputElement;
  const proxyUser = document.getElementById('upstreamUser') as HTMLInputElement;
  const proxyPass = document.getElementById('upstreamPass') as HTMLInputElement;
  const clearToken = document.getElementById('clearVkToken') as HTMLInputElement;
  const clearProxy = document.getElementById('clearUpstreamCredentials') as HTMLInputElement;
  tokenInput.value = '';
  proxyUser.value = '';
  proxyPass.value = '';
  clearToken.checked = false;
  clearProxy.checked = false;
  tokenInput.disabled = false;
  proxyUser.disabled = false;
  proxyPass.disabled = false;
}

function closeSettings(): void {
  clearTransientSecretInputs();
  document.getElementById('settingsPopup')!.classList.remove('visible');
}

async function init(): Promise<void> {
  bindTabBarEvents();
  bindToolbarEvents();
  bindActionBarEvents();
  bindSettingsEvents();
  bindErrorPopup();
  bindLogEvents();
  bindHeadlessEvents();

  await tm.initializeProtectedSettings();

  window.bridge.onRelayLog((tabId: string, msg: string) => {
    tm.appendRelayLog(tabId, msg);
  });

  window.bridge.onHeadlessEvent((tabId: string, event: HeadlessProcessEvent) => {
    tm.handleHeadlessEvent(tabId, event);
  });

  window.bridge.onBotError((msg: string) => {
    showError(msg);
    tm.botRunning = false;
    localStorage.setItem('botEnabled', 'false');
    renderBotButton(tm);
  });

  window.bridge.onCreateBotTab((data: BotTabData) => {
    tm.createBotTab(data);
    (document.getElementById('modeSelect') as HTMLSelectElement).value = data.mode;
    if (data.mode === TunnelMode.HeadlessVK) {
      tm.switchToHeadless(Platform.VK, data.joinTarget);
    } else if (data.mode === TunnelMode.HeadlessTelemost) {
      tm.switchToHeadless(Platform.Telemost, data.joinTarget);
    } else if (data.mode === TunnelMode.HeadlessWBStream) {
      tm.switchToHeadless(Platform.WBStream, data.joinTarget);
    } else if (data.mode === TunnelMode.HeadlessDion) {
      tm.switchToHeadless(Platform.Dion, data.joinTarget);
    } else {
      const url = data.platform === Platform.Telemost ? TELEMOST_URL : VK_IM_URL;
      loadURL(tm, url);
    }
  });

  window.bridge.onCloseBotTab((data: { tabId: string }) => {
    tm.closeTab(data.tabId);
  });

  window.bridge.onLoginRequired((tabId: string, url: string) => {
    const tab = tm.tabs[tabId];
    if (!tab) return;
    tab.headlessStatus = 'Waiting for login...';
    attachLoginWebview(tm, tabId, url);
    if (tabId === tm.activeTabId) {
      renderTabs(tm);
      renderContent(tm);
    }
  });

  window.bridge.onLoginDone((tabId: string) => {
    const tab = tm.tabs[tabId];
    if (!tab) return;
    detachLoginWebview(tm, tabId);
    tab.headlessStatus = 'Starting...';
    if (tabId === tm.activeTabId) renderContent(tm);
  });

  startHookLogPoller(tm);
  await tm.autoStartBot();
  renderBotButton(tm);
}

void init().catch((error) => {
  showError(error instanceof Error ? error.message : 'Creator initialization failed.');
});
