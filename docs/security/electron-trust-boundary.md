# Electron trust boundary

- Status: Implemented for the IPC and remote-content portion of the pre-POC gate
- Scope: Creator application page, IPC entry points, remote webviews, navigation, redirects, popups, permissions and legacy CSP exceptions
- Adjacent credential milestone: implemented in `protected-settings-and-cookies.md`; residual same-user and legacy child-process risks remain

## Problem

The original Electron Creator trusted remote content and renderer input too broadly:

- the application page ran with Node integration and without context isolation;
- remote webviews could request Node integration;
- permissions were allowed globally;
- any HTTP/HTTPS navigation or popup was accepted;
- CSP headers were stripped from every session response;
- IPC handlers did not verify the sender and accepted weakly validated arguments;
- call-script loading accepted an arbitrary renderer-supplied filename.

That combination allowed a compromised renderer or remote platform document to reach privileged operations such as process control, cookie export and bot configuration.

## Implemented boundary

### Root application page

The BrowserWindow page runs with:

```text
nodeIntegration=false
contextIsolation=true
webSecurity=true
allowRunningInsecureContent=false
```

The page main world does not receive `require`, Node globals or the privileged bridge. Trusted UI code is loaded from the local preload isolated world. The root page has a restrictive CSP and may navigate only to the exact Creator `index.html` file.

The root BrowserWindow currently retains `sandbox=false` because the trusted local UI executes from the isolated preload world. This is a deliberate compatibility boundary, not a claim that the application page renderer is fully sandboxed. Untrusted remote webviews and accepted popup windows are sandboxed separately and do not receive this preload.

### IPC

Every invoke handler is registered through a trusted wrapper. A call is accepted only when:

- `event.sender` is the current main BrowserWindow;
- `event.senderFrame` is its main frame;
- the frame URL equals the exact local Creator `index.html` URL;
- the argument count matches the channel contract;
- all enum, URL, identifier, object and sensitive-string arguments pass runtime validation.

Remote URLs are HTTPS-only, reject embedded credentials and non-default ports, and must match the explicit platform host allowlist. Control characters and oversized values are rejected. Call-script loading uses a fixed filename allowlist and a canonical directory containment check.

### Remote webviews

Before attachment, every guest is forced to:

```text
nodeIntegration=false
nodeIntegrationInSubFrames=false
nodeIntegrationInWorker=false
contextIsolation=true
sandbox=true
webSecurity=true
allowRunningInsecureContent=false
```

Guest preload paths are removed. The guest must use the dedicated Creator partition and an HTTPS URL belonging to an explicit platform host allowlist.

Navigation and redirects are denied outside the allowlist. Popups are denied unless their destination is allowlisted; accepted popup windows receive the same sandboxed preferences. Device and display-capture permissions are denied. Media and fullscreen are default-deny and are allowed only on active call origins: VK, Telemost, DION and `stream.wb.ru`; account/login pages such as `passport.yandex.ru` do not receive them.

### Legacy CSP exception

CSP removal is no longer global. It is limited to document frames on the legacy VK and Telemost origins that require existing hook injection. This exception remains a known compatibility/security tradeoff and is covered by manual Windows regression testing.

## Verification

Automated checks cover:

- platform URL and lookalike rejection;
- HTTPS-only navigation and rejection of non-default ports;
- permission default-deny behavior and denial on auth-only origins;
- forced guest preferences and preload removal;
- exact local-file IPC sender matching, including Windows path normalization;
- script traversal rejection;
- runtime argument and control-character validation;
- static absence of Node integration and global allow-all handlers;
- an Electron/Xvfb smoke test proving that the Creator UI boots while `require` and `window.bridge` are unavailable in the page main world.

The CI smoke test keeps Chromium sandboxing enabled. On the Ubuntu runner, the Electron `chrome-sandbox` helper is configured with root ownership and mode `4755`; the test does not use `--no-sandbox`.

## Adjacent completed work and residual risk

The isolated `WLB-POC/1` handler and main-process protected-settings/cookie-export milestone are now implemented. See `protected-settings-and-cookies.md` for migration behavior, Windows DPAPI verification and the remaining same-user, persistent Chromium-profile and child-process command-line risks.
