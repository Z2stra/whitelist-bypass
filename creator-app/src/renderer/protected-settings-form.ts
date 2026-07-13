import {
  ProtectedSettingsUpdate,
  ProtectedSettingsView,
  SecretValueUpdate,
} from '../types';

export interface ProtectedSettingsFormValues {
  groupId: string;
  userId: string;
  token: string;
  clearToken: boolean;
  socks: string;
  proxyUsername: string;
  proxyPassword: string;
  clearProxyCredentials: boolean;
}

function tokenUpdate(value: string, clear: boolean): SecretValueUpdate {
  if (clear) return { action: 'clear' };
  const trimmed = value.trim();
  return trimmed ? { action: 'replace', value: trimmed } : { action: 'keep' };
}

function proxyUpdates(
  username: string,
  password: string,
  clear: boolean,
): { username: SecretValueUpdate; password: SecretValueUpdate } {
  if (clear) {
    return { username: { action: 'clear' }, password: { action: 'clear' } };
  }
  if (username.length === 0 && password.length === 0) {
    return { username: { action: 'keep' }, password: { action: 'keep' } };
  }
  return {
    username: { action: 'replace', value: username.trim() },
    password: { action: 'replace', value: password },
  };
}

export function buildProtectedSettingsUpdate(
  values: ProtectedSettingsFormValues,
): ProtectedSettingsUpdate {
  const proxy = proxyUpdates(
    values.proxyUsername,
    values.proxyPassword,
    values.clearProxyCredentials,
  );
  return {
    bot: {
      groupId: values.groupId.trim(),
      userId: values.userId.trim(),
      token: tokenUpdate(values.token, values.clearToken),
    },
    proxy: {
      socks: values.socks.trim(),
      username: proxy.username,
      password: proxy.password,
    },
  };
}

export function protectionSummary(view: ProtectedSettingsView): string {
  if (!view.protection.available) {
    return view.protection.warning || 'OS-protected storage is unavailable.';
  }
  const backend = view.protection.backend === 'windows-dpapi'
    ? 'Windows DPAPI'
    : view.protection.backend;
  if (view.protection.warning) return `${backend}: ${view.protection.warning}`;
  return `Protected by ${backend}. Secrets are not returned to the renderer.`;
}
