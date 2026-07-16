# Whitelist Bypass — product and delivery status

> This document is the source of truth for the staged VK control-plane work. It intentionally separates verified baseline facts from planned work.

## Baseline

- Upstream snapshot: `99e5630f1978597fc469ac06057fe0ed95415c63`.
- Windows v1 host: existing Electron Creator.
- Android client: existing `android-app` using `VpnService` and the headless Go/Pion path.
- The unmodified Windows Creator and Android debug APK have been built and smoke-tested locally on Windows.
- Android CI runs `test`, full `lint`, and `assembleDebug`; verification tools are pinned to Android build-tools `36.0.0`.
- Creator CI covers TypeScript build, static type-check, unit/regression tests, Electron renderer isolation and a Windows DPAPI protected-settings smoke on Node.js 22.
- The merged protected-settings build completed a local first-run Windows check: Settings reported Windows DPAPI and the synthetic protected-storage smoke passed.
- Live tests run on a separate machine that does not receive the repository, source code, Node.js, Go, Gradle or signing keys; every live iteration must use prebuilt, versioned artifacts.
- No production credentials, tokens, cookies, proxy passwords, persistent signing keys or live signing keys belong in Git or public CI.
- Public CI may generate a disposable runner-local signing key solely for synthetic verification. That key must never be published, backed up, transferred or used on a physical POC device.

## Mandatory architecture gate

The official VK API PING/PONG proof of concept is a **GO/NO-GO gate**. Full pairing, WLB2 control messages, session orchestration, capability registries and automated recovery must not be implemented until the POC proves all of the following with official APIs:

- Android obtains a VK ID token with the required messaging permission.
- Android sends a PING to the private community dialog.
- Electron receives it through Group Long Poll.
- Electron sends a correlated PONG.
- Android receives the PONG through message history.
- Refresh, logout, restart and re-login behavior are understood.
- The target restricted network does not make the flow unusable or repeatedly trigger validation/captcha.

## Delivery phases

### Phase 0 — scope, baseline, architecture and safety documentation

- [x] Establish this `PRODUCT.md` as the status source of truth.
- [x] Record the Electron Creator decision for Windows v1.
- [x] Record the initial control-plane threat model.
- [x] Define a draft `PlatformAdapter` boundary.
- [x] Define the draft WLB2 envelope, including an external non-personal `keyId` for deterministic key selection.
- [x] Define the official VK API POC checklist and result template.
- [ ] Confirm all baseline quality commands on a clean CI runner.
- [x] Obtain and classify the complete Android lint report.

### Pre-POC security gate — required before real VK credentials

- [x] Remove token/settings logging from the VK transport.
- [x] Require an explicit VK user allowlist and bind commands to the private dialog (`peer_id == from_id`).
- [x] Move VK API credentials out of request URLs.
- [x] Add HTTP status checks, bounded timeouts, request cancellation and bounded retry/backoff.
- [x] Make Stop → Start unable to leave a stale Long Poll loop running.
- [x] Propagate `messages.send` failures to callers.
- [x] Separate functional process events from redacted diagnostic logs.
- [x] Cover token, Long Poll key, Authorization headers, proxy credentials, platform links, room IDs and cookie material in log-redaction tests.
- [x] Restrict the POC handler to `WLB-POC/1` PING/PONG; operational join/start/close commands remain disabled in POC mode.
- [x] Validate Electron IPC senders and runtime arguments.
- [x] Remove Node privileges from remote web content and restrict navigation, redirects, popups and permissions to explicit platform origins.
- [x] Move long-lived secrets out of renderer `localStorage`; document remaining cookie-storage risk.
- [x] Keep headless login waits cancellable and outside the credential lifecycle lock; serialize only the final process spawn/secret-consumption phase.
- [x] Make tab close cancel pending starts, wait for child exit and verify ephemeral cookie cleanup.
- [x] Serialize bot result delivery with credential rotation, including the legacy webview result path.
- [x] Validate legacy migration before stopping consumers and block bot start while plaintext remnants remain.
- [x] Capture the WB device ID in the main process without printing it into the remote webview console.
- [x] Complete the local Windows DPAPI first-run and synthetic protected-storage smoke after merging the protected-settings milestone.

