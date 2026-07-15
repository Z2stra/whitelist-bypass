# Android POC signing and APK delivery boundary

- Status: signing and local-artifact tooling implemented; persistent-key operator smoke still pending
- Scope: Android APK identity, private-key handling, CI verification and source-free delivery
- Live build type: `poc`
- Live artifact: signed APK only

## Security boundary

The repository previously contained `android-app/debug.keystore`, and both
`debug` and `release` used that repository-owned key. A key published in Git
cannot establish a trusted APK identity because any repository reader can sign
another APK with it.

The tracked key is removed from the current tree and permanently treated as
untrusted. Rewriting Git history is not treated as key recovery.

Signing responsibility is now split as follows:

- `debug` uses the standard machine-local Android debug key;
- `release` remains deliberately unsigned until a separate production-signing design exists;
- `poc` produces a non-debuggable APK that requires a private external PKCS12 key;
- POC Android App Bundle production is explicitly unsupported;
- persistent/live keys and passwords never belong in Git or public CI;
- public CI may create only a disposable runner-local synthetic key;
- the separate test machine receives compiled artifacts and public manifests/checksums, never the keystore.

The application ID remains:

```text
bypass.whitelist
```

All in-place POC APK updates for that package must use the same persistent
private POC key.

## APK-only POC delivery

The separate Windows test machine and physical Android device install an APK
directly. Google Play App Bundles are not part of this POC channel.

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

The same workflow verifies representative generated paths with
`git check-ignore --no-index`, including interrupted relay/headless build
outputs and `prebuilts/**`. It also proves that the legacy `build-android.sh`
path refuses to copy an unsigned release APK into a distributable-looking
filename.

For `main`, the configured branch rule requires:

```text
Repository signing-material policy / tracked-signing-material
```

If that rule is removed or the job is renamed, the corresponding gate in
`PRODUCT.md` must be reopened.

## Signing inputs

### Canonical reproducible helper

The canonical helper accepts exactly one signing source: the complete process
environment set.

```text
WLB_POC_KEYSTORE_PATH
WLB_POC_KEYSTORE_PASSWORD
WLB_POC_KEY_ALIAS
WLB_POC_KEY_PASSWORD
```

All four values are mandatory. The helper intentionally does not parse
`keystore.properties`; duplicating Java `.properties` escaping rules in
PowerShell created an avoidable consistency boundary.

`WLB_POC_BUILD_NUMBER` is public per-build identity rather than a secret. The
helper sets it separately for each requested APK.

### Direct Gradle fallback

Direct Gradle POC builds may still use the ignored local file:

```text
android-app/keystore.properties
```

Create it from:

```text
android-app/keystore.properties.example
```

Supported properties:

```properties
wlb.poc.storeFile=D:\\wlb-secrets\\wlb-poc.keystore
wlb.poc.storePassword=<local value>
wlb.poc.keyAlias=wlb-poc
wlb.poc.keyPassword=<local value>
```

Environment and properties are indivisible alternatives at the Gradle layer.
A partial environment is never completed from the properties file. Android CI
builds one APK from environment inputs and another from the properties fallback.

Never place real signing values in screenshots, chat, shell transcripts,
issues, PRs or public CI variables.

## One-time persistent POC key creation

Create the key only on the trusted build machine and keep it outside the
repository:

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

Allow `keytool` to prompt for private values. Back up the keystore and passwords
through a separate protected channel. Losing the key prevents in-place updates
of already installed POC APKs.

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

Gradle enforces only that `WLB_POC_BUILD_NUMBER` is an integer in `1..999`. It
does not store the previously accepted live build.

Operator policy requires every accepted APK to use a strictly increasing
number. The future versioned bundle builder must reject:

- a number not greater than the previous accepted manifest;
- a reused version directory;
- an existing output file;
- a manifest/version mismatch.

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

CI installs and uses exactly:

```text
Android build-tools 36.0.0
```

The local helper uses the same default. A different version must be selected
explicitly and should not be accepted for live artifacts until the CI policy is
updated.

The unsigned `release` regression is accepted only when all of the following
are true:

1. `aapt dump badging` confirms a structurally valid APK;
2. pinned `apksigner` exits non-zero;
3. output contains `DOES NOT VERIFY`;
4. output contains `Missing META-INF/MANIFEST.MF`;
5. no certificate SHA-256 digest is reported.

An arbitrary tool failure is not treated as proof that release is unsigned.

## Reproducible local signing/update smoke

Before invoking the helper, set the complete signing environment locally. Do
not paste the values into chat or transcripts.

```powershell
$env:WLB_POC_KEYSTORE_PATH = 'D:\wlb-secrets\wlb-poc.keystore'
$env:WLB_POC_KEYSTORE_PASSWORD = '<local value>'
$env:WLB_POC_KEY_ALIAS = 'wlb-poc'
$env:WLB_POC_KEY_PASSWORD = '<local value>'
```

