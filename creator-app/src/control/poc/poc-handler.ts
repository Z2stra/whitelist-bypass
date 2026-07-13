import { createHash } from 'crypto';
import { formatPocPong, parsePocPing } from './poc-protocol';

export type PocHandleResult = 'ignored' | 'pong-sent';

export interface PocHandlerInput {
  text: unknown;
  peerId: number;
  sendMessage: (peerId: number, text: string) => Promise<void>;
  log?: (message: string) => void;
}

function requestFingerprint(requestId: string): string {
  return createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 12);
}

export async function handlePocMessage(input: PocHandlerInput): Promise<PocHandleResult> {
  const ping = parsePocPing(input.text);
  if (!ping) return 'ignored';

  const fingerprint = requestFingerprint(ping.requestId);
  input.log?.(`accepted request=${fingerprint}`);
  await input.sendMessage(input.peerId, formatPocPong(ping));
  input.log?.(`pong sent request=${fingerprint}`);
  return 'pong-sent';
}
