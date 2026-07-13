import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POC_MESSAGE_LENGTH,
  formatPocPong,
  parsePocPing,
} from './poc-protocol';

const REQUEST_ID = 'req_1234567890abcd';
const NONCE = 'nonce_1234567890abcdef';
const VALID_PING = `WLB-POC/1 PING ${REQUEST_ID} ${NONCE}`;

test('valid WLB-POC/1 PING parses and produces a correlated PONG', () => {
  const ping = parsePocPing(VALID_PING);
  assert.deepEqual(ping, { requestId: REQUEST_ID, nonce: NONCE });
  assert.equal(
    formatPocPong(ping!),
    `WLB-POC/1 PONG ${REQUEST_ID} ${NONCE}`,
  );
});

test('parser rejects wrong versions, directions, spacing and extra fields', () => {
  for (const value of [
    `WLB-POC/2 PING ${REQUEST_ID} ${NONCE}`,
    `WLB-POC/1 PONG ${REQUEST_ID} ${NONCE}`,
    ` WLB-POC/1 PING ${REQUEST_ID} ${NONCE}`,
    `WLB-POC/1 PING ${REQUEST_ID} ${NONCE} `,
    `WLB-POC/1  PING ${REQUEST_ID} ${NONCE}`,
    `WLB-POC/1 PING ${REQUEST_ID} ${NONCE} extra`,
  ]) {
    assert.equal(parsePocPing(value), null, value);
  }
});

test('parser rejects malformed identifiers and control characters', () => {
  for (const value of [
    'WLB-POC/1 PING short nonce_1234567890abcdef',
    `WLB-POC/1 PING ${REQUEST_ID} short`,
    `WLB-POC/1 PING request+not_base64url ${NONCE}`,
    `WLB-POC/1 PING ${REQUEST_ID} nonce+not_base64url`,
    `WLB-POC/1 PING ${REQUEST_ID}\n${NONCE}`,
    `WLB-POC/1 PING ${REQUEST_ID}\t${NONCE}`,
  ]) {
    assert.equal(parsePocPing(value), null, value);
  }
});

test('parser rejects non-string and oversized input', () => {
  assert.equal(parsePocPing(null), null);
  assert.equal(parsePocPing({}), null);
  assert.equal(parsePocPing('x'.repeat(MAX_POC_MESSAGE_LENGTH + 1)), null);
});
