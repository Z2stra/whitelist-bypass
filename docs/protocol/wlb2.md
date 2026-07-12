# WLB2 control-envelope draft

## Status

Draft only. Do not implement production pairing or commands until the official VK API PING/PONG POC has a documented GO result.

## Goals

- Versioned, authenticated control messages transported through a third-party messaging channel.
- Per-device keys with deterministic lookup.
- Replay resistance, expiry and idempotency.
- Transport-neutral JSON payloads.
- No secret or personal identifier required in diagnostic logs.

## External envelope

```text
WLB2.<keyId>.<base64url(nonce || ciphertext || tag)>
```

Where:

- `WLB2` is the protocol/version marker.
- `keyId` is a random, non-personal identifier assigned during pairing. It selects a key before decryption and is authenticated as AAD.
- `nonce` is unique for the selected key and algorithm.
- `ciphertext || tag` is an AEAD result.

The earlier two-part form without `keyId` is rejected because the receiver cannot choose among multiple per-device keys when `deviceId` exists only inside ciphertext.

## Cryptography

The algorithm suite is not final until Phase 3. A candidate is XChaCha20-Poly1305 with a 24-byte random nonce and 256-bit key. The implementation must use a maintained library, fixed test vectors and constant-time verification supplied by that library rather than custom cryptography.

## Authenticated additional data

AAD must bind at least:

```text
protocol = WLB2
keyId
suite/version
direction = android-to-creator | creator-to-android
owner/community context identifier
```

The exact canonical encoding must be specified before implementation. String concatenation without unambiguous length/canonical rules is not acceptable.

## Plaintext payload

Canonical JSON object (fields may be extended only under versioning rules):

```json
{
  "v": 2,
  "type": "request | result | event | error",
  "requestId": "random-id",
  "deviceId": "stable-paired-device-id",
  "issuedAt": 0,
  "expiresAt": 0,
  "counter": 0,
  "command": "session.create",
  "body": {}
}
```

Requirements:

- `requestId` is globally unpredictable and used for idempotency/correlation.
- `issuedAt`/`expiresAt` are bounded by a documented clock-skew policy.
- `counter` is monotonic per key/direction, or an equivalent persisted replay mechanism must be selected.
- `command` comes from a closed allowlist.
- Unknown critical fields or unsupported versions are rejected.
- Payload and envelope size limits are enforced before allocation/decryption.

## Replay and idempotency

The receiver must:

1. reject expired or implausibly future messages;
2. reject duplicate nonce/counter values for the key and direction;
3. cache completed `requestId` results for a bounded window;
4. return the prior result for an exact idempotent retry rather than repeat a side effect;
5. reject a reused `requestId` whose authenticated command/body differ.

State persistence and crash recovery must be designed before production use.

## Key lifecycle

Pairing creates:

- random `keyId`;
- independent per-device control secret;
- owner/community binding;
- creation time and optional expiry;
- revocation state.

Key rotation assigns a new `keyId`. Revoked keys are denied before decryption where possible. The stable Android `deviceId` is not required in the external envelope.

## Error handling

External errors reveal only a stable category and correlation ID. Diagnostic details are stored as structured redacted events. Authentication failure must not reveal whether a `keyId`, nonce, tag or payload field was the exact cause.

## Transport requirements

The VK transport is a delivery mechanism only. It must not:

- reinterpret authenticated command fields;
- grant authority based solely on a VK message;
- log full envelopes or plaintext payloads;
- silently truncate or normalize messages.

## POC separation

The official API POC deliberately uses a separate non-production format:

```text
WLB-POC/1 PING <requestId> <nonce>
WLB-POC/1 PONG <requestId> <nonce>
```

No WLB2 cryptography, pairing, session command or operational link is added until the GO decision.

## Open decisions before Phase 3

- Final AEAD suite and library for TypeScript/Kotlin/Go interoperability.
- Canonical AAD and JSON encoding.
- Counter persistence and rollback handling.
- Pairing bootstrap, confirmation and recovery.
- Key rotation/revocation UX.
- Maximum payload sizes and fragmentation policy.
- Exact owner/community context representation.
