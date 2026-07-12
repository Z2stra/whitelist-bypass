# ADR 0001: Use the existing Electron Creator as the Windows v1 control-plane host

- Status: Accepted for v1
- Date: 2026-07-12
- Scope: Windows-side orchestration and the official VK API POC

## Context

The repository already contains an Electron Creator that starts and supervises the relay and headless platform binaries. It also contains a VK community Long Poll bot. A second independent Windows daemon or a parallel implementation in the standalone Go bot would duplicate lifecycle, credentials, UI and packaging concerns before the official VK API path is proven.

The immediate objective is not to redesign the complete product. It is to validate the official VK messaging path with the smallest reviewable change while preserving the current creator workflow.

## Decision

For Windows v1:

1. The existing `creator-app` is the only control-plane host.
2. `creator-app/src/bot/bot-manager.ts` is treated as a transport adapter, not as the future session-orchestration layer.
3. POC messages are handled by a dedicated POC-only parser/handler and cannot invoke legacy create/join/close commands.
4. The future `SessionManager` depends on a platform-neutral `PlatformAdapter`; it does not depend directly on VK message payloads.
5. The standalone `headless/vk-bot` remains an existing deployment option but does not receive a parallel WLB2 implementation during the POC.
6. Major Electron trust-boundary changes are delivered in isolated security commits with regression tests for the legacy platform flows.

## Consequences

### Positive

- Reuses existing process supervision and packaging.
- Avoids two diverging control-plane implementations.
- Keeps the mandatory POC small enough to review and roll back.
- Provides a migration path from the current bot to a typed transport/session boundary.

### Negative and risks

- The current Electron renderer/webview boundary contains security debt that must be reduced before real credentials are used.
- Existing legacy browser flows must be regression-tested when remote webviews are sandboxed.
- Long-lived secret storage cannot remain in renderer `localStorage` for production.

## Rejected alternatives

### Implement WLB2 first in `headless/vk-bot`

Rejected because it duplicates orchestration and does not prove the intended Windows desktop workflow.

### Build a new Windows service immediately

Rejected because it adds packaging, lifecycle and IPC complexity before the official VK API gate is known to be viable.

### Put session orchestration directly into `BotManager`

Rejected because it couples a VK transport to platform lifecycle, prevents clean testing and makes future transports harder to add.

## Review trigger

Revisit this ADR after the official PING/PONG POC or if Electron hardening cannot preserve the required platform login/join flows.
