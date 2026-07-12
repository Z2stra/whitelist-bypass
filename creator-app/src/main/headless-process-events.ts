import { redactSensitiveText, REDACTED } from '../bot/security';
import { HeadlessLogMarker } from '../constants';
import { HeadlessProcessEvent } from '../types';

export interface ClassifiedHeadlessLine {
  event: HeadlessProcessEvent | null;
  diagnostic: string;
}

export class ProcessLineBuffer {
  private pending = '';

  push(chunk: Buffer | string): string[] {
    const combined = this.pending + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    const lines = combined.split(/\r\n|\n|\r/);
    this.pending = lines.pop() ?? '';
    return lines;
  }

  flush(): string[] {
    const line = this.pending;
    this.pending = '';
    return line ? [line] : [];
  }
}

function valueAfterMarker(line: string, marker: string): string | null {
  const index = line.indexOf(marker);
  if (index < 0) return null;
  const value = line.slice(index + marker.length).trim();
  return value || null;
}

export function parseHeadlessProcessEvent(rawLine: string): HeadlessProcessEvent | null {
  const line = rawLine.trim();
  if (!line) return null;

  if (line === HeadlessLogMarker.CALL_CREATED) {
    return { type: 'call-created' };
  }

  const joinLink = valueAfterMarker(line, HeadlessLogMarker.JOIN_LINK);
  if (joinLink) {
    return { type: 'join-link', link: joinLink };
  }

  const turn = valueAfterMarker(line, HeadlessLogMarker.TURN);
  if (turn) {
    return { type: 'turn', value: turn };
  }

  const protocol = valueAfterMarker(line, HeadlessLogMarker.PROTOCOL);
  if (protocol) {
    return { type: 'protocol', value: protocol };
  }

  if (line.includes(HeadlessLogMarker.TUNNEL_CONNECTED)) {
    return { type: 'tunnel-connected' };
  }

  if (line.includes('[FATAL]')) {
    const fatal = valueAfterMarker(line, '[FATAL]') || 'fatal error';
    return { type: 'fatal', message: redactSensitiveText(fatal) };
  }

  return null;
}

export function classifyHeadlessProcessLine(rawLine: string): ClassifiedHeadlessLine {
  const line = rawLine.trim();
  const event = parseHeadlessProcessEvent(line);

  if (event?.type === 'join-link') {
    return {
      event,
      diagnostic: `${HeadlessLogMarker.JOIN_LINK} ${REDACTED}`,
    };
  }

  if (event?.type === 'turn') {
    return {
      event,
      diagnostic: `${HeadlessLogMarker.TURN} ${REDACTED}`,
    };
  }

  if (event?.type === 'fatal') {
    return {
      event,
      diagnostic: `[FATAL] ${event.message}`,
    };
  }

  return {
    event,
    diagnostic: redactSensitiveText(line),
  };
}
