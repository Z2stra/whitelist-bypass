export const WLB_POC_VERSION = 'WLB-POC/1';
export const MAX_POC_MESSAGE_LENGTH = 256;
export const MIN_POC_REQUEST_ID_LENGTH = 16;
export const MAX_POC_REQUEST_ID_LENGTH = 64;
export const MIN_POC_NONCE_LENGTH = 16;
export const MAX_POC_NONCE_LENGTH = 128;

const REQUEST_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${MIN_POC_REQUEST_ID_LENGTH},${MAX_POC_REQUEST_ID_LENGTH}}$`,
);
const NONCE_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${MIN_POC_NONCE_LENGTH},${MAX_POC_NONCE_LENGTH}}$`,
);

export interface PocPing {
  requestId: string;
  nonce: string;
}

export function parsePocPing(value: unknown): PocPing | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_POC_MESSAGE_LENGTH) {
    return null;
  }
  if (value !== value.trim() || /[\x00-\x1F\x7F]/.test(value)) return null;

  const parts = value.split(' ');
  if (parts.length !== 4) return null;
  if (parts[0] !== WLB_POC_VERSION || parts[1] !== 'PING') return null;

  const requestId = parts[2];
  const nonce = parts[3];
  if (!REQUEST_ID_PATTERN.test(requestId) || !NONCE_PATTERN.test(nonce)) return null;

  return { requestId, nonce };
}

export function formatPocPong(ping: PocPing): string {
  return `${WLB_POC_VERSION} PONG ${ping.requestId} ${ping.nonce}`;
}
