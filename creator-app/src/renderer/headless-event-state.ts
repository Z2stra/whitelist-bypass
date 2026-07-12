import { HeadlessProcessEvent, RendererTab } from '../types';

export interface HeadlessEventResult {
  changed: boolean;
  botReply?: string;
}

export function applyHeadlessProcessEvent(
  tab: RendererTab,
  event: HeadlessProcessEvent,
): HeadlessEventResult {
  switch (event.type) {
    case 'call-created':
      tab.callInfo = {};
      tab.headlessStatus = 'Call created';
      return { changed: true };

    case 'join-link':
      tab.callInfo ??= {};
      tab.callInfo.joinLink = event.link;
      return {
        changed: true,
        botReply: tab.isBot
          ? (tab.joinedByLink ? 'Joined successfully' : event.link)
          : undefined,
      };

    case 'turn':
      tab.callInfo ??= {};
      tab.callInfo.turn = event.value;
      return { changed: true };

    case 'protocol':
      tab.callInfo ??= {};
      tab.callInfo.protocol = event.value;
      return { changed: true };

    case 'tunnel-connected':
      tab.tunnelConnected = true;
      tab.headlessStatus = 'Tunnel connected';
      return { changed: true };

    case 'fatal':
      tab.headlessStatus = `Disconnected: ${event.message}`;
      tab.tunnelConnected = false;
      return { changed: true };

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
