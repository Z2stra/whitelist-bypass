import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHeadlessProcessLine,
  parseHeadlessProcessEvent,
  ProcessLineBuffer,
} from './headless-process-events';

test('ProcessLineBuffer preserves a marker split across output chunks', () => {
  const buffer = new ProcessLineBuffer();

  assert.deepEqual(buffer.push('CALL CREATED\r\njoin_li'), ['CALL CREATED']);
  assert.deepEqual(buffer.push('nk: https://vk.com/call/join/private-room\nprotocol: quic'), [
    'join_link: https://vk.com/call/join/private-room',
  ]);
  assert.deepEqual(buffer.flush(), ['protocol: quic']);
  assert.deepEqual(buffer.flush(), []);
});

test('join link remains available only in the typed functional event', () => {
  const link = 'https://vk.com/call/join/private-room?key=secret-value';
  const classified = classifyHeadlessProcessLine(`join_link: ${link}`);

  assert.deepEqual(classified.event, { type: 'join-link', link });
  assert.equal(classified.diagnostic, 'join_link: <redacted>');
  assert.equal(classified.diagnostic.includes('private-room'), false);
  assert.equal(classified.diagnostic.includes('secret-value'), false);
});

test('TURN value is typed but redacted from diagnostics', () => {
  const classified = classifyHeadlessProcessLine('TURN: turn:user:password@host');

  assert.deepEqual(classified.event, { type: 'turn', value: 'turn:user:password@host' });
  assert.equal(classified.diagnostic, 'TURN: <redacted>');
});

test('unknown process lines still pass through generic secret redaction', () => {
  const classified = classifyHeadlessProcessLine(
    'request failed https://example.test/private?access_token=token-secret',
  );

  assert.equal(classified.event, null);
  assert.equal(classified.diagnostic.includes('token-secret'), false);
  assert.equal(classified.diagnostic.includes('https://'), false);
});

test('fatal event exposes only a redacted UI-safe message', () => {
  const classified = classifyHeadlessProcessLine(
    '[FATAL] failed https://dion.vc/event/private-slug token=secret-token',
  );

  assert.deepEqual(classified.event, {
    type: 'fatal',
    message: 'failed <redacted-url> token=<redacted>',
  });
  assert.equal(classified.diagnostic, '[FATAL] failed <redacted-url> token=<redacted>');
});

test('fatal marker without details still produces a safe terminal event', () => {
  assert.deepEqual(parseHeadlessProcessEvent('[FATAL]'), {
    type: 'fatal',
    message: 'fatal error',
  });
});

test('known non-sensitive markers become typed events', () => {
  assert.deepEqual(parseHeadlessProcessEvent('CALL CREATED'), { type: 'call-created' });
  assert.deepEqual(parseHeadlessProcessEvent('protocol: quic'), {
    type: 'protocol',
    value: 'quic',
  });
  assert.deepEqual(parseHeadlessProcessEvent('TUNNEL CONNECTED'), {
    type: 'tunnel-connected',
  });
});
