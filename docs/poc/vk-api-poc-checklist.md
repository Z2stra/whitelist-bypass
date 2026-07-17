# Official VK API PING/PONG POC checklist

## Objective

Prove or reject the proposed official VK messaging control transport before implementing WLB2, pairing, session orchestration or automated platform commands.

## Status convention

- A checked implementation item means the behavior is present and has been statically reviewed in source. It does **not** mean an Android quality gate, device test, live VK exchange or GO decision passed.
- An unchecked operator/execution item remains pending.
- `vk-api-poc-results.md` is the authoritative live evidence record; it remains `NOT RUN` until the signed-device procedure is actually performed.

## Safety prerequisites

The POC must not begin with real credentials until all applicable pre-POC boxes in `PRODUCT.md` are complete and reviewed.

- [x] Creator community token/settings are never printed.
- [x] Creator requires an explicit account allowlist.
- [x] Creator accepts only an allowlisted private user dialog (`peer_id == from_id`, positive user identity).
- [x] VK API tokens are sent in POST form bodies, not URLs.
- [x] Long Poll keys and request URLs are excluded from error/log output.
- [x] Requests use bounded timeout/cancellation/backoff.
- [x] Creator Stop → immediate Start has regression coverage.
- [x] `messages.send` failures propagate.
- [x] POC mode cannot invoke legacy create/join/close commands.
- [x] Electron IPC/webview changes used by the POC are reviewed.
- [x] Android POC token, backup and diagnostic controls are implemented and statically reviewed; built-artifact review remains pending.

## POC-only message format

```text
WLB-POC/1 PING <requestId> <nonce>
WLB-POC/1 PONG <requestId> <nonce>
```

Constraints:

- The text contains exactly four case-sensitive fields separated by one ASCII space, with no leading/trailing whitespace, double spaces, tabs, newlines, control characters or extra fields.
- `requestId` is cryptographically random and matches `[A-Za-z0-9_-]{16,64}`.
- `nonce` is cryptographically random and matches `[A-Za-z0-9_-]{16,128}`.
- The complete message is at most 256 characters and does not use padded/base64 characters such as `=`, `+` or `/`.
- No links, cookies, tokens, device names, proxy data or operational commands are carried.
- Malformed, oversized, stale or unexpected messages are ignored and recorded only as redacted counters/events.

## Android implementation contract

- [x] Use official VK ID SDK `2.7.1`; request only the `messages` scope needed by this POC.
- [x] Use official VK API POST endpoints under `https://api.vk.ru`; place the access token in the form body and pin `v=5.131` to match the merged Creator contract.
- [x] Address the private community dialog with `peer_id=-<positiveCommunityId>`; do not reinterpret the community ID as a user or group-token acting context.
- [x] Generate the exact PING format and capture a history baseline before sending it.
- [x] Poll history within a fixed deadline and stop on success, timeout, logout or explicit cancellation.
- [x] Accept only an inbound message newer than the baseline where `from_id == -communityId`, `peer_id == -communityId`, `out == 0` and the entire PONG body literally matches the outstanding request ID/nonce pair.
- [x] Keep access/refresh tokens in the VK ID SDK encrypted preferences and explicitly exclude that storage from cloud backup and device transfer.
- [x] Keep raw tokens, user/community identifiers, request IDs, nonces, message bodies and raw VK/SDK errors out of the POC UI, persisted logs and normal diagnostics.
- [x] Load VK application metadata and the positive community ID only from ignored local properties or an atomic environment configuration; no live value belongs in Git.
- [x] Treat the VK mobile client secret as an extractable public-app credential: it must be bound in VK configuration to the registered package/signature and must never be presented as a server-side secret.
- [ ] Confirm that VK permits the registered application to request and actually receive `messages`; absence of that grant is a live NO-GO.
- [ ] Pass local Android unit tests, full lint and debug/POC assembly for the implementation branch.

## Android preparation

