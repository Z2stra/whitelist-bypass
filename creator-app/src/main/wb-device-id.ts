export const WB_DEVICE_ID_STORAGE_KEY = 'wb_auth_api_device_id';
const MAX_WB_DEVICE_ID_LENGTH = 512;

export function normalizeWBDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_WB_DEVICE_ID_LENGTH) return null;
  if (!/^[\x21-\x7E]+$/.test(value)) return null;
  return value;
}

export function isWBDeviceIdSourceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'stream.wb.ru';
  } catch {
    return false;
  }
}
