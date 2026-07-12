# Electron trust boundary

- Status: Implemented for the pre-POC gate
- Scope: Creator root renderer, IPC entry points, remote webviews, navigation, popups, permissions and legacy CSP exceptions
- Remaining adjacent risk: long-lived credentials still live in renderer storage and must move to protected main-process storage before real credentials are used

## Problem

The original Electron Creator trusted remote content and renderer input too broadly:

- the root page ran with Node integration and without context isolation;
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

### IPC

Every invoke handler is registered through a trusted wrapper. A call is accepted only when:

- `event.sender` is the current main BrowserWindow;
- `event.senderFrame` is its main frame;
- the frame URL equals the exact local Creator `index.html` URL;
- the argument count matches the channel contract;
- all enum, URL, identifier, object and sensitive-string arguments pass runtime validation.

Call-script loading uses a fixed filename allowlist and a canonical directory containment check.

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

Navigation and redirects are denied outside the allowlist. Popups are denied unless their destination is allowlisted; accepted popup windows receive the same sandboxed preferences. Device and display-capture permissions are denied. Only media and fullscreen requests from allowlisted origins are accepted.

### Legacy CSP exception

CSP removal is no longer global. It is limited to document frames on the legacy VK and Telemost origins that require existing hook injection. This exception remains a known compatibility/security tradeoff and is covered by manual Windows regression testing.

## Verification

Automated checks cover:

- platform URL and lookalike rejection;
- HTTPS-only navigation;
- permission default-deny behavior;
- forced guest preferences and preload removal;
- exact local-file IPC sender matching, including Windows path normalization;
- script traversal rejection;
- runtime argument validation;
- static absence of Node integration and global allow-all handlers;
- an Electron/Xvfb smoke test proving that the Creator UI boots while `require` and `window.bridge` are unavailable in the page main world.

## Remaining work

This boundary does not make real credentials acceptable yet. The following pre-POC items remain:

1. Introduce the isolated `WLB-POC/1` PING/PONG handler and ensure operational commands are disabled in POC mode.
2. Move VK token and proxy credentials out of renderer `localStorage` into main-process OS-protected storage.
3. Review platform cookie persistence and export UX before production use.
