# Protected Creator settings and platform cookies

- Status: implemented for the Windows pre-POC credential gate
- Scope: VK community token, upstream SOCKS credentials, legacy renderer migration, headless cookie hand-off and cookie export UX
- Primary Windows backend: Electron `safeStorage` backed by Windows DPAPI

## Problem

The original Creator kept the VK community token and upstream proxy username/password in renderer `localStorage`. The renderer also received those values whenever the settings dialog opened. In addition, the UI could export all platform cookies as a ZIP and headless launches wrote reusable cookie JSON files under the persistent application-data directory.

That design exposed long-lived credentials to renderer compromise, DevTools, Chromium storage inspection, backup/diagnostic collection and accidental file sharing.

## Protected settings boundary

The Electron main process now owns the complete secret-bearing settings object. It persists a versioned encrypted envelope at:

```text
<userData>/protected-settings.v1.json
```

The plaintext payload is encrypted through Electron `safeStorage`. On Windows the expected backend is `windows-dpapi`. The application refuses to save credentials when OS-protected encryption is unavailable. In particular, the Linux `basic_text` fallback is rejected instead of being treated as protected storage.

The renderer receives only a non-secret projection:

```text
tokenConfigured
usernameConfigured
passwordConfigured
groupId
allowed user IDs
SOCKS host:port
protection backend/status
```

It never receives the stored token, proxy username or proxy password. Starting the bot is a zero-argument IPC operation: the main process reads the token from the protected store. Upstream proxy settings are also applied inside the main process.

Secret updates use explicit operations:

```text
keep
replace
clear
```

A blank settings field therefore cannot accidentally erase a stored secret or cause the current secret to be returned to the renderer.

## Legacy migration

At first launch after upgrade, the trusted local renderer reads the two legacy keys:

```text
botSettings
upstreamProxy
```

It submits them once to a sender-validated IPC migration handler. The main process encrypts and persists the values, then returns only the non-secret projection. Renderer plaintext keys are deleted only after that operation succeeds. If migration fails, the old values are retained so that credentials are not silently destroyed; a later successful protected save removes the legacy keys.

The migration is idempotent and never overwrites an already configured protected value with stale renderer data.

## File and failure handling

- Writes are serialized to prevent concurrent IPC updates from losing data.
- Creator enforces a single-instance lock so separate application processes cannot race the same protected-settings file.
- A successful settings replacement stops active bot, relay and headless processes before the replacement proxy credentials become active; old values are not left in long-running process arguments.
- Proxy username/password values are treated as opaque credentials and are not trimmed or normalized.
- The encrypted envelope is written through a random temporary file and then replaced.
- File permissions are requested as `0600` where the operating system supports POSIX modes.
- An unreadable, unsupported or undecryptable store is quarantined with a `.corrupt-<timestamp>` suffix when possible.
- Error paths return generic messages and do not log ciphertext, plaintext or filesystem paths containing private data.
- A dedicated Windows GitHub Actions smoke test writes synthetic credentials, checks that they do not appear in the file or renderer projection, reloads the file through DPAPI and verifies successful decryption.

## Platform cookies

Platform sessions still use Electron's persistent `persist:creator` Chromium profile because legacy VK, Telemost, WB Stream and DION login flows depend on browser sessions. This remains a local-account security boundary and is not presented as end-to-end protected application storage.

The following risks were reduced:

- The **Export Cookies** UI and raw-cookie ZIP IPC were removed.
- Old `cookies-*.json` files in the application-data directory are deleted on startup.
- Each headless launch receives a random, process-scoped temporary cookie file.
- The temporary directory/file use restrictive modes where supported.
- The file is deleted on child error, close, explicit kill and application shutdown.
- Stale crash remnants are removed on the next startup.
- Cookie domain selection now requires an exact domain or proper subdomain boundary; lookalikes such as `evilvk.com` do not match `vk.com`.
- Cookie values and WB device IDs are not written to normal Creator logs.

## Residual risk

This milestone reduces accidental disclosure and cross-account access; it does not protect against malware already executing as the same Windows user. Electron documents that Windows `safeStorage` uses DPAPI and that another application running in the same user context can potentially obtain the decrypted data. Platform cookies in the Chromium profile have the same local-user trust limitation.

Upstream proxy username/password are still forwarded to existing Go child binaries through command-line flags because those binaries do not yet expose a secret-stdin or inherited-handle contract. A same-user process inspector or administrator may observe those transient arguments. Replacing that interface requires coordinated Go changes and is tracked as remaining hardening, not hidden by this milestone.

Previously exported `cookies.zip` files outside the Creator data directory cannot be located safely by the application and must be deleted manually by the operator.

## Operational rule

Real credentials may be entered for the controlled official VK POC only after this milestone is merged, the Windows DPAPI smoke is green, and the local Creator build containing the change has been installed or run. Tokens, proxy passwords and cookie archives must never be attached to issues, PRs or CI logs.