### POC artifact and signing gate — required before VK/network live tests on the separate machine

- [x] Remove the repository-owned Android debug keystore from active debug/release signing.
- [x] Keep normal debug signing machine-local and leave production release signing intentionally unconfigured.
- [x] Add a distinct non-debuggable `poc` build type requiring an external PKCS12 key and `WLB_POC_BUILD_NUMBER` in `1..999`.
- [x] Apply the per-build live version code only to the signed POC APK; normal debug/release outputs retain the stable base identity.
- [x] Reject partial signing environments at the POC APK boundary without breaking ordinary `test`, full `lint` or `assembleDebug` tasks.
- [x] Make supported POC APK and aggregate APK packaging fail closed when signing inputs or the keystore are unavailable.
- [x] Explicitly reject POC Android App Bundle production; live POC delivery is APK-only.
- [x] Verify public-CI signing with a disposable key, exact APK signer-certificate matching, Gradle-derived identity, non-debuggable output and both environment/properties Gradle paths.
- [x] Pin Android verification to build-tools `36.0.0` and accept only the expected unsigned-release diagnostic after structural APK validation.
- [x] Verify that the ordinary release APK remains structurally valid but unsigned.
- [x] Make the legacy `build-android.sh`/`make-release.sh` Android path refuse to publish the unsigned release APK as `prebuilts/whitelist-bypass.apk`.
- [x] Run a repository-wide tracked-signing-material workflow on every pull request regardless of changed paths.
- [x] Keep all known relay/headless build-script outputs ignored and regression-test representative paths with `git check-ignore`.
- [x] Require `Repository signing-material policy / tracked-signing-material` before merging to `main` through the configured GitHub branch rule.
- [x] Expand `.gitignore` coverage for signing material, local configuration, build output and live bundles.
- [x] Keep direct Gradle `keystore.properties` fallback isolated from the canonical operator wrapper.
- [x] Reject every POC keystore whose canonical path resolves inside the repository, including ignored secret/artifact directories.
- [x] Add `tools/invoke-poc-signing-smoke.ps1` to prompt passwords securely, avoid shell-history assignments, clear signing environment variables and zero BSTR buffers.
- [x] Remove signing secrets from the helper process environment before quality commands and reintroduce them only around certificate export and `assemblePoc`.
- [x] Require the low-level helper to receive an explicit expected public certificate SHA-256.
- [x] Serialize helper executions with an exclusive repository-scoped lock and regression-test second-holder rejection.
- [x] Make helper artifact-pair acceptance transactional and regression-test rollback after the first move, second move and final validation failure.
- [x] Hard-pin accepted helper verification to Android build-tools `36.0.0` and record that version in manifest schema 2.
- [x] Run the canonical helper on Windows without `-SkipQualityChecks` and independently re-inspect preserved APKs/manifests with pinned `aapt` and `apksigner`.
- [x] Pin security-sensitive Android/Windows signing workflow actions to full commit SHAs.
- [ ] Create and securely back up the persistent private POC keystore on the trusted build machine.
- [ ] Run the first operator wrapper smoke with `-InitializeSigningIdentity`.
- [ ] Review and commit the generated public `android-app/poc-signing-identity.json` in a follow-up PR.
- [ ] Run the local signing helper with the committed identity and verify the resulting manifests, certificate fingerprint and APK SHA-256 values.
- [ ] Verify local first install and subsequent in-place APK update on the physical POC device using the same POC key.
- [ ] Implement the reproducible versioned live-test bundle for Creator, Android, manifest, checksums and POC launcher; reject reused/non-increasing numbers, existing release directories and certificate mismatch with `poc-signing-identity.json`.

### Phase 1 — official VK API PING/PONG POC

