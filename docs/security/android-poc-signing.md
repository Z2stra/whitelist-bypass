# Android POC signing and APK delivery boundary

- Status: implemented as the signing gate for future live POC APKs
- Scope: Android APK identity, private-key handling, CI verification and transfer to the separate test machine
- Live build type: `poc`
- Live artifact: signed APK only

## Security boundary

The repository previously contained `android-app/debug.keystore`, and both the `debug` and `release` build types used that repository-owned key. A key published in Git cannot establish a trusted APK identity because any repository reader can produce an APK with the same signature.

The tracked key is therefore removed from active use and from the repository. Rewriting Git history is not treated as key recovery: the old key must remain permanently untrusted.

Signing responsibility is split as follows:

- `debug` uses the standard machine-local Android debug key;
- `release` is deliberately unsigned until a separate production-signing design exists;
- `poc` produces a non-debuggable APK that requires a private external PKCS12 key and a positive, bounded `WLB_POC_BUILD_NUMBER`;
- POC Android App Bundle production is explicitly unsupported;
- no persistent or live signing key or password is accepted from committed source files or public CI configuration;
- public CI may generate a disposable runner-local key solely for synthetic verification;
- a disposable CI key is never published, backed up, transferred or used on a physical POC device;
- the test Windows machine receives only the signed APK and its public manifest/checksum, never the keystore.

The application ID remains `bypass.whitelist`. All POC APK updates for one installed application must therefore use the same persistent private POC key.

## Why POC delivery is APK-only

The separate test machine and physical Android device install an APK directly. Google Play App Bundles are not part of this POC delivery channel.

The numbered POC `versionCode` is applied through the Android variant output API, whose supported output is APK. Treating an AAB as equivalent would create an unverified identity path. Therefore:

```text
:app:assemblePoc   supported
:app:installPoc    supported
:app:bundlePoc     rejected
```

An attempted POC bundle build must fail with:

```text
POC AAB is not supported; build the signed POC APK with :app:assemblePoc
```

No `.aab` file may be transferred or described as a live POC artifact.

## Repository-wide signing-material policy

A lightweight GitHub Actions workflow runs on every pull request without path filters. It rejects tracked private signing property files and common key containers anywhere in the repository, including:

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

The heavier Android quality workflow remains path-filtered. The repository-wide workflow is the permanent code-level guard against adding a key outside `android-app` in a future unrelated PR.

A workflow that runs is not automatically a merge requirement. A repository administrator must configure `main` branch protection or a ruleset to require:

```text
Repository signing-material policy / tracked-signing-material
```

Until that repository setting is confirmed, the corresponding `PRODUCT.md` checkbox remains open.

## Supported local inputs

Preferred environment variables:

```text
WLB_POC_KEYSTORE_PATH
WLB_POC_KEYSTORE_PASSWORD
WLB_POC_KEY_ALIAS
WLB_POC_KEY_PASSWORD
WLB_POC_BUILD_NUMBER
```

All four signing variables must be supplied together. Individual environment fields are never filled from `keystore.properties`.

A partial signing environment is tolerated while running ordinary non-POC tasks such as:

```text
test
lint
assembleDebug
tasks
```

but it is rejected when a POC APK or an aggregate APK build is requested. This prevents stale local variables from breaking normal development while keeping live artifact production fail-closed.

When all four signing environment variables are absent, copy:

```text
android-app/keystore.properties.example
```

to:

```text
android-app/keystore.properties
```

The real file is ignored by Git. Its supported properties are:

```properties
wlb.poc.storeFile=D:\\wlb-secrets\\wlb-poc.keystore
wlb.poc.storePassword=<local value>
wlb.poc.keyAlias=wlb-poc
wlb.poc.keyPassword=<local value>
```

`WLB_POC_BUILD_NUMBER` is public per-build identity rather than a persistent secret.

Do not place real signing values in screenshots, chat, shell transcripts, issues, PRs or public CI variables.

## One-time POC key creation

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

Let `keytool` prompt for private values. Back up the keystore and passwords through a separate protected channel. Losing the key prevents in-place updates of previously installed POC APKs.

The keystore and its backup must never be copied into the repository, `local-artifacts`, the live bundle, GitHub Actions, issue attachments or the separate test machine.

## Build-number semantics

