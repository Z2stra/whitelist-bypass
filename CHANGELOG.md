# Changelog

All notable project changes made as part of the staged control-plane work are recorded here. This file does not retroactively describe every upstream release.

## Unreleased

### Documentation

- Established `PRODUCT.md` as the source of truth for scope, status, quality gates and the mandatory official VK API GO/NO-GO POC.
- Recorded the decision to use the existing Electron Creator as the Windows v1 control-plane host.
- Added the initial control-plane threat model.
- Added a draft platform-neutral `PlatformAdapter` contract.
- Added a WLB2 envelope draft with an external random `keyId` to avoid circular per-device key selection.
- Added the official VK API PING/PONG POC checklist and results template.

### Android

- Scoped the Quick Settings `VpnTileService` declaration to API 24 without raising the application `minSdk` from 23.
- Updated active foreground-service notifications through `startForeground`, closing Android 13 notification-permission lint errors without introducing a user-facing notification permission request.
- Added a reproducible Android CI gate for unit tests, `lintDebug`, debug APK assembly and report/artifact retention.

### Security status

- No Creator control-plane security implementation is claimed by this Android baseline milestone.
- Real VK credentials, platform cookies and proxy passwords remain prohibited until the pre-POC security gate in `PRODUCT.md` is implemented, tested and reviewed.

### Known baseline debt

- Android has no blocking lint errors; 69 non-blocking warnings remain classified as technical debt.
- Creator quality scripts and security regression tests remain part of the next code milestone.