- [ ] Use a dedicated test VK account, not the operator's primary account.
- [ ] Register the Android application for package `bypass.whitelist` and the actual POC signing certificate using official VK ID tooling.
- [ ] Enable/allow the `messages` scope for that application in VK ID configuration.
- [x] Keep live VK configuration outside Git through the ignored local-property/environment boundary; the operator must also keep it out of screenshots and copied logs.
- [x] Keep the flow in an isolated debug/POC screen and make the signed `poc` artifact launcher-only.
- [x] Request the exact official `messages` permission and fail closed when it is not actually granted.
- [x] Show only fixed authorization/exchange states and bounded timing data, never token values, identities or message bodies.
- [x] Capture a history baseline before sending PING.

## Windows preparation

- [ ] Use the Electron Creator from the reviewed branch.
- [ ] Configure a dedicated private community and dedicated test account allowlist.
- [x] POC-only handling is implemented behind exact Creator argument `--vk-poc-only`; legacy commands remain unavailable in this mode.
- [ ] Confirm redacted logs with synthetic secret canaries before real credentials.
- [ ] Confirm only one active Long Poll generation exists after Stop/Start.

## Functional sequence

1. [ ] Android performs official VK ID login.
2. [ ] Android verifies the resulting granted scopes without logging token data.
3. [ ] Android sends one PING to the community dialog through `messages.send`.
4. [ ] Creator receives the PING through Group Long Poll.
5. [ ] Creator validates version, private-dialog binding, account allowlist, request ID and nonce.
6. [ ] Creator sends exactly one correlated PONG.
7. [ ] Android polls message history from the recorded baseline.
8. [ ] Android accepts only a PONG from the expected community identity with an exact request ID/nonce match.
9. [ ] Android stops polling after success or deadline.

## Implemented negative-test coverage

The checked cases below describe code/test coverage, not a successful live run. Live results remain `NOT RUN` in the results template.

- [x] Wrong VK user ID.
- [x] Correct user in a group conversation rather than private dialog.
- [x] Wrong protocol version.
- [x] Unknown command or legacy `/vk` command while POC-only mode is active.
- [x] Oversized input.
- [x] Invalid request ID/nonce characters or length.
- [x] Wrong community response identity or direction.
- [x] Wrong request ID.
- [x] Wrong nonce.
- [x] Message at/before the history baseline or after the deadline.
- [x] Duplicate PONG is harmless because Android accepts the first matching response and stops; the POC has no operational side effects.
- [x] VK HTTP 4xx/5xx and malformed JSON are mapped to bounded safe failures without raw response/error logging.
- [x] Network timeout and cancellation.
- [x] Creator Stop → immediate Start.
- [ ] Restart Android and Creator independently.

## Token lifecycle

- [x] Refresh, reauthentication-required and missing-`messages` states are implemented without returning token material to the UI/core protocol.
- [x] Logout cancels an outstanding exchange and asks VK ID SDK to clear its retained auth state.
- [x] Indeterminate VK ID `FailedApiCall` refresh failures remain a fixed safe failure with Retry, Login and Logout actions; the UI does not claim to distinguish network/server failure from an invalid or expired refresh token.
- [ ] Refresh token path is exercised before expiry where supported.
- [ ] Expired/invalid refresh produces the expected re-login state on a device.
- [ ] Logout removal of locally retained SDK auth state is verified on a device and in backup/artifact review.
- [ ] Re-login restores PING/PONG without manual database/file edits.

## Repetition and network validation

- [ ] At least 20 sequential exchanges without manual intervention.
- [ ] Creator restart followed by successful exchange.
- [ ] Android restart followed by successful exchange.
- [ ] Test on the target restricted mobile network.
- [ ] Record latency distribution and failures without message bodies or identifiers.
- [ ] Record any validation/captcha/account restriction behavior.

## Required evidence

Complete `vk-api-poc-results.md` with:

- exact source commit;
- app/tool versions;
- test account/community roles described without secrets;
- granted scopes;
- pass/fail matrix;
- redacted logs and metrics;
- known limitations;
- explicit GO or NO-GO decision and approver.

## Decision rule

A GO requires official permission and API behavior to work reliably under the target network and lifecycle tests without unsafe token acquisition or recurring account validation. Otherwise record NO-GO and stop the architecture before WLB2 or session-control implementation.
