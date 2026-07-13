import { safeStorage } from 'electron';
import {
  ProtectedSettingsCipher,
  ProtectedSettingsStore,
} from './protected-settings';
import { evaluateSafeStorageStatus } from './safe-storage-policy';

export function createElectronProtectedSettingsStore(filePath: string): ProtectedSettingsStore {
  const cipher: ProtectedSettingsCipher = {
    status() {
      let linuxBackend: string | undefined;
      if (process.platform === 'linux') {
        try {
          linuxBackend = safeStorage.getSelectedStorageBackend();
        } catch {
          linuxBackend = 'unknown';
        }
      }
      return evaluateSafeStorageStatus(
        process.platform,
        safeStorage.isEncryptionAvailable(),
        linuxBackend,
      );
    },
    encrypt(plainText: string) {
      return safeStorage.encryptString(plainText);
    },
    decrypt(encrypted: Buffer) {
      return safeStorage.decryptString(encrypted);
    },
  };
  return new ProtectedSettingsStore(filePath, cipher);
}
