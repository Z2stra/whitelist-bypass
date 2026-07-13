# WLB-POC/1 — official VK API transport proof

## Status

`WLB-POC/1` is a temporary plaintext proof-of-concept format. It exists only to verify the official VK ID `messages.send` / community Group Long Poll / `messages.getHistory` path before production WLB2, pairing, encryption or session orchestration are implemented.

It must not carry call links, credentials, cookies, proxy configuration or operational commands.

## Windows activation

The Creator enters POC-only mode only when launched with the exact command-line flag:

```text
--vk-poc-only
```

Without that flag the existing operational bot mode remains available. Real POC credentials must be used only with the explicit POC-only flag until the remaining pre-POC security gate is complete.

## Messages

Android to community dialog:

```text
WLB-POC/1 PING <requestId> <nonce>
```

Community to Android:

```text
WLB-POC/1 PONG <requestId> <nonce>
```

`requestId` and `nonce` use only base64url characters (`A-Z`, `a-z`, `0-9`, `_`, `-`). The parser is case-sensitive, requires exactly four single-space-delimited fields, rejects leading/trailing whitespace and rejects control characters.

Limits:

- complete message: at most 256 characters;
- request ID: 16–64 characters;
- nonce: 16–128 characters.

## Isolation rule

In POC-only mode every allowlisted private-dialog message is routed exclusively to the POC parser. A rejected message is ignored. It never falls through to legacy `/vk`, `/tm`, `/wb`, `/dion`, `/close`, keyboard payload, join-link or tab-management handlers.

The POC handler depends only on a narrow `sendMessage(peerId, text)` transport callback. It has no process, tab, cookie, proxy or filesystem capability.

## Correlation and logging

A PONG repeats the exact request ID and nonce from the accepted PING. Android must additionally verify the expected community sender and its history baseline.

Creator diagnostics contain only a short SHA-256 fingerprint of `requestId`. They do not log the full PING/PONG, request ID, nonce, sender VK ID, token or Long Poll key.

## Not production security

VK can read POC message content and metadata. A successful POC only proves transport feasibility. It does not authorize production commands and does not replace WLB2 authenticated encryption, per-device pairing, replay protection or idempotency.
