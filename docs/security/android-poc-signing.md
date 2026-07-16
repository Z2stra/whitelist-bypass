# Android POC signing and APK delivery boundary

- Status: code and CI implemented; persistent-key operator acceptance still pending
- Live build type: `poc`
- Live artifact: signed, non-debuggable APK only
- Package ID: `bypass.whitelist`
- Pinned verification tools: Android build-tools `36.0.0`

## 1. Trust boundary

The repository previously contained `android-app/debug.keystore`. Because that
private key was published in Git history, it can never establish a trusted APK
identity. The current tree removes it from active signing, but history rewriting
would not restore trust.

Signing responsibility is split as follows:

- `debug` uses the standard machine-local Android debug key;
- `release` remains intentionally unsigned until a separate production-signing design exists;
- `poc` produces a non-debuggable APK signed with a persistent private PKCS12 key;
- POC Android App Bundle production is unsupported;
- persistent keys/passwords never enter Git, public CI, release bundles or the separate test machine;
- public CI may generate only a disposable runner-local synthetic key;
- all accepted POC APK updates must use the same pinned public certificate identity.

## 2. APK-only delivery

```text
:app:assemblePoc   supported
:app:installPoc    supported
:app:bundlePoc     rejected
```

`bundlePoc` fails with:

```text
POC AAB is not supported; build the signed POC APK with :app:assemblePoc
```

No `.aab` file may be transferred or described as a live POC artifact.

## 3. Repository-wide guards

`Repository signing-material policy` runs on every pull request without path
filters. It rejects tracked private signing property files and common key
containers anywhere in the repository, validates the public signing identity
when that file exists, verifies representative generated outputs remain ignored,
and proves the legacy Android release-export path remains fail-closed.

For `main`, the configured branch rule requires:

```text
Repository signing-material policy / tracked-signing-material
```

If that rule is removed or the job is renamed, reopen the corresponding
`PRODUCT.md` gate.

## 4. Signing entrypoints

### 4.1 Canonical operator wrapper

Use:

```text
tools/invoke-poc-signing-smoke.ps1
```

The wrapper completes the entire non-secret Android quality gate **before**
requesting either signing password:

```text
gradlew test
gradlew lint
gradlew assembleDebug
```

It records the clean Git commit/tree before those commands and requires the same
clean provenance immediately before signed packaging and in both accepted
manifests.

Only after quality succeeds does the wrapper:

- prompt with `Read-Host -AsSecureString`;
- convert the secure strings for the child signing process;
- pass no password in command-line arguments;
- initialize or verify the public certificate identity;
- call the low-level helper with `-SkipQualityChecks` for signed packaging;
- clear all four `WLB_POC_*` variables in `finally`;
- call `ZeroFreeBSTR` for both password buffers;
- remove accepted directories if wrapper-level final validation fails.

This avoids literal password assignments in PSReadLine history and avoids
holding/exporting signing passwords during the quality phase.

### 4.2 Low-level helper

Internal CI/automation entrypoint:

```text
tools/preserve-poc-signing-smoke.ps1
```

It requires the complete process environment:

```text
WLB_POC_KEYSTORE_PATH
WLB_POC_KEYSTORE_PASSWORD
WLB_POC_KEY_ALIAS
WLB_POC_KEY_PASSWORD
```

It captures that environment once, immediately clears it from its own process,
and reintroduces it only around public-certificate export and `assemblePoc`.
When invoked directly without `-SkipQualityChecks`, its `test`, `lint` and
debug-build children therefore receive no signing secrets.

Every accepted run also requires:

```text
-ExpectedCertificateSha256 <64 hex characters>
```

The GitHub-Actions-only `-AllowSyntheticCiCertificate` switch lets public CI
verify the mechanism with a disposable certificate after the real public
identity is committed. It is rejected outside GitHub Actions.

### 4.3 Direct Gradle fallback

Direct Gradle POC builds may use ignored:

```text
android-app/keystore.properties
```

Create it from `android-app/keystore.properties.example`. Environment and
properties are indivisible alternatives; a partial environment is never
completed from the properties file.

Properties-backed builds are useful for development/CI verification, but are
not accepted as live artifacts without the operator wrapper, public identity
check and preserved manifests.

## 5. Keystore placement

Create the persistent key only on the trusted build machine and keep it outside
the repository:

```powershell
New-Item -ItemType Directory -Force D:\wlb-secrets | Out-Null

keytool.exe -genkeypair `
  -storetype PKCS12 `
  -keystore D:\wlb-secrets\wlb-poc.keystore `
  -alias wlb-poc `
  -keyalg RSA `
  -keysize 3072 `
  -validity 3650
```

Gradle and both PowerShell entrypoints canonicalize the path and reject a key
inside the repository, including ignored paths such as:

```text
repository\secrets
repository\local-secrets
repository\credentials
repository\local-artifacts
```

The key and its backup must never be copied into the repository, artifacts,
live bundle, GitHub Actions, issues/PRs or the separate test machine.

## 6. Public signing identity continuity

The private key remains secret, but its certificate SHA-256 is public and must
be pinned.

First persistent-key run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\invoke-poc-signing-smoke.ps1 `
  -KeystorePath D:\wlb-secrets\wlb-poc.keystore `
  -KeyAlias wlb-poc `
  -FirstBuildNumber 1 `
  -SecondBuildNumber 2 `
  -InitializeSigningIdentity
```

