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
- the persistent key and passwords never enter Git, public CI, release bundles or the separate test machine;
- public CI may generate only a disposable runner-local synthetic key;
- all accepted POC APK updates must use the same public certificate identity.

## 2. APK-only delivery

Supported and rejected tasks:

```text
:app:assemblePoc   supported
:app:installPoc    supported
:app:bundlePoc     rejected
```

An attempted POC bundle build fails with:

```text
POC AAB is not supported; build the signed POC APK with :app:assemblePoc
```

No `.aab` file may be transferred or described as a live POC artifact.

## 3. Repository-wide guards

`Repository signing-material policy` runs on every pull request without path
filters. It rejects tracked private signing property files and common key
containers anywhere in the repository:

```text
*.jks
*.keystore
*.p12
*.pfx
*.pkcs12
*.ks
*.bcfks
*.pem
*.key
keystore.properties
signing.properties
vkid.local.properties
vk-poc.local.properties
```

The same workflow verifies representative generated build outputs remain
ignored and proves that the legacy `build-android.sh` path refuses to export an
unsigned release APK as `prebuilts/whitelist-bypass.apk`.

For `main`, the configured branch rule requires:

```text
Repository signing-material policy / tracked-signing-material
```

If that rule is removed or the job is renamed, the corresponding gate in
`PRODUCT.md` must be reopened.

## 4. Signing inputs

### 4.1 Canonical operator entrypoint

Use:

```text
tools/invoke-poc-signing-smoke.ps1
```

The wrapper:

- prompts for both passwords with `Read-Host -AsSecureString`;
- never asks the operator to type a password assignment into the shell;
- converts SecureString values only for the duration of the child process;
- clears all four `WLB_POC_*` signing variables in `finally`;
- calls `ZeroFreeBSTR` for both password buffers;
- initializes or verifies the public certificate identity;
- invokes the low-level helper without putting passwords in command arguments.

The low-level helper is:

```text
tools/preserve-poc-signing-smoke.ps1
```

It is an internal CI/automation entrypoint. It requires the complete process
environment:

```text
WLB_POC_KEYSTORE_PATH
WLB_POC_KEYSTORE_PASSWORD
WLB_POC_KEY_ALIAS
WLB_POC_KEY_PASSWORD
```

Immediately after capturing the values, it removes them from its own process
environment. Android quality commands therefore do not pass signing passwords
to Gradle test/lint/debug subprocesses. The values are reintroduced only around
`keytool` certificate export and `assemblePoc`, then cleared again.

### 4.2 Direct Gradle fallback

Direct Gradle POC builds may use ignored:

```text
android-app/keystore.properties
```

Create it from:

```text
android-app/keystore.properties.example
```

Environment and properties are indivisible alternatives at the Gradle layer. A
partial environment is never completed from the properties file.

Direct properties-backed builds are useful for development and CI verification,
but they are not accepted as canonical live artifacts without the operator
wrapper, public identity check and preserved manifests.

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

Both Gradle and the low-level helper canonicalize the keystore path and reject
it when it resolves inside the repository. This includes ignored directories:

```text
repository\secrets
repository\local-secrets
repository\credentials
repository\local-artifacts
```

The key and its backup must never be copied into:

```text
repository
local-artifacts
live bundle
GitHub Actions
issue/PR attachments
separate test machine
```

## 6. Public signing identity continuity

The private key remains secret, but its certificate SHA-256 is public and must
be pinned.

The first persistent-key run uses:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\invoke-poc-signing-smoke.ps1 `
  -KeystorePath D:\wlb-secrets\wlb-poc.keystore `
  -KeyAlias wlb-poc `
  -FirstBuildNumber 1 `
  -SecondBuildNumber 2 `
  -InitializeSigningIdentity
```

After the signing smoke succeeds, the wrapper creates:

```text
android-app/poc-signing-identity.json
```

Example schema:

```json
{
  "schemaVersion": 1,
  "applicationId": "bypass.whitelist",
  "certificateSha256": "<64 lowercase hex characters>",
  "androidBuildToolsVersion": "36.0.0",
  "initializedAtUtc": "<ISO-8601 UTC>"
}
```

This file contains no secret. Review it and commit it in a dedicated follow-up
PR before accepting a source-free live bundle. Until it is committed, the
artifact/signing gate remains operationally incomplete.

Every subsequent wrapper run loads the committed identity and rejects a
keystore or APK with a different certificate. The future live-bundle builder
must verify the same certificate against this file.

## 7. Build-number semantics

Gradle enforces only that `WLB_POC_BUILD_NUMBER` is an integer in `1..999`. It
does not remember previously accepted builds.

Base identity:

```text
debug/release versionName = 0.3.7
debug/release versionCode = 3007000
```

POC examples:

```text
poc.1 versionName = 0.3.7-poc.1
poc.1 versionCode = 3007001

poc.2 versionName = 0.3.7-poc.2
poc.2 versionCode = 3007002
```

The future versioned bundle builder must reject:

- a build number not greater than the previous accepted manifest;
- a reused version directory;
- an existing output file;
- a manifest/version mismatch;
- a certificate that differs from `android-app/poc-signing-identity.json`.

