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

### Security status

- No security implementation is claimed by this documentation-only milestone.
- Real VK credentials, platform cookies and proxy passwords remain prohibited until the pre-POC security gate in `PRODUCT.md` is implemented, tested and reviewed.

### Known baseline debt

- The upstream Android debug APK builds, but Android lint is not yet green. The complete report must be classified before the POC implementation is accepted.
- Creator quality scripts and security regression tests are part of the next code milestone, not this documentation change.
