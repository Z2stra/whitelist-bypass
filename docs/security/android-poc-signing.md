# Android POC signing and APK delivery boundary

- Status: signing and local-artifact tooling implemented; persistent-key operator smoke still pending
- Scope: Android APK identity, private-key handling, CI verification and source-free delivery
- Live build type: `poc`
- Live artifact: signed APK only

## Security boundary

The repository previously contained `android-app/debug.keystore`, and both `debug` and `release` used that repository-owned key. A key published in Git cannot establish a trusted APK identity because any repository reader can produce an APK with the same signature.

The tracked key is removed from the current tree and permanently treated as untrusted. Rewriting Git history is not treated as key recovery.

Signing responsibility is split as follows:

- `debug` uses the standard machine-local Android debug key;
- `release` remains deliberately unsigned until a separate production-signing design exists;
- `poc` produces a non-debuggable APK that requires a private external PKCS12 key and a bounded `WLB_POC_BUILD_NUMBER`;
- POC Android App Bundle production is explicitly unsupported;
- persistent/live keys and passwords are never accepted from committed source or public CI configuration;
- public CI may generate a disposable runner-local key only for synthetic verification;
- disposable CI keys are never published, backed up, transferred or used on a physical device;
- the separate test machine receives compiled artifacts and public manifests/checksums, never the keystore.

The application ID remains:

```text
bypass.whitelist
```

All in-place POC APK updates for that package must use the same persistent private POC key.

## APK-only POC delivery

The separate Windows test machine and physical Android device install an APK directly. Google Play App Bundles are not part of this POC delivery channel.

The numbered POC `versionCode` is applied through the Android variant output API used for APK output. Treating an AAB as equivalent would create an unverified identity path. Therefore:

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

## Repository-wide guards

A lightweight GitHub Actions workflow runs on every pull request without path filters. It rejects tracked private signing property files and common key containers anywhere in the repository:

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

The same workflow verifies representative generated paths with `git check-ignore --no-index`. This protects build-script outputs that can remain after an interrupted `build-creator.sh` or `build-headless.sh`, including:

```text
relay/relay-darwin-*
relay/relay-windows-*.exe
relay/relay-linux-*
headless/headless-*-darwin*
headless/headless-*-windows-*.exe
headless/headless-*-linux-*
headless/vk-bot/headless-vk-bot*
prebuilts/**
```

The heavier Android workflow remains path-filtered.

A workflow that runs is not automatically a merge requirement. Before merging this milestone, a repository administrator must configure `main` branch protection or a ruleset to require:

```text
Repository signing-material policy / tracked-signing-material
```

Until that repository setting is confirmed, the corresponding `PRODUCT.md` checkbox remains open.

## Supported local signing inputs

Preferred environment variables:

```text
WLB_POC_KEYSTORE_PATH
WLB_POC_KEYSTORE_PASSWORD
WLB_POC_KEY_ALIAS
WLB_POC_KEY_PASSWORD
WLB_POC_BUILD_NUMBER
```

All four signing variables must be supplied together. Individual environment fields are never filled from `keystore.properties`.

A partial signing environment is tolerated for ordinary non-POC work:

```text
test
lint
assembleDebug
tasks
```

It is rejected when POC APK or aggregate APK production is requested.

When all four signing environment variables are absent, copy:

```text
android-app/keystore.properties.example
```

to the ignored local file:

```text
android-app/keystore.properties
```

Supported properties:

```properties
wlb.poc.storeFile=D:\\wlb-secrets\\wlb-poc.keystore
wlb.poc.storePassword=<local value>
wlb.poc.keyAlias=wlb-poc
wlb.poc.keyPassword=<local value>
```

`WLB_POC_BUILD_NUMBER` is public per-build identity rather than a secret.

Never place real signing values in screenshots, chat, shell transcripts, issues, PRs or public CI variables.

## One-time persistent POC key creation

Create the key only on the trusted build machine and keep it outside the repository:

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

Allow `keytool` to prompt for private values. Back up the keystore and passwords through a separate protected channel. Losing the key prevents in-place updates of previously installed POC APKs.