Gradle enforces only that `WLB_POC_BUILD_NUMBER` is an integer in `1..999`. Gradle does not store the previous accepted live build and therefore cannot prove monotonicity across independent invocations.

Operator policy requires every accepted live APK to use a strictly increasing number. The future versioned live-bundle builder must enforce this mechanically by rejecting:

- a build number not greater than the previous accepted manifest;
- a reused version directory;
- an existing output file;
- a manifest/version mismatch.

Until that builder exists, the operator is responsible for selecting `1`, then `2`, then `3`, and never reusing or decreasing an accepted number.

The base identity is stable and does not depend on `WLB_POC_BUILD_NUMBER`:

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

The expected values come from the same Gradle constants used for packaging:

```powershell
.\gradlew.bat --no-daemon -q :app:printBaseIdentity

$env:WLB_POC_BUILD_NUMBER = '1'
.\gradlew.bat --no-daemon -q :app:printPocIdentity
```

Setting `WLB_POC_BUILD_NUMBER` must never change the identity of an `assembleDebug` result.

## Building a locally signed POC APK

Run the complete Android quality gate from the trusted build machine:

```powershell
Set-Location D:\github\src\whitelist-bypass\android-app

$env:WLB_POC_BUILD_NUMBER = '1'

.\gradlew.bat --no-daemon test
.\gradlew.bat --no-daemon lint
.\gradlew.bat --no-daemon assembleDebug
.\gradlew.bat --no-daemon :app:assemblePoc
```

Expected temporary Gradle output:

```text
android-app/app/build/outputs/apk/poc/app-poc.apk
```

This path is Gradle-owned and is not durable storage. `gradlew clean` or another packaging operation may delete or replace it. Never treat an APK left under `app/build` as an immutable release candidate.

POC APK production fails before packaging when:

- `WLB_POC_BUILD_NUMBER` is missing, zero, malformed or above `999`;
- any signing input is absent;
- only part of the signing environment is supplied;
- the configured keystore file does not exist.

The gate is attached to supported APK-producing entry points. A sentinel missing key also prevents lower-level APK packaging from silently emitting a usable POC artifact without external signing configuration.

Failure messages name missing configuration fields but never print passwords.

## Verifying APK signature, identity and checksum

Locate the Android verification tools and inspect the APK:

```powershell
$Sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ApkSigner = Get-ChildItem "$Sdk\build-tools\*\apksigner.bat" |
  Sort-Object { [version]$_.Directory.Name } |
  Select-Object -Last 1
$Aapt = Get-ChildItem "$Sdk\build-tools\*\aapt.exe" |
  Sort-Object { [version]$_.Directory.Name } |
  Select-Object -Last 1
$Apk = ".\app\build\outputs\apk\poc\app-poc.apk"

if (-not $ApkSigner -or -not $Aapt) {
  throw 'Android APK verification tools were not found'
}

$ApkCertOutput = & $ApkSigner.FullName verify --verbose --print-certs $Apk
if ($LASTEXITCODE -ne 0) {
  throw 'POC APK signature verification failed'
}
$ApkCertOutput

$BadgingOutput = & $Aapt.FullName dump badging $Apk
if ($LASTEXITCODE -ne 0) {
  throw 'POC APK identity inspection failed'
}
$BadgingOutput | Select-Object -First 1
if ($BadgingOutput -match 'application-debuggable') {
  throw 'POC APK must not be debuggable'
}

$ApkHash = Get-FileHash $Apk -Algorithm SHA256
$ApkHash
```

The APK signer must also match the public certificate exported from the configured keystore. This comparison does not expose the private key.

Different Android build-tools versions can report either:

```text
Signer #1 certificate SHA-256 digest: ...
V2 Signer: certificate SHA-256 digest: ...
V3 Signer: certificate SHA-256 digest: ...
```

The parser therefore accepts both numbered and scheme-specific forms:

