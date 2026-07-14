# Whitelist Bypass — product and delivery status

> This document is the source of truth for the staged VK control-plane work. It intentionally separates verified baseline facts from planned work.

## Baseline

- Upstream snapshot: `99e5630f1978597fc469ac06057fe0ed95415c63`.
- Windows v1 host: existing Electron Creator.
- Android client: existing `android-app` using `VpnService` and the headless Go/Pion path.
- The unmodified Windows Creator and Android debug APK have been built and smoke-tested locally on Windows.
- Android baseline CI now passes `test`, `lintDebug`, and `assembleDebug`; 69 non-blocking lint warnings remain classified as technical debt.
- Creator CI now covers TypeScript build, static type-check, unit/regression tests, Electron renderer isolation and a Windows DPAPI protected-settings smoke on Node.js 22.
- No production credentials, tokens, cookies, proxy passwords or signing keys belong in Git or public CI.

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

**Current status: Phase 0 documentation is established. Android baseline checks are green. VK transport hardening, typed headless process events, IPC sender/argument validation, remote-webview isolation, the POC-only `WLB-POC/1` handler and main-process OS-protected settings are implemented. Creator is single-instance; settings replacement cancels pending login starts and waits for active secret consumers to exit; tab close waits for process and temporary-cookie cleanup; bot result delivery is serialized with credential rotation; newer store formats are preserved; raw cookie export is removed; WB device IDs are captured without remote-console disclosure; and bot startup is blocked while legacy plaintext remains. PR #8 stays Draft until its final CI/security review and the required local Windows upgrade/migration smoke are complete. The official VK API POC has not started. Real credentials may be introduced only in a post-merge Windows build after the DPAPI smoke and local upgrade migration are confirmed.**