The key and its backup must never be copied into:

```text
repository
local-artifacts
live bundle
GitHub Actions
issue/PR attachments
separate test machine
```

## Build-number semantics

Gradle enforces only that `WLB_POC_BUILD_NUMBER` is an integer in `1..999`. It does not store the previous accepted live build and cannot prove monotonicity across independent invocations.

Operator policy requires every accepted live APK to use a strictly increasing number. The future versioned bundle builder must reject:

- a number not greater than the previous accepted manifest;
- a reused version directory;
- an existing output file;
- a manifest/version mismatch.

Until that builder exists, the operator is responsible for never reusing or decreasing an accepted live number.

Base identity is stable:

```text
debug/release versionName = 0.3.7
debug/release versionCode = 3007000
```

Only the signed POC APK receives numbered identity:

```text
poc.1 versionName = 0.3.7-poc.1
poc.1 versionCode = 3007001

poc.2 versionName = 0.3.7-poc.2
poc.2 versionCode = 3007002
```

## Pinned Android verification tools

GitHub Actions installs and uses exactly:

```text
Android build-tools 36.0.0
```

It does not select the newest preinstalled runner tool. Local artifact verification uses the same default version through `tools/preserve-poc-signing-smoke.ps1`.

The unsigned `release` regression is accepted only when all of the following are true:

1. `aapt dump badging` confirms a structurally valid APK;
2. pinned `apksigner` exits non-zero;
3. output contains `DOES NOT VERIFY`;
4. output contains `Missing META-INF/MANIFEST.MF`;
5. no certificate SHA-256 digest is reported.

An arbitrary `apksigner` error is not treated as proof that release is unsigned.

## Reproducible local signing/update smoke

The canonical operator entrypoint is:

```text
tools/preserve-poc-signing-smoke.ps1
```

Run it only after PR merge and creation/backup of the persistent POC key:

```powershell
Set-Location D:\github\src\whitelist-bypass

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\preserve-poc-signing-smoke.ps1 `
  -FirstBuildNumber 1 `
  -SecondBuildNumber 2
```

The helper uses build-tools `36.0.0` by default. A different version must be selected explicitly and should not be used for accepted POC artifacts without updating the pinned CI policy.

By default the helper runs the complete Android code gate before signing:

```text
gradlew test
gradlew lint
gradlew assembleDebug
```

`-SkipQualityChecks` exists only for a deliberate rerun after those exact checks have already passed on the same clean commit/tree. It must not be used to bypass a failing gate.

### Helper invariants

Before any build, the helper:

- requires a clean tracked and non-ignored untracked tree;
- records `git rev-parse HEAD`;
- records `git rev-parse HEAD^{tree}`;
- verifies that both requested version directories do not exist;
- requires the second build number and resulting `versionCode` to be greater than the first;
- locates the persistent key from a complete environment set or ignored `keystore.properties`;
- exports only the public certificate for comparison.

Before and after each build it re-checks:

```text
HEAD unchanged
Git tree unchanged
working tree clean
```

Each build removes the mutable POC APK output directory first, runs `assemblePoc`, copies the resulting APK into a random staging directory under ignored `local-artifacts`, and verifies the copied file rather than the mutable Gradle output.

For each saved APK it derives actual evidence using pinned `aapt` and `apksigner`:

```text
applicationId
versionName
versionCode
APK SHA-256
signer certificate SHA-256
signer count
debuggable state
```

The actual APK values must match the identity reported by the same Gradle source used for packaging. The APK must have exactly one signer, that signer must match the persistent key certificate, and the APK must not be debuggable.

Only after all checks pass is the staging directory atomically moved to its final non-existing version directory.

Expected output:

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

Successful completion prints:

```text
[POC_SIGNING_SMOKE] PASS
```

### Local manifest schema

The helper writes UTF-8 without BOM and derives identity from the saved APK:

```json
{
  "schemaVersion": 1,
  "applicationId": "bypass.whitelist",
  "version": "0.3.7-poc.1",
  "versionCode": 3007001,
  "gitCommit": "<full commit SHA>",
  "gitTree": "<full tree SHA>",
  "apk": "whitelist-bypass-0.3.7-poc.1.apk",
  "apkSha256": "<sha256>",
  "certificateSha256": "<public certificate sha256>",
  "debuggable": false,
  "builtAtUtc": "<ISO-8601 UTC>"
}
```

No manifest contains signing passwords, private key material, cookies, VK identifiers or credentials.

`local-artifacts` is local evidence for signing/update acceptance. It is not the final source-free live-test bundle.

## Local first-install and in-place-update proof

The physical POC device may be connected directly to the trusted build machine for this signing-only smoke. This is not the later VK/network live test on the separate Windows machine.

Three signer identities must not be confused:

```text
old baseline debug APK   -> published repository debug key (untrusted)
new local debug APK      -> machine-local Android debug key
live POC APK             -> persistent private POC key
```

Neither the new local debug APK nor the POC APK can update the old baseline APK in place. One uninstall is required before the first persistent-key POC APK.

After the helper passes:

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$Poc1 = ".\local-artifacts\poc-signing-smoke\0.3.7-poc.1\whitelist-bypass-0.3.7-poc.1.apk"
$Poc2 = ".\local-artifacts\poc-signing-smoke\0.3.7-poc.2\whitelist-bypass-0.3.7-poc.2.apk"

& $Adb uninstall bypass.whitelist
& $Adb install $Poc1
if ($LASTEXITCODE -ne 0) {
  throw 'Initial poc.1 installation failed'
}

& $Adb install -r $Poc2
if ($LASTEXITCODE -ne 0) {
  throw 'In-place poc.2 update failed'
}

& $Adb shell dumpsys package bypass.whitelist |
  Select-String 'versionCode=|versionName='
```

The second install must succeed without uninstalling `poc.1`. This proves that the same private key and a larger `versionCode` support in-place POC updates.

After installing the persistent-key POC APK on the dedicated device:

- do not deploy debug APKs to that device;
- do not use Android Studio Run with the debug variant on that device;
- install only POC APKs signed with the same persistent key;
- keep accepted live build numbers strictly increasing.

Switching back to debug requires uninstalling the POC application and losing app-local state.

## Separate-machine live-test gate

The local signing/update smoke may be completed before the versioned bundle builder exists.

Until the source-free bundle is implemented and verified, the following remain prohibited:

- copying an ad-hoc APK from `app/build` to the separate test machine;
- entering live VK credentials for an iteration without immutable manifest/checksums;
- running a VK/network live test with Creator and APK from different Git commits;
- reusing a prior live version directory or accepted build number.

Every later VK/network live iteration on the separate Windows machine must use one immutable bundle containing:

```text
compiled Creator
POC-only launcher
signed APK
build manifest
checksums
```

## CI policy

Public CI never uses the real persistent POC key.

The repository signing-material workflow:

1. runs on every pull request without path filters;
2. scans all tracked file names;
3. rejects private signing property files and common key containers;
4. verifies representative generated Go/headless outputs remain ignored.

The Android quality workflow:

1. syntax-parses `tools/preserve-poc-signing-smoke.ps1` with PowerShell;
2. proves that `assemblePoc` and aggregate APK `build` fail closed without signing configuration and leave no POC artifact;
3. proves that a partial signing environment does not break `test`, full `lint` or `assembleDebug`;
4. proves that the same partial environment is rejected for POC APK production;
5. proves that `WLB_POC_BUILD_NUMBER` does not leak into debug identity;
6. proves that release is a structurally valid but unsigned APK using pinned build-tools `36.0.0` and expected diagnostics;
7. generates a disposable runner-local PKCS12 key;
8. builds a signed POC APK from a complete environment configuration;
9. requires exactly one APK signer and exact certificate SHA-256 match;
10. verifies non-debuggable POC output;
11. derives expected package/version identity from Gradle and compares it with the APK;
12. builds and fully verifies a second numbered POC APK through ignored `keystore.properties`;
13. proves that `bundlePoc` is unsupported and leaves no `.aab`;
14. does not publish CI-only POC APKs as live artifacts.

The CI key is disposable and must never be used on a physical POC device.