```powershell
$ExportedCertificate = Join-Path $env:TEMP 'wlb-poc-signing-cert.der'
Remove-Item $ExportedCertificate -Force -ErrorAction SilentlyContinue

keytool.exe -exportcert `
  -storetype PKCS12 `
  -keystore D:\wlb-secrets\wlb-poc.keystore `
  -alias wlb-poc `
  -file $ExportedCertificate
if ($LASTEXITCODE -ne 0) {
  throw 'Could not export the POC signing certificate'
}

$ExpectedCertSha256 = (
  Get-FileHash $ExportedCertificate -Algorithm SHA256
).Hash.ToLowerInvariant()

$ReportedSignerCountLine = $ApkCertOutput |
  Select-String '^Number of signers:\s*(\d+)$' |
  Select-Object -First 1

$ActualCertLines = $ApkCertOutput |
  Select-String '^(?:Signer #\d+|.*Signer):?\s+certificate SHA-256 digest:\s*(\S+)$'

if (-not $ReportedSignerCountLine) {
  throw 'apksigner did not report the APK signer count'
}

$ReportedSignerCount = [int](
  $ReportedSignerCountLine.Matches[0].Groups[1].Value
)

$ActualCertSha256 = @(
  $ActualCertLines |
    ForEach-Object {
      $_.Matches[0].Groups[1].Value.Replace(':', '').ToLowerInvariant()
    } |
    Sort-Object -Unique
)

if ($ReportedSignerCount -ne 1 -or $ActualCertSha256.Count -ne 1) {
  throw 'POC APK must contain exactly one unique signer certificate'
}

if ($ActualCertSha256[0] -ne $ExpectedCertSha256) {
  throw 'APK signer certificate does not match the persistent POC keystore'
}

Remove-Item $ExportedCertificate -Force
```

Record only the APK SHA-256, application version, Git commit and public signing-certificate SHA-256. Never record the passwords or copy the keystore alongside the APK.

## Verifying release remains unsigned

The ordinary `release` variant is intentionally not a production artifact yet. It must remain unsigned:

```powershell
.\gradlew.bat --no-daemon :app:assembleRelease

$ReleaseApk = Get-ChildItem `
  .\app\build\outputs\apk\release\*.apk |
  Select-Object -First 1

if (-not $ReleaseApk) {
  throw 'Release APK was not produced'
}

& $ApkSigner.FullName verify $ReleaseApk.FullName
if ($LASTEXITCODE -eq 0) {
  throw 'Release APK unexpectedly contains a valid signing identity'
}
```

Do not distribute the unsigned release APK. Live POC testing uses only the signed `poc` APK.

## Preserving immutable local smoke artifacts

The local signing/update smoke is allowed before the versioned live-bundle milestone, but its APKs must be copied out of Gradle-owned output immediately.

From `android-app`, create new non-existing directories under the ignored repository-level `local-artifacts` directory:

```powershell
$RepoRoot = (Resolve-Path ..).Path
$SmokeRoot = Join-Path $RepoRoot 'local-artifacts\poc-signing-smoke'
$Poc1Dir = Join-Path $SmokeRoot '0.3.7-poc.1'
$Poc2Dir = Join-Path $SmokeRoot '0.3.7-poc.2'

foreach ($Directory in @($Poc1Dir, $Poc2Dir)) {
  if (Test-Path -LiteralPath $Directory) {
    throw "Refusing to reuse existing smoke artifact directory: $Directory"
  }
  New-Item -ItemType Directory -Path $Directory | Out-Null
}
```

Build and preserve iteration 1:

```powershell
$env:WLB_POC_BUILD_NUMBER = '1'
.\gradlew.bat --no-daemon :app:assemblePoc

$Poc1Apk = Join-Path $Poc1Dir 'whitelist-bypass-0.3.7-poc.1.apk'
Copy-Item `
  .\app\build\outputs\apk\poc\app-poc.apk `
  $Poc1Apk

$Poc1Hash = (Get-FileHash $Poc1Apk -Algorithm SHA256).Hash
```

Build and preserve iteration 2 with the same key:

```powershell
$env:WLB_POC_BUILD_NUMBER = '2'
.\gradlew.bat --no-daemon :app:assemblePoc

$Poc2Apk = Join-Path $Poc2Dir 'whitelist-bypass-0.3.7-poc.2.apk'
Copy-Item `
  .\app\build\outputs\apk\poc\app-poc.apk `
  $Poc2Apk

$Poc2Hash = (Get-FileHash $Poc2Apk -Algorithm SHA256).Hash
```

Write public local manifests without secrets:

```powershell
$Commit = (git rev-parse HEAD).Trim()