- [ ] Register/configure the VK ID Android application without committing secrets.
- [x] Implement an isolated debug/POC Android VK ID login flow requesting the `messages` scope.
- [x] Implement Android `messages.send` PING through the official API with the access token in the POST form body.
- [x] Implement Creator POC-only PING parser and PONG sender.
- [x] Implement Android history-baseline capture, bounded polling/cancellation and strict PONG correlation.
- [x] Implement explicit Android refresh, logout and re-login states without exposing token values to the UI.
- [x] Exclude VK authentication storage from Android backup/device transfer and keep raw tokens, identifiers, message bodies and API errors out of POC diagnostics.
- [ ] Pass the local Android unit-test, full-lint and debug/POC assembly gates for the implementation branch.
- [ ] Exercise token refresh, logout, restart and re-login.
- [ ] Run repeated exchanges on the target restricted mobile network.
- [ ] Write the evidence and a documented GO/NO-GO decision.

### Phase 2 — production security foundation

- [x] Complete the Electron IPC and remote-content trust-boundary hardening milestone.
- [x] Introduce OS-protected secret storage without exposing stored secrets to the renderer.
- [ ] Define replay windows, counters, expiry, rate limits and audit-safe event logging.
- [ ] Complete Android backup exclusions and token/log review.

### Phase 3 — WLB2 and pairing

- [ ] Finalize the versioned authenticated envelope and AAD.
- [ ] Implement pairing and key lifecycle.
- [ ] Implement replay protection and deterministic `keyId` lookup.
- [ ] Add protocol vectors and negative tests.

### Phase 4 — platform abstraction

- [ ] Implement the `PlatformAdapter` interface for VK.
- [ ] Add Telemost, WB Stream and DION adapters only after the common lifecycle is stable.
- [ ] Add capability reporting rather than platform conditionals in orchestration code.

### Phase 5 — Windows session orchestration

- [ ] Implement `SessionManager` and connection/capability registries.
- [ ] Add idempotent session creation, replacement-link revisioning and ownership checks.
- [ ] Add bounded cleanup, recovery and observability.

### Phase 6 — Android control flow

- [ ] Add pairing UI and protected local configuration.
- [ ] Add Connect/Disconnect state machine and recovery UX.
- [ ] Preserve existing `CallConfig.id` as the stable client-side identity.

### Phase 7 — integration, packaging and release readiness

- [ ] Pass Creator build/lint/test.
- [ ] Pass Android test/lint/assembleDebug.
- [ ] Pass Go test/vet for all modules.
- [ ] Pass Windows packaging and physical-device smoke tests.
- [ ] Verify no credentials or private payloads are present in artifacts, logs, backups, issues or CI.

## Definition of Done for every code milestone

A code milestone is complete only when:

1. Changes are isolated in a reviewable branch/PR.
2. Tests cover new behavior and important regressions.
3. Creator checks pass: `npm run build`, `npm run lint`, `npm test`.
4. Android checks pass when Android is touched: `gradlew test`, `gradlew lint`, `gradlew assembleDebug`.
5. Go checks pass when Go is touched: `go test ./...`, `go vet ./...` in every affected module.
6. `PRODUCT.md`, `CHANGELOG.md` and affected ADR/protocol documentation are updated.
7. Logs and artifacts have been reviewed for secrets and private payloads.
8. Remaining risks and unverified platform tests are stated explicitly.

## Current decision

**Current status: the pre-POC Creator security gate is implemented, merged and locally confirmed on Windows with DPAPI. The Android side of the official VK API PING/PONG POC is implemented in the current branch for code review: an isolated VK ID SDK `2.7.1` flow requests `messages`, uses the official `messages.send`/`messages.getHistory` API at `https://api.vk.ru` with `v=5.131`, and applies a history baseline plus strict sender/peer/direction/body correlation. Token storage remains SDK-owned and encrypted, backup is explicitly excluded, and POC diagnostics do not contain raw tokens, identifiers, message bodies or API errors. This is not a live result or GO: local Android test/lint/assembly gates, VK application registration, actual `messages` grant, signed-device lifecycle tests and target-network exchanges remain pending. The `messages` scope being available and actually granted to the registered Android application is a live GO/NO-GO condition. The mobile client secret is necessarily extractable from the APK and must be treated as a public-app credential bound to the registered package/signature, never as a repository or logging secret. The persistent signing key, committed public signing identity, physical update smoke and versioned source-free live bundle also remain mandatory before any VK/network live test. WLB2, pairing and session orchestration remain blocked pending an evidence-backed official VK API GO/NO-GO decision.**