The wrapper creates:

```text
android-app/poc-signing-identity.json
```

Schema:

```json
{
  "schemaVersion": 1,
  "applicationId": "bypass.whitelist",
  "certificateSha256": "<64 lowercase hex characters>",
  "androidBuildToolsVersion": "36.0.0",
  "initializedAtUtc": "<ISO-8601 UTC>"
}
```

This file contains no secret. Review and commit it in a dedicated follow-up PR.
Until it is committed, the artifact/signing gate remains operationally
incomplete.

The `poc.1`/`poc.2` pair produced by this initialization run is **bootstrap
evidence only** because its source commit predates the committed identity file.
Do not install or transfer that pair. After the identity PR is merged, rerun the
wrapper with new numbers, for example `3` and `4`; only that post-commit pair is
eligible for physical update testing.

Every later wrapper run loads the committed identity and rejects a different
keystore certificate. The future live-bundle builder must verify the same file.

## 7. Build-number semantics

Gradle only enforces `WLB_POC_BUILD_NUMBER` in `1..999`; it does not remember
previously accepted builds.

```text
debug/release versionName = 0.3.7
debug/release versionCode = 3007000

poc.N versionName = 0.3.7-poc.N
poc.N versionCode = 3007000 + N
```

The future bundle builder must reject non-increasing numbers, reused directories,
existing files, manifest/version mismatch and signer mismatch with
`android-app/poc-signing-identity.json`.

## 8. Post-identity signing/update smoke

After the public identity is merged, omit `-InitializeSigningIdentity` and use
new monotonically increasing numbers:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\invoke-poc-signing-smoke.ps1 `
  -KeystorePath D:\wlb-secrets\wlb-poc.keystore `
  -KeyAlias wlb-poc `
  -FirstBuildNumber 3 `
  -SecondBuildNumber 4
```

The wrapper/helper jointly enforce:

1. quality before password prompts;
2. clean commit/tree continuity through final manifests;
3. an exclusive repository-scoped low-level helper lock;
4. immediate rejection of a concurrent second helper;
5. external-keystore validation;
6. exact certificate match with the pinned identity;
7. two numbered signed APKs;
8. inspection with pinned `aapt` and `apksigner`;
9. transactional pair acceptance.

Safety tests inject failures after the first move, second move and final
validation; every failure removes all already moved directories. They also
verify lock contention, repository-local key rejection and environment cleanup.

## 9. Preserved manifest

Post-identity example:

```text
local-artifacts/
└── poc-signing-smoke/
    ├── 0.3.7-poc.3/
    │   ├── whitelist-bypass-0.3.7-poc.3.apk
    │   └── BUILD-MANIFEST.json
    └── 0.3.7-poc.4/
        ├── whitelist-bypass-0.3.7-poc.4.apk
        └── BUILD-MANIFEST.json
```

Manifest schema 2:

```json
{
  "schemaVersion": 2,
  "applicationId": "bypass.whitelist",
  "version": "0.3.7-poc.3",
  "versionCode": 3007003,
  "gitCommit": "<full commit SHA>",
  "gitTree": "<full tree SHA>",
  "apk": "whitelist-bypass-0.3.7-poc.3.apk",
  "apkSha256": "<sha256>",
  "certificateSha256": "<public certificate sha256>",
  "debuggable": false,
  "androidBuildToolsVersion": "36.0.0",
  "builtAtUtc": "<ISO-8601 UTC>"
}
```

No manifest contains passwords, private key material, cookies, VK IDs or
credentials.

## 10. First install and in-place update

Use only the pair built **after** the public identity commit:

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$PocFirst = '.\local-artifacts\poc-signing-smoke\0.3.7-poc.3\whitelist-bypass-0.3.7-poc.3.apk'
$PocSecond = '.\local-artifacts\poc-signing-smoke\0.3.7-poc.4\whitelist-bypass-0.3.7-poc.4.apk'

& $Adb uninstall bypass.whitelist
& $Adb install $PocFirst
if ($LASTEXITCODE -ne 0) { throw 'Initial persistent-key POC installation failed' }

& $Adb install -r $PocSecond
if ($LASTEXITCODE -ne 0) { throw 'In-place persistent-key POC update failed' }
```

After transition, do not deploy debug APKs or Android Studio debug runs to the
dedicated POC device. Install only APKs signed by the pinned persistent key.

## 11. Separate-machine gate

Until the source-free bundle is implemented and verified, prohibit ad-hoc APK
copying, live VK credentials without immutable manifests/checksums, mixed
Creator/APK commits, reused numbers/directories and certificate mismatch.

Every VK/network iteration must use one immutable bundle containing:

```text
compiled Creator
POC-only launcher
signed APK
build manifest
checksums
```

## 12. CI policy

Public CI never uses the real persistent key.

Android CI uses actions pinned to full commit SHAs, runs the Android DoD,
verifies fail-closed packaging, rejects a repository-local key, checks both
Gradle signing sources, validates unsigned release and rejects POC AAB.

Windows CI parses both PowerShell entrypoints, runs safety self-tests, executes
the operator pre-prompt quality phase without a key, signs through the low-level
helper with a disposable expected certificate, independently rechecks both APKs
and schema-2 manifests, and publishes neither key nor POC APK.
