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
- Moved headless creator marker parsing into the main process and exposed typed functional events through a dedicated IPC channel.
- Kept real join links and TURN values in the authorized functional path while replacing them with redacted placeholders in console, renderer and saved diagnostic logs.
- Added stream line buffering and regression tests for split output chunks, terminal flush, typed renderer state and bot replies.
- Added an explicit `--vk-poc-only` runtime mode for the mandatory official VK transport proof.
- Added a strict `WLB-POC/1 PING` parser and correlated `PONG` formatter with bounded base64url fields.
- Routed POC-only messages before keyboard payload, join-link and legacy command parsing, eliminating operational fallback in POC mode.
- Added negative, transport-failure, safe-logging and static isolation regression tests for the POC handler.

### Creator Electron trust boundary

- Disabled Node integration in the application page main world, enabled context isolation and removed the main-world `require(...)` bootstrap.
- Added a restrictive application-page CSP and exact local-file navigation binding.
- Added strict IPC sender/main-frame checks, argument-count validation and runtime validators for all privileged invoke handlers.
- Restricted call-script loading to a fixed filename allowlist with canonical directory containment.
- Forced remote webviews and popup windows to use sandboxed, context-isolated, no-Node preferences without inherited preload scripts.
- Added HTTPS platform-origin policies for webview attachment, navigation, redirects and popups; rejected credentials, lookalike hosts, unsafe schemes and non-default ports.
- Changed remote permissions to default-deny and limited media/fullscreen to active call origins rather than login or general account pages.
- Replaced global CSP stripping with a documented compatibility exception for legacy VK and Telemost document frames only.
- Added trust-policy/static regression tests and an Electron/Xvfb smoke test that proves the UI boots without `require` or a privileged bridge in the page main world.
- Configured the GitHub Actions Electron sandbox helper with root ownership and mode `4755`; sandboxing is not disabled in CI.

### Security status

- VK transport hardening, typed headless process events, the isolated `WLB-POC/1` handler and the Electron IPC/remote-content trust boundary are implemented and tested.
- Real VK credentials, platform cookies and proxy passwords remain prohibited until protected main-process secret storage and cookie persistence/export review are complete.

### Known baseline debt

- Android has no blocking lint errors; 69 non-blocking warnings remain classified as technical debt.
- Long-lived VK/proxy credentials still reside in renderer storage and platform cookie persistence/export remains open security work.
- Creator dependency audit findings remain a separate dependency-upgrade task; no automatic `npm audit fix` was applied.
