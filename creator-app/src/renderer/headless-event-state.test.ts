import test from 'node:test';
import assert from 'node:assert/strict';
import { RendererTab, TunnelMode } from '../types';
import { applyHeadlessProcessEvent } from './headless-event-state';

function makeTab(overrides: Partial<RendererTab> = {}): RendererTab {
  return {
    wv: null,
    url: '',
    mode: TunnelMode.HeadlessVK,
    relayLogs: 'safe diagnostic',
    hookLogs: '',
    name: 'VK',
    isBot: false,
    headless: true,
    ...overrides,
  };
}

test('typed join-link event preserves the real link without using relay logs', () => {
  const link = 'https://vk.com/call/join/private-room';
  const tab = makeTab({ isBot: true, callInfo: {} });

  const result = applyHeadlessProcessEvent(tab, { type: 'join-link', link });

  assert.equal(tab.callInfo?.joinLink, link);
  assert.equal(result.botReply, link);
  assert.equal(tab.relayLogs, 'safe diagnostic');
});

test('bot join-existing flow returns a generic success instead of echoing the link', () => {
  const tab = makeTab({ isBot: true, joinedByLink: true });

  const result = applyHeadlessProcessEvent(tab, {
    type: 'join-link',
    link: 'https://telemost.yandex.ru/j/private-room',
  });

  assert.equal(result.botReply, 'Joined successfully');
  assert.equal(tab.callInfo?.joinLink, 'https://telemost.yandex.ru/j/private-room');
});

test('call metadata events initialize state even when CALL CREATED was not observed', () => {
  const tab = makeTab();

  applyHeadlessProcessEvent(tab, { type: 'protocol', value: 'quic' });
  applyHeadlessProcessEvent(tab, { type: 'turn', value: 'turn-value' });

  assert.equal(tab.callInfo?.protocol, 'quic');
  assert.equal(tab.callInfo?.turn, 'turn-value');
});

test('tunnel and fatal events update renderer state without parsing diagnostics', () => {
  const tab = makeTab();

  applyHeadlessProcessEvent(tab, { type: 'tunnel-connected' });
  assert.equal(tab.tunnelConnected, true);
  assert.equal(tab.headlessStatus, 'Tunnel connected');

  applyHeadlessProcessEvent(tab, { type: 'fatal', message: 'network failed' });
  assert.equal(tab.tunnelConnected, false);
  assert.equal(tab.headlessStatus, 'Disconnected: network failed');
});