@{
  version = '0.3.7-poc.1'
  versionCode = 3007001
  gitCommit = $Commit
  apk = (Split-Path $Poc1Apk -Leaf)
  apkSha256 = $Poc1Hash
  certificateSha256 = $ExpectedCertSha256
} | ConvertTo-Json | Set-Content (Join-Path $Poc1Dir 'BUILD-MANIFEST.json')

@{
  version = '0.3.7-poc.2'
  versionCode = 3007002
  gitCommit = $Commit
  apk = (Split-Path $Poc2Apk -Leaf)
  apkSha256 = $Poc2Hash
  certificateSha256 = $ExpectedCertSha256
} | ConvertTo-Json | Set-Content (Join-Path $Poc2Dir 'BUILD-MANIFEST.json')
```

Re-run the APK signature, certificate, package/version and non-debuggable checks against both `$Poc1Apk` and `$Poc2Apk`, not against the mutable `app/build` path.

`local-artifacts` is ignored by Git. It is local evidence, not the final source-free live-test bundle.

## Local first-install and in-place-update proof

The physical POC device may be connected directly to the trusted build machine for this signing-only smoke. This is not the VK/network live test on the separate Windows machine.

Three signer identities must not be confused:

```text
old baseline debug APK   -> published repository debug key (untrusted)
new local debug APK      -> machine-local Android debug key
live POC APK             -> persistent private POC key
```

Neither the new machine-local debug APK nor the new POC APK can update the old baseline APK in place. The transition therefore requires one uninstall before the first APK signed by the selected new identity.

Install `poc.1`, then update it in place with `poc.2`:

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

& $Adb uninstall bypass.whitelist
& $Adb install $Poc1Apk
if ($LASTEXITCODE -ne 0) {
  throw 'Initial poc.1 installation failed'
}

& $Adb install -r $Poc2Apk
if ($LASTEXITCODE -ne 0) {
  throw 'In-place poc.2 update failed'
}

& $Adb shell dumpsys package bypass.whitelist |
  Select-String 'versionCode=|versionName='
```

The second install must succeed without uninstalling `poc.1`. This proves that the same private key and a larger `versionCode` support in-place POC updates.

After the persistent-key POC APK is installed on the physical POC device:

- do not deploy `debug` APKs to that device;
- do not use Android Studio Run with the debug variant on that device;
- install only `poc` APKs signed with the same persistent POC key;
- keep accepted build numbers strictly increasing.

Switching back to a debug APK would require uninstalling the POC application and losing its app-local state.

## Separate-machine live-test gate

The local signing/update smoke may be completed before the versioned bundle builder exists.

The following actions remain prohibited until the source-free bundle is implemented and verified:

- copying an ad-hoc APK from `app/build` to the separate test machine;
- entering live VK credentials for a VK/network POC iteration that has no immutable manifest and checksums;
- running a VK/network live test with a Creator and APK from different Git commits;
- reusing a prior live version directory or build number.

Every later VK/network live iteration on the separate Windows machine must use one immutable bundle containing the compiled Creator, POC-only launcher, signed APK, build manifest and checksums.

## CI policy

Public CI never uses the real persistent POC key.

The repository signing-material workflow:

1. runs on every pull request without path filters;
2. scans all tracked file names;
3. rejects private signing property files and common key-container extensions anywhere in the repository.

The Android quality workflow:

1. proves that `assemblePoc` and aggregate APK `build` fail closed without signing configuration and leave no final POC artifact;
2. proves that a partial signing environment does not break `test`, full `lint` or `assembleDebug`;
3. proves that the same partial environment is rejected for POC APK production;
4. proves that `WLB_POC_BUILD_NUMBER` does not leak into the normal debug identity;
5. proves that the ordinary release APK remains unsigned;
6. generates a disposable runner-local PKCS12 key;
7. builds a synthetic signed POC APK from a complete environment configuration;
8. requires exactly one APK signer and compares its certificate SHA-256 with the certificate exported from the generated CI key;
9. verifies non-debuggable POC output;
10. derives expected package/version identity from Gradle and compares it with the APK;
11. builds and fully verifies a second numbered POC APK through the ignored `keystore.properties` fallback;
12. proves that `bundlePoc` is explicitly unsupported and leaves no `.aab` artifact;
13. does not publish CI-only POC APK files as live artifacts.

The CI key is disposable and must never be used on a physical POC device.
