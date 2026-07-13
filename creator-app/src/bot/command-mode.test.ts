import test from 'node:test';
import assert from 'node:assert/strict';
import { BotCommandMode, resolveBotCommandMode, VK_POC_ONLY_FLAG } from './command-mode';

test('bot command mode remains operational without an explicit POC flag', () => {
  assert.equal(resolveBotCommandMode(['electron', '.']), BotCommandMode.Operational);
});

test('bot command mode becomes POC-only only for the exact flag', () => {
  assert.equal(
    resolveBotCommandMode(['WhitelistBypass Creator.exe', VK_POC_ONLY_FLAG]),
    BotCommandMode.PocOnly,
  );
  assert.equal(
    resolveBotCommandMode(['WhitelistBypass Creator.exe', '--vk-poc-only=true']),
    BotCommandMode.Operational,
  );
});
