import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWBDeviceIdSourceUrl,
  normalizeWBDeviceId,
} from './wb-device-id';

test('WB device IDs are accepted only as bounded printable non-space strings', () => {
  assert.equal(normalizeWBDeviceId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(normalizeWBDeviceId('abc_DEF-123.456'), 'abc_DEF-123.456');
  assert.equal(normalizeWBDeviceId(''), null);
  assert.equal(normalizeWBDeviceId('contains space'), null);
  assert.equal(normalizeWBDeviceId('contains\nnewline'), null);
  assert.equal(normalizeWBDeviceId('x'.repeat(513)), null);
  assert.equal(normalizeWBDeviceId({ value: 'not-a-string' }), null);
});

test('WB device ID reads are restricted to the exact HTTPS WB Stream origin', () => {
  assert.equal(isWBDeviceIdSourceUrl('https://stream.wb.ru/room/example'), true);
  assert.equal(isWBDeviceIdSourceUrl('https://stream.wb.ru:443/room/example'), true);
  assert.equal(isWBDeviceIdSourceUrl('http://stream.wb.ru/'), false);
  assert.equal(isWBDeviceIdSourceUrl('https://stream.wb.ru:8443/'), false);
  assert.equal(isWBDeviceIdSourceUrl('https://user:pass@stream.wb.ru/'), false);
  assert.equal(isWBDeviceIdSourceUrl('https://evilstream.wb.ru/'), false);
  assert.equal(isWBDeviceIdSourceUrl('https://stream.wb.ru.evil.example/'), false);
  assert.equal(isWBDeviceIdSourceUrl('not a url'), false);
});
