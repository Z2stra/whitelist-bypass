# Android official VK API PING/PONG POC

## Status

The Android implementation is merged into `main`; public CI covers unit tests, full lint, debug assembly and synthetic signed-POC packaging. Local persistent-key/device/VK/network validation has not yet been completed, and this document is not GO evidence.

WLB2, pairing, `SessionManager`, `PlatformAdapter`, `ENSURE_CONNECTION` and production orchestration remain out of scope until `vk-api-poc-results.md` contains an approved GO.

## Fixed transport contract

- Authentication uses official VK ID SDK `2.7.1` and requests the exact `messages` scope.
- VK calls are POST form submissions to `https://api.vk.ru/method/messages.send` and `https://api.vk.ru/method/messages.getHistory`.
- The access token is carried only in the POST form body. It must not appear in a URL, UI state or diagnostic message.
- VK API version is pinned to `5.131` to match the already merged Creator POC contract.
- The configured community ID is a positive number. Android derives the private community dialog as `peer_id=-communityId`; it does not send that value as a positive acting `group_id`.
- Android captures the maximum history `conversation_message_id` before sending PING.
- Android sends exactly `WLB-POC/1 PING <requestId> <nonce>` with a fresh positive `random_id`.
- Polling is bounded by a 60-second deadline, with cancellable 1/2/4-second intervals.
- Android accepts only a message newer than the baseline where `from_id == -communityId`, `peer_id == -communityId`, `out == 0` and the entire body equals `WLB-POC/1 PONG <sameRequestId> <sameNonce>`.
- The first matching PONG completes the exchange. Duplicate PONGs have no further effect.

The PING/PONG grammar and Creator isolation rules are defined in `wlb-poc1.md`.

## Local VK configuration

Live application values must not be committed. Copy `android-app/vk-poc.local.properties.example` to the ignored `android-app/vk-poc.local.properties` and fill all three properties:

```properties
wlb.vk.clientId=<positive VK ID application ID>
wlb.vk.clientSecret=<VK ID mobile application credential>
wlb.vk.groupId=<positive dedicated community ID>
```

An atomic environment-only alternative is available:

```text
WLB_VK_ID_CLIENT_ID
WLB_VK_ID_CLIENT_SECRET
WLB_VK_POC_GROUP_ID
```

If any `WLB_VK_*` value is present, all three must come from the environment; missing values are not filled from the property file. Signed POC packaging fails closed when the configuration is incomplete.

The VK ID application must be registered for package `app.northbridge.mobile` and the certificate that signs the installed POC APK. The mobile client secret is embedded in the application manifest as required by the SDK and is therefore extractable from the APK. Treat it as a public-app credential whose useful scope is constrained by VK-side package/signature registration. Do not treat it as a confidential server secret, commit it, paste it into issues or include it in screenshots/logs.

## UI and lifecycle boundary

- Debug exposes the experimental POC entry from Settings; the normal release UI does not expose it, and the release manifest removes both VK ID SDK authentication activities, including its exported redirect receiver.
- The `poc` manifest exposes only the neutral `app.northbridge.mobile.EntryActivity` launcher alias and removes the VPN/tunnel services, tile, provider and normal main Activity from that artifact.
- The screen exposes only fixed authorization/exchange states and bounded status information. It has no token, user/community ID, request ID, nonce, raw message or server-error field.
- One exchange can be active at a time. Explicit cancel, logout or final ViewModel teardown cancels the outstanding coroutine, disconnects an in-flight API call and discards its correlation values; ordinary Activity recreation keeps the bounded operation in the retained ViewModel.
- An authentication-expired API response permits one SDK refresh-and-retry path. Missing `messages`, unusable refresh and required reauthentication become fixed safe states. VK ID 2.7.1 can report some server, network and invalid/expired-refresh failures through the same `FailedApiCall` type, so the POC deliberately labels that result only as a refresh failure and offers Retry, Login and Logout; the physical-device test must determine the actual expired/invalid behavior.
- Logout uses the SDK logout path; device verification must still confirm retained authentication has been removed and re-login works without manual file/database edits.

## Storage, backup and diagnostics

VK ID SDK owns access/refresh token persistence in its Android encrypted preferences. Application code does not copy token values into the existing general preferences or POC UI state.

Both Android backup rule formats exclude `vkid_encrypted_shared_prefs.xml` from cloud backup and device transfer. The application preferences file is also excluded because the existing application contains unrelated sensitive configuration. The POC manifest keeps explicit references to both rules in addition to `allowBackup=false`; these source controls still require built-artifact/device review.

The POC does not use the existing persisted/shareable diagnostic logger. Raw tokens, user/community identifiers, request IDs, nonces, PING/PONG bodies, response bodies and VK/SDK error descriptions must never be written to Logcat, files, UI text, reports or screenshots. Only fixed bounded error categories may cross into presentation state.

## Validation sequence

Before any accepted live-network run:

1. Run Android unit tests, full lint and debug assembly from `android-app` and record the exact source commit.
2. Register the VK ID application for `app.northbridge.mobile` and the reviewed persistent certificate, then create the complete ignored local VK configuration.
3. Run the first signing wrapper smoke with the operator-approved certificate SHA-256 and `-InitializeSigningIdentity`; treat its two APKs as bootstrap evidence only and do not install or transfer them.
4. Review and merge the generated public `android-app/poc-signing-identity.json` in a dedicated PR.
5. Merge and validate the immutable source-free live-bundle builder, then rebuild with new monotonically increasing numbers from the identity-bearing source commit.
6. Inspect the post-identity APK and bundle to confirm one neutral launcher, removed legacy components, non-debuggable state, signature/package binding, backup/cleartext policy, manifests and checksums.
7. Perform the synthetic secret-canary review, install the accepted post-identity APK pair and verify the first-install/in-place-update chain.
8. Complete the official VK ID consent flow, confirm that the resulting grant actually contains `messages`, and run the functional, negative, refresh/logout/re-login, restart, repetition and restricted-network steps in `vk-api-poc-checklist.md`.
9. Record every result as `PASS`, `FAIL` or `BLOCKED` in `vk-api-poc-results.md` without private identifiers or message bodies.

## GO/NO-GO boundary

The most important live gate is whether the registered Android application can request and actually receive the official VK `messages` permission. Code support for requesting the scope is not proof of availability. If the scope is unavailable, cannot be granted, or official messaging is unreliable on the target network/lifecycle tests, record NO-GO and stop before WLB2 or production orchestration.

## Upstream references

- [Official VK ID Android SDK, release 2.7.1](https://github.com/VKCOM/vkid-android-sdk/tree/2.7.1)
- [Official VK API message-method schema](https://github.com/VKCOM/vk-api-schema/blob/master/messages/methods.json)

The Android POC's `v=5.131` is an intentional compatibility pin to the already merged Creator half, not a claim that it is the newest published VK schema. The signed live run must validate that this pinned contract remains accepted before any GO decision.
