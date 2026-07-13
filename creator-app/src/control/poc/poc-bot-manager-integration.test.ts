import test from 'node:test';
import assert from 'node:assert/strict';
import { BotManager } from '../../bot/bot-manager';
import { BotCommandMode } from '../../bot/command-mode';
import { BotSettings, TabConfig } from '../../types';

const SETTINGS: BotSettings = {
  token: 'community-secret-token',
  groupId: '42',
  userId: '123456',
};
const REQUEST_ID = 'req_1234567890abcd';
const NONCE = 'nonce_1234567890abcdef';
const PING = `WLB-POC/1 PING ${REQUEST_ID} ${NONCE}`;

type PrivateManager = {
  handleUpdate(update: unknown): Promise<void>;
  sendMessage(peerId: number, text: string): Promise<void>;
};

function messageUpdate(
  text: string,
  fromId = 123456,
  peerId = fromId,
  payload?: string,
): unknown {
  return {
    type: 'message_new',
    object: { message: { from_id: fromId, peer_id: peerId, text, payload } },
  };
}

async function captureConsole(run: () => Promise<void>): Promise<string> {
  const output: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]) => output.push(args.map(String).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return output.join('\n');
}

test('POC-only mode sends a correlated PONG and never invokes operational callbacks', async () => {
  const created: TabConfig[] = [];
  let listCalls = 0;
  let closeCalls = 0;
  const sent: Array<{ peerId: number; text: string }> = [];

  const manager = new BotManager(
    SETTINGS,
    (config) => { created.push(config); },
    () => { listCalls += 1; return []; },
    () => { closeCalls += 1; },
    { commandMode: BotCommandMode.PocOnly },
  );
  const privateManager = manager as unknown as PrivateManager;
  privateManager.sendMessage = async (peerId, text) => { sent.push({ peerId, text }); };

  const logs = await captureConsole(async () => {
    await privateManager.handleUpdate(messageUpdate(PING));
    await privateManager.handleUpdate(messageUpdate('/vk headless'));
    await privateManager.handleUpdate(messageUpdate('/close deadbeef'));
    await privateManager.handleUpdate(messageUpdate('https://vk.com/call/join/private-room'));
    await privateManager.handleUpdate(messageUpdate('', 123456, 123456, JSON.stringify({ cmd: 'vk', mode: 'headless' })));
  });

  assert.deepEqual(sent, [{
    peerId: 123456,
    text: `WLB-POC/1 PONG ${REQUEST_ID} ${NONCE}`,
  }]);
  assert.deepEqual(created, []);
  assert.equal(listCalls, 0);
  assert.equal(closeCalls, 0);
  assert.equal(logs.includes(REQUEST_ID), false);
  assert.equal(logs.includes(NONCE), false);
  assert.equal(logs.includes('private-room'), false);
});

test('POC-only mode still requires the allowlisted private dialog', async () => {
  const sent: string[] = [];
  const manager = new BotManager(
    SETTINGS,
    () => {},
    () => [],
    () => {},
    { commandMode: BotCommandMode.PocOnly },
  );
  const privateManager = manager as unknown as PrivateManager;
  privateManager.sendMessage = async (_peerId, text) => { sent.push(text); };

  await privateManager.handleUpdate(messageUpdate(PING, 999999, 999999));
  await privateManager.handleUpdate(messageUpdate(PING, 123456, 2000000001));

  assert.deepEqual(sent, []);
});

test('POC-only mode propagates PONG delivery failure', async () => {
  const manager = new BotManager(
    SETTINGS,
    () => {},
    () => [],
    () => {},
    { commandMode: BotCommandMode.PocOnly },
  );
  const privateManager = manager as unknown as PrivateManager;
  privateManager.sendMessage = async () => { throw new Error('synthetic PONG failure'); };

  await assert.rejects(
    privateManager.handleUpdate(messageUpdate(PING)),
    /synthetic PONG failure/,
  );
});
