import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestInit, Response } from 'node-fetch';
import { BotManager, BotManagerOptions, calculateBackoffMs } from './bot-manager';
import { BotSettings, Platform, TabConfig } from '../types';

const SETTINGS: BotSettings = {
  token: 'community-secret-token',
  groupId: '42',
  userId: '123456',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): Error {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}

function createManager(
  options: BotManagerOptions,
  onCreateTab: (config: TabConfig) => Promise<void> | void = () => {},
): BotManager {
  return new BotManager(SETTINGS, onCreateTab, () => [], () => {}, options);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
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

test('sendMessage uses POST body and never puts the access token in the URL', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const manager = createManager({
    random: () => 0.5,
    fetch: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse({ response: 1 });
    },
  });

  await manager.sendMessage(123456, 'hello');

  assert.equal(seenUrl, 'https://api.vk.com/method/messages.send');
  assert.equal(seenUrl.includes(SETTINGS.token), false);
  assert.equal(seenInit?.method, 'POST');
  const body = seenInit?.body as URLSearchParams;
  assert.equal(body.get('access_token'), SETTINGS.token);
  assert.equal(body.get('peer_id'), '123456');
  assert.equal(body.get('message'), 'hello');
  assert.equal(body.get('random_id'), '500000000');
});

test('messages.send HTTP failures propagate to the caller', async () => {
  const manager = createManager({
    fetch: async () => jsonResponse({ error: 'unavailable' }, 503),
  });

  await assert.rejects(
    manager.sendMessage(123456, 'hello'),
    /VK API messages\.send returned HTTP 503/,
  );
});

test('VK API error details do not repeat remote text, parameters, or the token', async () => {
  const manager = createManager({
    fetch: async () => jsonResponse({
      error: {
        error_code: 5,
        error_msg: `authorization failed for ${SETTINGS.token}`,
        request_params: [{ key: 'access_token', value: SETTINGS.token }],
      },
    }),
  });

  await assert.rejects(manager.sendMessage(123456, 'hello'), (error: Error) => {
    assert.equal(error.message, 'VK API messages.send failed (code 5)');
    assert.equal(error.message.includes(SETTINGS.token), false);
    assert.equal(error.message.includes('authorization failed'), false);
    return true;
  });
});

test('API timeout aborts the request and reports a safe timeout', async () => {
  let aborted = false;
  const manager = createManager({
    apiTimeoutMs: 10,
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error(`request to https://api.vk.com/?access_token=${SETTINGS.token} failed`));
      });
    }),
  });

  await assert.rejects(manager.sendMessage(123456, 'hello'), (error: Error) => {
    assert.equal(error.message, 'VK API messages.send timed out');
    assert.equal(error.message.includes(SETTINGS.token), false);
    return true;
  });
  assert.equal(aborted, true);
});

test('only allowed users in a private dialog can execute bot commands', async () => {
  const created: TabConfig[] = [];
  const manager = createManager({}, (config) => { created.push(config); });
  (manager as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {};
  const handleUpdate = (manager as unknown as { handleUpdate(update: unknown): Promise<void> }).handleUpdate.bind(manager);

  await handleUpdate({
    type: 'message_new',
    object: { message: { from_id: 999999, peer_id: 999999, text: '/vk headless' } },
  });
  await handleUpdate({
    type: 'message_new',
    object: { message: { from_id: 123456, peer_id: 2000000001, text: '/vk headless' } },
  });
  await handleUpdate({
    type: 'message_new',
    object: { message: { from_id: 123456, peer_id: 123456, text: '/vk headless' } },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].platform, Platform.VK);
});

test('join targets remain functional but never appear in BotManager logs', async () => {
  const secretLink = 'https://vk.com/call/join/private-room-secret';
  const created: TabConfig[] = [];
  const manager = createManager({}, (config) => { created.push(config); });
  (manager as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {};
  const handleUpdate = (manager as unknown as { handleUpdate(update: unknown): Promise<void> }).handleUpdate.bind(manager);

  const logs = await captureConsole(async () => {
    await handleUpdate({
      type: 'message_new',
      object: { message: { from_id: 123456, peer_id: 123456, text: secretLink } },
    });
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].joinTarget, secretLink);
  assert.equal(logs.includes(secretLink), false);
  assert.equal(logs.includes('private-room-secret'), false);
  assert.ok(logs.includes('Join link detected for vk'));
});

test('start logs contain no settings, token, Long Poll URL, or Long Poll key', async () => {
  let pollStarted = false;
  const manager = createManager({
    fetch: async (url, init) => {
      if (url.endsWith('/groups.getLongPollServer')) {
        return jsonResponse({
          response: {
            server: 'https://lp.vk.com/private-server-path',
            key: 'LONG_POLL_PRIVATE_KEY',
            ts: '1',
          },
        });
      }
      pollStarted = true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });
    },
  });

  const logs = await captureConsole(async () => {
    assert.equal(await manager.start(), true);
    await waitFor(() => pollStarted);
    manager.stop();
    await new Promise((resolve) => setImmediate(resolve));
  });

  for (const secret of [
    SETTINGS.token,
    SETTINGS.groupId,
    SETTINGS.userId,
    'private-server-path',
    'LONG_POLL_PRIVATE_KEY',
  ]) {
    assert.equal(logs.includes(secret), false, `secret appeared in logs: ${secret}`);
  }
});

