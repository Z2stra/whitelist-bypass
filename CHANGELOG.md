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
- Documented the source-free separate-machine live-test boundary and the Android POC signing/key lifecycle.
- Distinguished the local signing/update smoke on the trusted build machine from later VK/network live tests on the separate source-free machine.
- Replaced manual local POC manifest assembly with a checked PowerShell helper that records commit/tree provenance and derives manifest identity from the saved APK.
- Corrected the source-build README so it no longer describes the intentionally disabled unsigned Android release path as a usable release artifact.

### Android

- Scoped the Quick Settings `VpnTileService` declaration to API 24 without raising the application `minSdk` from 23.
- Updated active foreground-service notifications through `startForeground`, closing Android 13 notification-permission lint errors without introducing a user-facing notification permission request.
- Added a reproducible Android CI gate for unit tests, full `lint`, debug APK assembly and report/artifact retention.
- Removed the repository-owned `debug.keystore` from active use and stopped signing release output with a publicly available debug key.
- Restored standard machine-local Android debug signing and left production release signing intentionally unconfigured.
- Added a separate non-debuggable `poc` build type that requires an external PKCS12 keystore plus a bounded `WLB_POC_BUILD_NUMBER` in `1..999`.
- Applied the numbered live version code only to signed POC APK output so normal debug/release artifacts retain the stable base identity.
- Restricted live POC delivery to APK and made POC Android App Bundle production fail with an explicit unsupported-operation error.
- Added local environment/property inputs for POC signing without committing key paths, aliases or passwords.
- Rejected partial signing environments only at the POC APK boundary, preventing source mixing without breaking ordinary non-POC tasks, including full Android lint.
- Made signed POC APK and aggregate APK packaging fail closed when build identity or signing inputs are absent.
- Added public-CI checks that verify environment and properties through two separately numbered signed APKs, compare each APK signer certificate with a disposable generated CI key, validate Gradle-derived identities, reject debuggable POC output and confirm POC AAB production remains disabled.
- Pinned Android APK inspection and signature verification to build-tools `36.0.0` instead of selecting the newest preinstalled runner tool.
- Strengthened the unsigned-release regression to require a structurally valid APK, the pinned expected unsigned diagnostic and no reported signer certificate.
- Changed `build-android.sh` to fail closed instead of copying the unsigned `app-release.apk` into the distributable-looking `prebuilts/whitelist-bypass.apk`; `make-release.sh` therefore stops until a separate production Android signing design exists.
- Added a repository-wide regression that verifies the legacy Android release-export script returns the expected signing-policy error and leaves no APK.
- Added a repository-wide pull-request workflow that rejects tracked signing containers and private signing property files regardless of changed paths, and configured its `tracked-signing-material` job as a required `main` status check.
- Added a repository-wide regression that verifies representative relay, cross-platform headless and VK-bot build outputs remain ignored even when a build script exits before cleanup.
- Clarified that Gradle enforces only the build-number range; monotonically increasing live numbers and immutable release-directory names must be enforced by the future versioned bundle builder.
- Added `tools/preserve-poc-signing-smoke.ps1`, which requires a clean source tree, pins commit/tree provenance, refuses reused output directories, verifies the copied APK signer/package/version/debuggable state and writes UTF-8 no-BOM manifests from actual APK evidence.
- Added Android CI syntax parsing and a real Windows end-to-end workflow for the PowerShell signing-smoke helper.
- Made APK package/version parsing case-sensitive so Windows PowerShell cannot mistake `platformBuildVersionCode/Name` for the leading APK `versionCode/versionName` fields.
- Expanded project, Android and Creator ignore rules for local secrets, signing files, additional PKCS/key containers, all known build-script output families, runtime profiles and versioned live bundles.

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
- Routed POC-only messages before keyboard payload, link and command parsing, eliminating operational fallback in POC mode.
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

### Creator protected settings and cookies

- Moved the VK community token and upstream proxy credentials from renderer `localStorage` into a versioned main-process protected-settings store.
- Encrypted the settings envelope through Electron `safeStorage`; Windows uses DPAPI and insecure Linux `basic_text` fallback is refused.
- Replaced secret-bearing renderer state with configured/not-configured projections and explicit keep/replace/clear operations.
- Added one-time, idempotent migration that deletes legacy plaintext only after confirmed protected persistence.
- Made bot startup a zero-argument IPC call and applied upstream proxy settings only from main-process storage.
- Serialized concurrent protected writes, quarantined corrupt stores and added a real Windows DPAPI write/reload/no-plaintext smoke test.
- Added a single-instance lock to prevent competing Creator processes from overwriting the same protected store.
- Saving protected settings now stops active bot/relay/headless consumers before activating replacement credentials, and proxy credentials are treated as opaque values.
- Removed raw cookie ZIP export and the privileged cookie-export IPC path.
- Replaced persistent headless `cookies-*.json` files with random process-scoped temporary files plus exit/crash cleanup.
- Tightened cookie-domain matching to exact roots/proper subdomains and removed WB device IDs/cookie details from normal logs.
- Documented persistent Chromium-cookie, same-user DPAPI and child-process command-line residual risks.
- Preserved newer protected-store versions instead of quarantining or overwriting them during downgrade.
- Made credential rotation wait for BotManager/child exit and retry temporary cookie cleanup after Windows sharing failures.
- Required migration confirmation before deleting legacy plaintext and allowed independent proxy credential replacement.
- Moved platform-login waiting outside the credential lifecycle queue while keeping the final cookie-file creation, proxy argument selection and process spawn serialized.
- Added cancellation for pending login/start operations during settings rotation and tab close, with listener cleanup and duplicate-close coalescing.
- Made tab close await child termination and ephemeral cookie cleanup instead of deleting state after a best-effort kill.
- Serialized both typed and legacy bot result delivery against community-token rotation.
- Prevalidated legacy migration input before stopping any consumers and disabled bot auto-start/manual start while legacy plaintext keys remain.
- Replaced the injected WB device-ID `console.log` channel with an exact-origin, bounded main-process `executeJavaScript` result read.

### Security status

- VK transport hardening, typed headless process events, the isolated `WLB-POC/1` handler and the Electron IPC/remote-content trust boundary are implemented and tested.
- Stored VK/proxy secrets are main-process owned and OS-protected; the merged build passed the local first-run Windows DPAPI and protected-storage smoke.
- Live VK/network POC delivery is gated on an external persistent Android POC key and a versioned prebuilt APK-only bundle for the separate test machine.
- Public CI may create a disposable runner-local synthetic signing key, but persistent/live signing keys remain prohibited from Git and public CI configuration or artifacts.

### Known baseline debt

- Android has no blocking lint errors; previously classified non-blocking warnings remain tracked as technical debt.
- Platform sessions remain in the persistent Chromium profile, and proxy credentials are still visible transiently in child-process command-line arguments to legacy Go binaries.
- Creator dependency audit findings remain a separate dependency-upgrade task; no automatic `npm audit fix` was applied.
- The historical repository debug key remains publicly recoverable and must never be trusted again, even after deletion from the current tree.
