import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieDomainMatchesRoots } from './cookie-domain-policy';

test('cookie domain policy accepts exact roots and proper subdomains', () => {
  assert.equal(cookieDomainMatchesRoots('vk.com', ['vk.com']), true);
  assert.equal(cookieDomainMatchesRoots('.login.vk.com', ['vk.com']), true);
  assert.equal(cookieDomainMatchesRoots('TELEMOST.YANDEX.RU', ['yandex.ru']), true);
});

test('cookie domain policy rejects lookalikes and parent-domain confusion', () => {
  assert.equal(cookieDomainMatchesRoots('evilvk.com', ['vk.com']), false);
  assert.equal(cookieDomainMatchesRoots('vk.com.evil.example', ['vk.com']), false);
  assert.equal(cookieDomainMatchesRoots('notyandex.ru', ['yandex.ru']), false);
  assert.equal(cookieDomainMatchesRoots('', ['vk.com']), false);
});
