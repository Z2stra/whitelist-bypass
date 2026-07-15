# Whitelist Bypass — product and delivery status

> This document is the source of truth for the staged VK control-plane work. It intentionally separates verified baseline facts from planned work.

## Baseline

- Upstream snapshot: `99e5630f1978597fc469ac06057fe0ed95415c63`.
- Windows v1 host: existing Electron Creator.
- Android client: existing `android-app` using `VpnService` and the headless Go/Pion path.
- The unmodified Windows Creator and Android debug APK have been built and smoke-tested locally on Windows.
- Android CI runs `test`, full `lint`, and `assembleDebug`; verification tools are pinned to Android build-tools `36.0.0`, and previously classified non-blocking lint warnings remain tracked as technical debt.
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
- [x] Separate functional process events (for example a join link) from redacted diagnostic logs.
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
- [x] Add a distinct non-debuggable `poc` build type that requires an external PKCS12 key and a bounded `WLB_POC_BUILD_NUMBER` in `1..999`.
- [x] Apply the per-build live version code only to the signed POC APK; normal debug/release outputs retain the stable base identity.
- [x] Reject partial signing environments at the POC APK boundary without breaking ordinary `test`, full `lint` or `assembleDebug` tasks.
- [x] Make supported POC APK and aggregate APK packaging fail closed when signing inputs or the keystore are unavailable.
- [x] Explicitly reject POC Android App Bundle production; live POC delivery is APK-only.
- [x] Verify public-CI signing with a disposable key, exact APK signer-certificate matching, Gradle-derived identity, non-debuggable output and both environment/properties APK input paths.
- [x] Pin Android verification to build-tools `36.0.0` and accept only the expected unsigned-release diagnostic after structural APK validation.
- [x] Verify that the ordinary release APK remains structurally valid but unsigned.
- [x] Make the legacy `build-android.sh`/`make-release.sh` Android path refuse to publish the unsigned release APK as `prebuilts/whitelist-bypass.apk`.
- [x] Run a repository-wide tracked-signing-material workflow on every pull request regardless of changed paths.
- [x] Keep all known relay/headless build-script outputs ignored and regression-test representative paths with `git check-ignore`.
- [x] Require `Repository signing-material policy / tracked-signing-material` before merging to `main` through the configured GitHub branch rule.
- [x] Expand `.gitignore` coverage for signing material, local configuration, build output and live bundles.
- [x] Keep direct Gradle `keystore.properties` fallback isolated from the canonical PowerShell helper; the helper requires the complete signing environment and never implements a second Java-properties parser.
- [x] Make helper artifact-pair acceptance transactional and regression-test rollback after the first move, second move and final validation failure.
- [x] Run the canonical helper on Windows without `-SkipQualityChecks` and independently re-inspect preserved APKs/manifests with pinned `aapt` and `apksigner`.
- [x] Add `tools/preserve-poc-signing-smoke.ps1` to build from a clean source tree, pin commit/tree provenance, verify saved APK evidence and write UTF-8 no-BOM manifests under ignored `local-artifacts`.
- [ ] Create and securely back up the persistent private POC keystore on the trusted build machine.
- [ ] Run the local signing helper with the persistent key and verify the resulting `poc.1`/`poc.2` manifests, certificate fingerprint and APK SHA-256 values.
- [ ] Verify local first install and subsequent in-place APK update on the physical POC device using the same POC key.
- [ ] Implement the reproducible versioned live-test bundle for Creator, Android, manifest, checksums and POC launcher; the builder must reject reused/non-increasing live build numbers and existing release directories.

### Phase 1 — official VK API PING/PONG POC

- [ ] Register/configure the VK ID Android application without committing secrets.
- [ ] Implement an isolated debug/POC Android login flow.
- [ ] Implement Android `messages.send` PING.
- [x] Implement Creator POC-only PING parser and PONG sender.
- [ ] Implement Android history polling and strict response correlation.
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

**Current status: the pre-POC Creator security gate is implemented, merged and locally confirmed on Windows with DPAPI. The official VK API POC has not started. The active milestone is the artifact/signing gate for a separate source-free test machine: the published Android debug key is being retired, live POC delivery is restricted to a signed non-debuggable APK, verification tools are pinned, the legacy unsigned release-export path is blocked, and the canonical environment-only PowerShell helper preserves a transactionally accepted APK pair with commit/tree provenance outside Gradle-owned output. The repository-wide signing-material workflow runs on every pull request and is required for merges into `main`. Windows CI runs the canonical helper including the full Android quality gate, injects acceptance rollback failures and independently verifies the resulting APKs/manifests. A local signing/update smoke may install helper-produced `poc.1` and `poc.2` APKs on a device connected to the trusted build machine before the bundle milestone. No VK/network live test on the separate test machine may begin until the versioned Creator/Android bundle exists and its manifest and checksums have been verified. WLB2, pairing and session orchestration remain blocked pending the official VK API GO/NO-GO result.**
