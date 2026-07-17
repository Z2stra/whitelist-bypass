# Official VK API PING/PONG POC results

- Status: NOT RUN
- Decision: PENDING
- Source commit: TBD
- Test date: TBD
- Operator: TBD

> Do not paste tokens, cookies, full message bodies, user IDs, community IDs, join links, proxy credentials or signing material into this document.

> Android POC code is present in the implementation branch, but local Android test/lint/assembly gates and all signed-device/live-network steps are still unconfirmed. Nothing in this template is a GO result.

## Implementation snapshot (not live evidence)

| Item | Pinned implementation |
|---|---|
| Authentication SDK | Official VK ID SDK `2.7.1` |
| VK API transport | POST form body to `https://api.vk.ru`; access token never placed in the URL |
| VK API version | `5.131`, matching the merged Creator POC contract |
| Community dialog | `peer_id=-<positiveCommunityId>` |
| Protocol | Exact `WLB-POC/1 PING/PONG` request ID and nonce correlation |
| Response acceptance | Newer than baseline; exact expected community sender/peer; `out == 0`; entire body match |
| Poll lifecycle | Bounded deadline; success/timeout/logout/user-cancel termination |
| Token persistence | VK ID SDK encrypted preferences; explicitly excluded from backup/device transfer |
| Diagnostics | No raw token, identity, request ID, nonce, message body or VK/SDK error output |
| Local configuration | Ignored property file or atomic environment inputs; no live values in Git |

The VK mobile client secret is extractable from an APK. It must be treated as a public-app credential bound to the registered package/signing certificate, not as a confidential server credential. Actual availability and grant of `messages` is a live GO/NO-GO condition.

## Environment

| Item | Value |
|---|---|
| Windows edition/build | TBD |
| Creator commit/version | TBD |
| Node/npm | TBD |
| Android device/model | TBD |
| Android version/API | TBD |
| APK commit/build type | TBD |
| Network under test | TBD (non-identifying description) |
| VK ID SDK/API version | VK ID SDK `2.7.1` / VK API `5.131` (implementation pin; live confirmation NOT RUN) |
| VK API origin/method | `https://api.vk.ru`, POST form body (implementation pin; live confirmation NOT RUN) |

## Identity and authorization setup

- Dedicated test Android account used: TBD
- Dedicated private community used: TBD
- Community messages/Long Poll configured: TBD
- Requested scopes: TBD
- Actually granted scopes: TBD
- Token acquisition was official and documented: TBD

## Pre-POC security gate

| Control | Result | Evidence/notes |
|---|---|---|
| Mandatory account allowlist | NOT RUN | |
| Private-dialog binding | NOT RUN | |
| Token absent from URL/logs | NOT RUN | Code is designed for POST form-body token transport and redacted fixed-state UI; artifact/runtime review pending. |
| Long Poll key absent from errors/logs | NOT RUN | |
| Timeouts/cancellation/backoff | NOT RUN | |
| Stop → Start race regression | NOT RUN | |
| Send failure propagation | NOT RUN | |
| POC-only command isolation | NOT RUN | |
| Electron IPC/webview review | NOT RUN | |
| Android backup/log review | NOT RUN | SDK encrypted preference files are excluded in source backup rules; built artifact/device review pending. |

## Functional results

| Test | Result | Count/latency | Notes |
|---|---|---|---|
| Official Android login | NOT RUN | | |
| Android `messages.send` PING | NOT RUN | | |
| Creator Group Long Poll receive | NOT RUN | | |
| Creator correlated PONG | NOT RUN | | |
| Android history receive | NOT RUN | | |
| 20 sequential exchanges | NOT RUN | | |
| Creator restart recovery | NOT RUN | | |
| Android restart recovery | NOT RUN | | |
| Target restricted network | NOT RUN | | |

## Negative and lifecycle tests

| Test | Result | Notes |
|---|---|---|
| Non-allowlisted user rejected | NOT RUN | |
| Group conversation rejected | NOT RUN | |
| Malformed/oversized message rejected | NOT RUN | |
| Legacy operational command rejected in POC mode | NOT RUN | |
| Wrong community/request ID/nonce rejected | NOT RUN | |
| Stale/duplicate response rejected | NOT RUN | |
| HTTP 4xx/5xx/malformed JSON handled | NOT RUN | |
| Timeout/cancel handled | NOT RUN | |
| Stop → immediate Start leaves one poller | NOT RUN | |
| Refresh | NOT RUN | |
| Logout | NOT RUN | |
| Re-login | NOT RUN | |

## Security observation

- Secret-canary scan result: NOT RUN
- Logs/artifacts reviewed by: TBD
- Unexpected token, key, cookie, link, room ID or credential exposure: TBD
- Account validation/captcha behavior: TBD

## Limitations and unresolved risks

- The registered VK Android application has not yet demonstrated that the `messages` scope is available and actually granted. Failure here requires NO-GO for this transport.
- The mobile client secret cannot be kept confidential inside an APK; security depends on VK-side package/signature binding and appropriate application configuration.
- Gradle Android unit-test, full-lint and APK assembly gates have not yet been confirmed for this implementation branch; host-side JVM compilation/tests do not replace those gates.
- VK ID 2.7.1 may surface server, network and invalid/expired-refresh failures through the same `FailedApiCall` callback, so the live refresh test must not infer the cause from the fixed refresh-failure UI state.
- Refresh/logout/re-login behavior, SDK storage cleanup and backup exclusion have not yet been verified on the physical POC device.
- Restricted-network latency, reliability, VK validation/captcha behavior and account restrictions remain unknown until the versioned signed live procedure is run.
- Source-level redaction controls still require built-artifact and runtime canary review before evidence can be accepted.

## Decision

**PENDING**

Decision rationale: TBD

Approved by/date: TBD

### GO consequences

Only after an approved GO may the project proceed to final WLB2/pairing design and production session orchestration.

### NO-GO consequences

Stop implementation of the proposed VK messaging control transport, preserve evidence, and evaluate a different official transport or product architecture without using unofficial token-acquisition methods.
