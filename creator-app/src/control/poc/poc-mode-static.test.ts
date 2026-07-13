import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('POC routing occurs before legacy payload, link and command parsing', () => {
  const managerSource = source('src/bot/bot-manager.ts');
  const pocBranch = managerSource.indexOf('this.commandMode === BotCommandMode.PocOnly');
  const pocReturn = managerSource.indexOf('return;', pocBranch);
  const payloadParser = managerSource.indexOf('JSON.parse(message.payload)');
  const linkParser = managerSource.indexOf('this.detectJoinLink(text)');
  const legacyParser = managerSource.indexOf('this.handleTextCommand(text, peerId)');

  assert.notEqual(pocBranch, -1);
  assert.ok(pocReturn > pocBranch);
  assert.ok(payloadParser > pocReturn);
  assert.ok(linkParser > pocReturn);
  assert.ok(legacyParser > pocReturn);
});

test('POC mode is selected only by the explicit process flag and reaches BotManager options', () => {
  const indexSource = source('src/main/index.ts');
  const ipcSource = source('src/main/ipc.ts');
  const modeSource = source('src/bot/command-mode.ts');

  assert.match(modeSource, /VK_POC_ONLY_FLAG = '--vk-poc-only'/);
  assert.match(indexSource, /resolveBotCommandMode\(process\.argv\)/);
  assert.match(ipcSource, /\{ commandMode: botCommandMode \}/);
});

test('the POC handler has no operational process, tab, cookie, proxy or filesystem dependency', () => {
  const handlerSource = source('src/control/poc/poc-handler.ts');
  for (const forbidden of [
    'TabManager',
    'onCreateTab',
    'onCloseTab',
    'child_process',
    'cookies',
    'UpstreamProxy',
    "from 'fs'",
    'Platform',
  ]) {
    assert.equal(handlerSource.includes(forbidden), false, forbidden);
  }
  assert.match(
    handlerSource,
    /sendMessage: \(peerId: number, text: string\) => Promise<void>/,
  );
});
