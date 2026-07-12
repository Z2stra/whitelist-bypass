# Control-plane threat model

## Status and boundary

This is the initial threat model for the staged VK control-plane work. It is not a claim that the current application is hardened. The pre-POC security gate in `PRODUCT.md` must be completed before real credentials are entered.

The data-plane tunnel and the proposed control plane are separate security domains. A successful platform call does not authenticate a control command, and a valid control message does not automatically authorize access to a local process or stored credential.

## Assets

- VK community token and Long Poll key.
- Android VK access/refresh tokens and VK application secret, where applicable.
- Per-device control secrets and future WLB2 key material.
- Platform login cookies and call/join links.
- Upstream proxy username/password.
- Android VPN state, saved call configurations and device identity.
- Windows process-control authority for relay/headless creators.
- Audit metadata that could identify a user, community, room or device.

## Trust zones

1. **Android application process** — user-facing UI, token lifecycle, history polling and future pairing material.
2. **VK infrastructure** — identity, message delivery, Group Long Poll and history APIs; trusted for availability/delivery only, not for end-to-end command secrecy.
3. **Electron main process** — privileged process supervision, filesystem/network access and transport lifecycle.
4. **Electron renderer** — UI process; must not be treated as a secret store or unrestricted authority.
5. **Remote platform web content/webviews** — untrusted network content even when loaded from an expected vendor origin.
6. **Headless/relay child processes** — local privileged helpers whose stdout/stderr are untrusted input to parsers and logs.
7. **Local persistent storage and backups** — potentially readable by another local account, malware, backup tooling or diagnostic collection.
8. **CI/build artifacts and issue/PR logs** — public or broadly visible unless explicitly protected.

## Primary threat actors

- An unrelated VK user attempting to command the community bot.
- A participant in a VK group conversation rather than the intended private dialog.
- A compromised or malicious remote page loaded in an Electron webview.
- A local unprivileged process or malware reading logs/configuration.
- A network intermediary causing failures that include secret-bearing URLs in error text.
- A replaying attacker who copies old control messages.
- A compromised paired Android device.
- An operator accidentally committing or publishing a secret.
- Malformed child-process output attempting parser confusion or log injection.

## High-priority abuse cases and required controls

### Unauthorized bot commands

**Risk:** a message is accepted from the wrong VK account or from a group conversation.

**Required controls:** mandatory explicit user allowlist; private-dialog binding (`peer_id == from_id`); POC-only command parser; rate limits; correlation IDs; audit-safe denial logging.

### Credential leakage through URLs and errors

**Risk:** access tokens or the Long Poll `key` appear in request URLs, exception messages, proxy logs or screenshots.

**Required controls:** send API tokens in POST bodies; never log raw request URLs for secret-bearing endpoints; construct errors from operation/status/error code; redact query parameters and headers as defense in depth.

### Renderer/webview privilege escalation

**Risk:** remote content gains Node/Electron capability or invokes privileged IPC to export cookies, read files or start processes.

**Required controls:** remote webviews with Node integration disabled, context isolation and sandbox enabled; strict origin allowlist; navigation and popup denial by default; minimum permissions; narrow preload API; IPC sender and argument validation; no arbitrary path arguments.

### Secret persistence in renderer storage

**Risk:** renderer XSS, DevTools access or another local process obtains community/proxy credentials from `localStorage`.

**Required controls:** main-process ownership of secrets; OS-protected storage; renderer receives only status/non-secret projections; explicit migration and deletion of legacy values.

### Functional data destroyed by redaction

**Risk:** a join link is redacted before the functional parser consumes it, breaking the application; alternatively, raw links leak because functional data and diagnostics share one channel.

**Required controls:** parse raw child output inside the privileged boundary into a typed event; send the typed value only to its authorized consumer; independently emit a redacted diagnostic event. Tests must prove both link preservation and log redaction.

### Long Poll lifecycle races

**Risk:** Stop followed by Start leaves an old polling loop active, causing duplicate command execution.

**Required controls:** monotonically increasing run generation; each loop/request checks its captured generation; abort active requests on stop/restart; bounded backoff; lifecycle tests with immediate restart.

### Hidden send failures

**Risk:** the system records success even though `messages.send` failed.

**Required controls:** propagate a typed error/result; correlation state advances only after confirmed API success; safe error messages contain no request secrets.

### Replay and key-selection ambiguity

**Risk:** an old valid message is accepted, or Windows cannot select the correct per-device key without first decrypting `deviceId`.

**Required controls:** external random `keyId`; authenticated version/direction/context in AAD; timestamp/expiry; monotonic counter or nonce registry; duplicate request/result idempotency; key revocation.

### Backup and diagnostics leakage

**Risk:** Android backup, Logcat, Electron logs, crash reports or CI artifacts contain tokens, cookies, room IDs or full payloads.

**Required controls:** backup exclusions; no token/payload logs; structured redacted events; artifact scanning; test fixtures use synthetic values only.

## POC-specific restrictions

Until a GO decision:

- The accepted wire format is limited to `WLB-POC/1 PING` and `WLB-POC/1 PONG`.
- POC mode cannot invoke legacy `/vk`, `/tm`, `/wb`, `/dion`, join-link or close-tab behavior.
- No platform cookies, proxy credentials or call links are transported by the POC.
- Responses are accepted only from the expected community identity and only when request ID/nonce match.
- POC data has a short deadline and is not persisted as production configuration.

## Residual risk requiring explicit acceptance

- VK sees message metadata and plaintext POC content; the POC is not the production confidentiality design.
- Platform cookies may remain necessary for legacy flows until those flows are migrated; their storage must be reviewed separately.
- A compromised paired endpoint can issue commands authorized to that endpoint until its key is revoked.
- Availability and account-validation behavior are controlled by third-party services.

## Security review checklist

Before entering real credentials, verify all pre-POC security boxes in `PRODUCT.md`, execute negative tests, inspect generated logs/artifacts, and record the review result in `docs/poc/vk-api-poc-results.md`.
