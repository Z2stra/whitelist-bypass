# Official VK API PING/PONG POC checklist

## Objective

Prove or reject the proposed official VK messaging control transport before implementing WLB2, pairing, session orchestration or automated platform commands.

## Safety prerequisites

The POC must not begin with real credentials until all applicable pre-POC boxes in `PRODUCT.md` are complete and reviewed.

- [ ] Community token/settings are never printed.
- [ ] Explicit account allowlist is mandatory.
- [ ] Only a private dialog is accepted (`peer_id == from_id`).
- [ ] VK API token is sent in a POST body, not a URL.
- [ ] Long Poll key and request URL cannot leak through errors.
- [ ] Requests have bounded timeout/cancellation/backoff.
- [ ] Stop → immediate Start has a regression test.
- [ ] `messages.send` failures propagate.
- [ ] POC mode cannot invoke legacy create/join/close commands.
- [ ] Electron IPC/webview changes used by the POC are reviewed.
- [ ] Android backup/log behavior has been reviewed.

## POC-only message format

```text
WLB-POC/1 PING <requestId> <nonce>
WLB-POC/1 PONG <requestId> <nonce>
```

Constraints:

- `requestId` and `nonce` are cryptographically random URL-safe values with strict length/character limits.
- No links, cookies, tokens, device names, proxy data or operational commands are carried.
- Malformed, oversized, stale or unexpected messages are ignored and recorded only as redacted counters/events.

## Android preparation

- [ ] Use a dedicated test VK account, not the operator's primary account.
- [ ] Register the Android application for package `bypass.whitelist` using official VK ID tooling.
- [ ] Keep client secret and tokens outside Git and screenshots.
- [ ] Implement the flow in an isolated debug/POC screen or source set.
- [ ] Request the exact official messaging permission under test.
- [ ] Record token metadata only (scope/expiry), never token values.
- [ ] Capture a history baseline before sending PING.

## Windows preparation

- [ ] Use the Electron Creator from the reviewed branch.
- [ ] Configure a dedicated private community and dedicated test account allowlist.
- [ ] Enable POC-only handling; legacy commands remain unavailable in this mode.
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

## Negative tests

- [ ] Wrong VK user ID.
- [ ] Correct user in a group conversation rather than private dialog.
- [ ] Wrong protocol version.
- [ ] Unknown command or legacy `/vk` command while POC-only mode is active.
- [ ] Oversized input.
- [ ] Invalid request ID/nonce characters or length.
- [ ] Wrong community response identity.
- [ ] Wrong request ID.
- [ ] Wrong nonce.
- [ ] Message older than history baseline/deadline.
- [ ] Duplicate PING does not produce duplicate side effects.
- [ ] VK HTTP 4xx/5xx and malformed JSON.
- [ ] Network timeout and cancellation.
- [ ] Stop → immediate Start.
- [ ] Restart Android and Creator independently.

## Token lifecycle

- [ ] Refresh token path is exercised before expiry where supported.
- [ ] Expired/invalid refresh produces an explicit re-login state.
- [ ] Logout removes locally retained auth state.
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