## 8. Canonical signing/update smoke

After the identity file has been initialized and committed, omit
`-InitializeSigningIdentity`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\invoke-poc-signing-smoke.ps1 `
  -KeystorePath D:\wlb-secrets\wlb-poc.keystore `
  -KeyAlias wlb-poc `
  -FirstBuildNumber 3 `
  -SecondBuildNumber 4
```

The wrapper prompts for passwords. Do not paste passwords into chat, screenshots
or saved transcripts.

The low-level helper:

1. acquires an exclusive repository-scoped file lock;
2. rejects a concurrent second invocation;
3. requires a clean tracked and non-ignored-untracked tree;
4. records full Git commit and tree SHA;
5. runs `gradlew test`, full `gradlew lint` and `gradlew assembleDebug` without signing secrets in child environments;
6. validates the external keystore path;
7. compares the keystore certificate with the pinned public identity;
8. builds two numbered signed POC APKs;
9. inspects the copied APKs with pinned `aapt` and `apksigner`;
10. transactionally accepts the pair only after all checks pass.

A safety self-test injects failures:

- after the first final-directory move;
- after the second final-directory move;
- during final source-tree validation.

Every failure removes all already moved final directories. The same self-test
holds the exclusive lock twice to confirm the second holder is rejected and
checks that repository-local keystore paths are denied.

## 9. Preserved artifact schema

Output:

```text
local-artifacts/
└── poc-signing-smoke/
    ├── 0.3.7-poc.1/
    │   ├── whitelist-bypass-0.3.7-poc.1.apk
    │   └── BUILD-MANIFEST.json
    └── 0.3.7-poc.2/
        ├── whitelist-bypass-0.3.7-poc.2.apk
        └── BUILD-MANIFEST.json
```

Manifest schema version 2:

```json
{
  "schemaVersion": 2,
  "applicationId": "bypass.whitelist",
  "version": "0.3.7-poc.1",
  "versionCode": 3007001,
  "gitCommit": "<full commit SHA>",
  "gitTree": "<full tree SHA>",
  "apk": "whitelist-bypass-0.3.7-poc.1.apk",
  "apkSha256": "<sha256>",
  "certificateSha256": "<public certificate sha256>",
  "debuggable": false,
  "androidBuildToolsVersion": "36.0.0",
  "builtAtUtc": "<ISO-8601 UTC>"
}
```

No manifest contains passwords, private key material, cookies, VK identifiers
or credentials.

## 10. First install and in-place update

The physical POC device may be connected directly to the trusted build machine
for this signing-only proof. This is not the later VK/network test on the
separate Windows machine.

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$Poc1 = '.\local-artifacts\poc-signing-smoke\0.3.7-poc.1\whitelist-bypass-0.3.7-poc.1.apk'
$Poc2 = '.\local-artifacts\poc-signing-smoke\0.3.7-poc.2\whitelist-bypass-0.3.7-poc.2.apk'

& $Adb uninstall bypass.whitelist
& $Adb install $Poc1
if ($LASTEXITCODE -ne 0) { throw 'Initial poc.1 installation failed' }

& $Adb install -r $Poc2
if ($LASTEXITCODE -ne 0) { throw 'In-place poc.2 update failed' }
```

After installing the persistent-key POC APK on the dedicated device:

- do not deploy debug APKs to that device;
- do not use Android Studio Run with the debug variant on that device;
- install only POC APKs signed with the pinned persistent key;
- keep accepted live build numbers strictly increasing.

## 11. Separate-machine live-test gate

The local signing/update smoke may be completed before the versioned bundle
builder exists. Until the source-free bundle is implemented and verified, the
following remain prohibited:

- copying an ad-hoc APK from `app/build` to the separate test machine;
- entering live VK credentials without immutable manifest/checksums;
- running Creator and APK from different Git commits;
- reusing a prior live version directory or accepted build number;
- accepting an APK whose certificate differs from the pinned public identity.

Every later VK/network iteration must use one immutable bundle containing:

```text
compiled Creator
POC-only launcher
signed APK
build manifest
checksums
```

## 12. CI policy

Public CI never uses the real persistent key.

The repository policy workflow rejects tracked signing material and verifies
legacy release/export guards.

The Android workflow:

- uses actions pinned to full commit SHAs;
- runs `test`, full `lint` and `assembleDebug`;
- verifies fail-closed POC packaging;
- rejects a keystore resolving inside the repository;
- verifies environment and `keystore.properties` Gradle paths with a disposable key;
- verifies unsigned release and rejects POC AAB production.

The Windows workflow:

- uses actions pinned to full commit SHAs;
- runs the helper safety self-tests;
- runs the canonical low-level helper without `-SkipQualityChecks`;
- supplies an explicit expected public certificate digest;
- uses the GitHub-Actions-only synthetic-certificate switch so a future committed
  real identity never requires the persistent private key in public CI;
- independently rechecks APK signer, package/version, non-debuggable state,
  manifest schema, toolchain version, hashes and Git provenance;
- publishes neither APK nor keystore;
- removes disposable key and local artifacts in an always-run cleanup step.