test('stop aborts an in-flight Long Poll request', async () => {
  let pollStarted = false;
  let pollAborted = false;
  const manager = createManager({
    fetch: async (url, init) => {
      if (url.endsWith('/groups.getLongPollServer')) {
        return jsonResponse({ response: { server: 'https://lp.vk.com/check', key: 'key', ts: '1' } });
      }
      pollStarted = true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          pollAborted = true;
          reject(abortError());
        });
      });
    },
  });

  assert.equal(await manager.start(), true);
  await waitFor(() => pollStarted);
  manager.stop();
  await waitFor(() => pollAborted);
});

test('stop followed by immediate start cannot keep the stale Long Poll loop alive', async () => {
  let serverCalls = 0;
  let pollCalls = 0;
  let activePolls = 0;
  let maxActivePolls = 0;
  const manager = createManager({
    fetch: async (url, init) => {
      if (url.endsWith('/groups.getLongPollServer')) {
        serverCalls += 1;
        return jsonResponse({
          response: { server: 'https://lp.vk.com/check', key: `key-${serverCalls}`, ts: '1' },
        });
      }
      pollCalls += 1;
      activePolls += 1;
      maxActivePolls = Math.max(maxActivePolls, activePolls);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          activePolls -= 1;
          reject(abortError());
        }, { once: true });
      });
    },
  });

  assert.equal(await manager.start(), true);
  await waitFor(() => pollCalls === 1);
  manager.stop();
  await waitFor(() => activePolls === 0);

  assert.equal(await manager.start(), true);
  await waitFor(() => pollCalls === 2);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(serverCalls, 2);
  assert.equal(pollCalls, 2);
  assert.equal(activePolls, 1);
  assert.equal(maxActivePolls, 1);
  manager.stop();
  await waitFor(() => activePolls === 0);
});

test('Long Poll failures use bounded backoff and never log the secret request URL', async () => {
  const delays: number[] = [];
  let manager: BotManager;
  const logs = await captureConsole(async () => {
    manager = createManager({
      retryBaseMs: 100,
      retryMaxMs: 1000,
      random: () => 0,
      fetch: async (url) => {
        if (url.endsWith('/groups.getLongPollServer')) {
          return jsonResponse({
            response: { server: 'https://lp.vk.com/check', key: 'PRIVATE_LONG_POLL_KEY', ts: '1' },
          });
        }
        throw new Error(`request to ${url} failed`);
      },
      sleep: async (delay) => {
        delays.push(delay);
        if (delays.length === 2) manager.stop();
      },
    });

    assert.equal(await manager.start(), true);
    await waitFor(() => delays.length === 2);
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(delays, [100, 200]);
  assert.equal(logs.includes('PRIVATE_LONG_POLL_KEY'), false);
  assert.equal(logs.includes('https://lp.vk.com'), false);
});

test('Long Poll retry delay uses bounded exponential backoff with jitter', () => {
  assert.equal(calculateBackoffMs(1, 1000, 30_000, 0), 1000);
  assert.equal(calculateBackoffMs(2, 1000, 30_000, 1), 2500);
  assert.equal(calculateBackoffMs(10, 1000, 30_000, 1), 30_000);
});
