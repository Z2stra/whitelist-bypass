import { ProtectedSettingsCipherStatus } from './protected-settings';

export function evaluateSafeStorageStatus(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  linuxBackend?: string,
): ProtectedSettingsCipherStatus {
  if (!encryptionAvailable) {
    return {
      available: false,
      backend: platform === 'win32' ? 'windows-dpapi' : 'unavailable',
      reason: 'OS-protected encryption is unavailable',
    };
  }

  if (platform === 'linux') {
    const backend = linuxBackend || 'unknown';
    if (backend === 'basic_text' || backend === 'unknown') {
      return {
        available: false,
        backend,
        reason: 'A secure Linux secret store is unavailable; plaintext fallback is refused',
      };
    }
    return { available: true, backend };
  }

  if (platform === 'win32') return { available: true, backend: 'windows-dpapi' };
  if (platform === 'darwin') return { available: true, backend: 'macos-keychain' };
  return { available: false, backend: 'unsupported', reason: 'This platform is unsupported' };
}
