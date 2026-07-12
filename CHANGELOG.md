# Changelog

All notable project changes made as part of the staged control-plane work are recorded here. This file does not retroactively describe every upstream release.

## Unreleased

### Documentation

- Established `PRODUCT.md` as the source of truth for scope, status, quality gates and the mandatory official VK API GO/NO-GO POC.
- Recorded the decision to use the existing Electron Creator as the Windows v1 control-plane host.
- Added the initial control-plane threat model.
- Added a draft platform-neutral `PlatformAdapter` contract.
- Added a WLB2 envelope draft with an external random `keyId` to avoid circular per-device key selection.
- Added the official VK API PING/PONG POC checklist and results template.

### Android

- Scoped the Quick Settings `VpnTileService` declaration to API 24 without raising the application `minSdk` from 23.
- Updated active foreground-service notifications through `startForeground`, closing Android 13 notification-permission lint errors without introducing a user-facing notification permission request.
- Added a reproducible Android CI gate for unit tests, `lintDebug`, debug APK assembly and report/artifact retention.

### Creator VK transport security

- Made the VK user allowlist mandatory and restricted commands to an allowlisted user's private dialog.
- Moved the community access token from request URLs into POST form bodies.
- Added HTTP status and JSON validation, bounded API/Long Poll timeouts and request cancellation.
- Added generation-based Stop → Start lifecycle isolation and bounded exponential retry/backoff with jitter.
- Stopped logging bot settings, Long Poll server/key, incoming message text and join-link values in `BotManager`.
- Made `messages.send` failures observable to callers instead of swallowing them.
- Added safe error formatting and regression coverage for tokens, authorization headers, cookies, proxy credentials, links and room/session identifiers.
- Added reproducible Creator CI for Node.js 22 build, static type-check and unit/regression tests.

### Security status

- The VK transport hardening subset is implemented and tested.
- Real VK credentials, platform cookies and proxy passwords remain prohibited until the remaining pre-POC security gate is complete: typed process events, POC-only handling, IPC validation, remote-content hardening and protected secret storage.

### Known baseline debt

- Android has no blocking lint errors; 69 non-blocking warnings remain classified as technical debt.
- The Electron renderer/webview trust boundary and long-lived renderer secret storage remain open security work.
- Creator dependency audit findings remain a separate dependency-upgrade task; no automatic `npm audit fix` was applied.
