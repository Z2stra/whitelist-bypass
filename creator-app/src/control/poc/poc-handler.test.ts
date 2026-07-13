import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePocMessage } from './poc-handler';

const REQUEST_ID = 'req_1234567890abcd';
const NONCE = 'nonce_1234567890abcdef';
const PING = `WLB-POC/1 PING ${REQUEST_ID} ${NONCE}`;

test('handler sends exactly one correlated PONG without logging raw correlation values', async () => {
  const sent: Array<{ peerId: number; text: string }> = [];
  const logs: string[] = [];

  const result = await handlePocMessage({
    text: PING,
    peerId: 123456,
    sendMessage: async (peerId, text) => { sent.push({ peerId, text }); },
    log: (message) => logs.push(message),
  });

  assert.equal(result, 'pong-sent');
  assert.deepEqual(sent, [{
    peerId: 123456,
    text: `WLB-POC/1 PONG ${REQUEST_ID} ${NONCE}`,
  }]);
  const diagnostic = logs.join('\n');
  assert.equal(diagnostic.includes(REQUEST_ID), false);
  assert.equal(diagnostic.includes(NONCE), false);
  assert.match(diagnostic, /accepted request=[a-f0-9]{12}/);
  assert.match(diagnostic, /pong sent request=[a-f0-9]{12}/);
});

test('handler ignores all non-PING input without sending or logging', async () => {
  let sends = 0;
  const logs: string[] = [];

  for (const text of [
    '/vk headless',
    '/close 1234',
    'https://vk.com/call/join/private-room',
    `WLB-POC/1 PONG ${REQUEST_ID} ${NONCE}`,
    `WLB2.${NONCE}`,
  ]) {
    const result = await handlePocMessage({
      text,
      peerId: 123456,
      sendMessage: async () => { sends += 1; },
      log: (message) => logs.push(message),
    });
    assert.equal(result, 'ignored', text);
  }

  assert.equal(sends, 0);
  assert.deepEqual(logs, []);
});

test('handler propagates transport failure instead of reporting a false success', async () => {
  await assert.rejects(
    handlePocMessage({
      text: PING,
      peerId: 123456,
      sendMessage: async () => { throw new Error('synthetic send failure'); },
    }),
    /synthetic send failure/,
  );
});