The canonical operator entrypoint is:

```powershell
Set-Location D:\github\src\whitelist-bypass

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\preserve-poc-signing-smoke.ps1 `
  -FirstBuildNumber 1 `
  -SecondBuildNumber 2
```

By default the helper runs the complete Android code gate before signing:

```text
gradlew test
gradlew lint
gradlew assembleDebug
```

`-SkipQualityChecks` is only for a deliberate rerun after those exact checks
have already passed on the same clean commit/tree. It must not bypass a failing
gate.

### Helper invariants

Before any build, the helper:

- requires a clean tracked and non-ignored-untracked tree;
- records `git rev-parse HEAD`;
- records `git rev-parse HEAD^{tree}`;
- verifies that both requested final version directories do not exist;
- requires the second build number and resulting `versionCode` to be greater;
- requires the complete signing environment;
- exports only the public certificate for comparison.

Before and after each stage it rechecks:

```text
HEAD unchanged
Git tree unchanged
working tree clean
```

Each build removes the mutable POC APK output directory, runs `assemblePoc`,
copies the result into a random ignored staging directory, and verifies the
staged file rather than trusting the mutable Gradle output.

For each saved APK it derives actual evidence with pinned `aapt` and
`apksigner`:

```text
applicationId
versionName
versionCode
APK SHA-256
signer certificate SHA-256
signer count
debuggable state
```

The APK must have exactly one signer, that signer must match the persistent key
certificate, the identity must match Gradle, and the APK must not be debuggable.

The pair is accepted transactionally. If either move, the final source-tree
validation, or PASS finalization fails, every already moved final directory is
removed. A CI-only rollback self-test injects failures after the first move,
after the second move, and from final validation.

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

No manifest contains passwords, private key material, cookies, VK identifiers
or credentials. `local-artifacts` is signing/update evidence, not the final
source-free live bundle.

## Local first-install and in-place-update proof

The physical POC device may be connected to the trusted build machine for this
signing-only smoke. This is not the later VK/network test on the separate
Windows machine.

Three signer identities must not be confused:

```text
old baseline debug APK   -> published repository debug key (untrusted)
new local debug APK      -> machine-local Android debug key
live POC APK             -> persistent private POC key
```

One uninstall is required before the first persistent-key POC APK:

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$Poc1 = '.\local-artifacts\poc-signing-smoke\0.3.7-poc.1\whitelist-bypass-0.3.7-poc.1.apk'
$Poc2 = '.\local-artifacts\poc-signing-smoke\0.3.7-poc.2\whitelist-bypass-0.3.7-poc.2.apk'

& $Adb uninstall bypass.whitelist
& $Adb install $Poc1
if ($LASTEXITCODE -ne 0) { throw 'Initial poc.1 installation failed' }

& $Adb install -r $Poc2
if ($LASTEXITCODE -ne 0) { throw 'In-place poc.2 update failed' }

& $Adb shell dumpsys package bypass.whitelist |
  Select-String 'versionCode=|versionName='
```

After installing the persistent-key POC APK on the dedicated device:

- do not deploy debug APKs to that device;
- do not use Android Studio Run with the debug variant on that device;
- install only POC APKs signed with the same persistent key;
- keep accepted live build numbers strictly increasing.

## Separate-machine live-test gate

The local signing/update smoke may be completed before the versioned bundle
builder exists. Until that bundle is implemented and verified, the following
remain prohibited:

- copying an ad-hoc APK from `app/build` to the separate test machine;
- entering live VK credentials without immutable manifest/checksums;
- running Creator and APK from different Git commits;
- reusing a prior live version directory or accepted build number.

Every later VK/network iteration must use one immutable bundle containing:

```text
compiled Creator
POC-only launcher
signed APK
build manifest
checksums
```

## CI policy

Public CI never uses the real persistent POC key.

The repository policy workflow:

1. runs on every pull request without path filters;
2. rejects tracked private signing material;
3. verifies generated outputs remain ignored;
4. verifies the legacy unsigned Android export is fail-closed.

The Android quality workflow independently verifies Gradle signing behavior,
including both complete environment and ignored `keystore.properties` inputs.

The Windows workflow:

1. runs the acceptance rollback regression;
2. runs the canonical helper without `-SkipQualityChecks`;
3. builds two numbered APKs with a disposable key;
4. independently reruns pinned `aapt` and `apksigner` over the preserved APKs;
5. verifies manifests, commit/tree provenance, UTF-8 no-BOM, APK hashes,
   package/version identity, non-debuggable state and exact signer certificate;
6. publishes neither APK nor keystore;
7. removes disposable key and local artifacts in an always-run cleanup step.
