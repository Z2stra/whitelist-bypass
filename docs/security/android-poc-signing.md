# Android POC signing and artifact boundary

- Status: implemented as the signing gate for future live POC APKs
- Scope: Android APK identity, private-key handling, CI verification and transfer to the separate test machine
- Live build type: `poc`

## Security boundary

The repository previously contained `android-app/debug.keystore`, and both the `debug` and `release` build types used that repository-owned key. A key published in Git cannot establish a trusted APK identity because any repository reader can produce an APK with the same signature.

The tracked key is therefore removed from active use and from the repository. Rewriting Git history is not treated as key recovery: the old key must remain permanently untrusted.

Signing responsibility is now split as follows:

- `debug` uses the standard machine-local Android debug key;
- `release` is deliberately unsigned until a separate production-signing design exists;
- `poc` requires a private external PKCS12 POC key and a positive, bounded `WLB_POC_BUILD_NUMBER`;
- no private signing key or password is accepted from committed source files;
- the test Windows machine receives only the signed APK and its public manifest/checksum, never the keystore.

The application ID remains `bypass.whitelist`. All POC APK updates for one installed application must therefore use the same private POC key.

## Supported local inputs

Preferred environment variables:

```text
WLB_POC_KEYSTORE_PATH
WLB_POC_KEYSTORE_PASSWORD
WLB_POC_KEY_ALIAS
WLB_POC_KEY_PASSWORD
WLB_POC_BUILD_NUMBER
```

All four `WLB_POC_*` signing values must be supplied together. A partial signing environment is rejected; individual environment fields are never mixed with values from `keystore.properties`.

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

`WLB_POC_BUILD_NUMBER` remains an environment input because it is public per-build identity rather than a persistent secret. Do not place real signing values in screenshots, chat, shell transcripts, issues, PRs or public CI variables.

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

## Building a live POC APK

Every APK copied to the separate test machine must use a **strictly increasing** build number from `1` to `999`:

```powershell
Set-Location D:\github\src\whitelist-bypass\android-app

$env:WLB_POC_BUILD_NUMBER = '1'

.\gradlew.bat --no-daemon test
.\gradlew.bat --no-daemon lintDebug
.\gradlew.bat --no-daemon assembleDebug
.\gradlew.bat --no-daemon :app:assemblePoc
```

Expected signed artifact:

```text
android-app/app/build/outputs/apk/poc/app-poc.apk
```

The POC version name and code are derived from the application version and build number. For example:

```text
versionName = 0.3.7-poc.1
versionCode = 3007001
```

The public identity expected for a build can be printed from the same Gradle source used for packaging:

```powershell
.\gradlew.bat --no-daemon -q :app:printPocIdentity
```

POC artifact production fails before packaging when:

- `WLB_POC_BUILD_NUMBER` is missing, zero, malformed or above `999`;
- any signing input is absent;
- only part of the signing environment is supplied;
- the configured keystore file does not exist.

The gate is attached to the Android signing boundary and the supported `assemblePoc`, `bundlePoc`, `installPoc` and aggregate build paths. A sentinel missing key also prevents lower-level packaging from silently emitting a usable POC artifact without external signing configuration.

Failure messages name missing configuration fields but never print passwords.

## Signature, identity and checksum verification

Verify the APK before copying it:

```powershell
$Sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ApkSigner = Get-ChildItem "$Sdk\build-tools\*\apksigner.bat" |
  Sort-Object { [version]$_.Directory.Name } |
  Select-Object -Last 1
$Aapt = Get-ChildItem "$Sdk\build-tools\*\aapt.exe" |
  Sort-Object { [version]$_.Directory.Name } |
  Select-Object -Last 1
$Apk = ".\app\build\outputs\apk\poc\app-poc.apk"

$ApkCertOutput = & $ApkSigner.FullName verify --verbose --print-certs $Apk
$ApkCertOutput

& $Aapt.FullName dump badging $Apk | Select-Object -First 1

$ApkHash = Get-FileHash $Apk -Algorithm SHA256
$ApkHash
```

The APK signer must also match the public certificate exported from the configured keystore. This comparison does not expose the private key. Current Android build-tools can label the same certificate line as `V2 Signer`, `V3 Signer` or another scheme-specific signer, so the parser intentionally does not require a literal `Signer #1` prefix:

```powershell
$ExportedCertificate = Join-Path $env:TEMP 'wlb-poc-signing-cert.der'
Remove-Item $ExportedCertificate -Force -ErrorAction SilentlyContinue

keytool.exe -exportcert `
  -storetype PKCS12 `
  -keystore D:\wlb-secrets\wlb-poc.keystore `
  -alias wlb-poc `
  -file $ExportedCertificate

$ExpectedCertSha256 = (
  Get-FileHash $ExportedCertificate -Algorithm SHA256
).Hash.ToLowerInvariant()

$ReportedSignerCountLine = $ApkCertOutput |
  Select-String '^Number of signers:\s*(\d+)$' |
  Select-Object -First 1

$ActualCertLines = $ApkCertOutput |
  Select-String '^.*Signer:\s+certificate SHA-256 digest:\s*(\S+)$'

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

Record only the APK SHA-256, application version, Git commit and public signing-certificate SHA-256 in the live-test manifest. Never copy the keystore to the test machine.

## Existing debug installation and device policy

Three signer identities must not be confused:

```text
old baseline debug APK   -> published repository debug key (untrusted)
new local debug APK      -> machine-local Android debug key
live POC APK             -> persistent private POC key
```

Neither the new machine-local debug APK nor the new POC APK can update the old baseline APK in place. The transition therefore requires one uninstall before the first APK signed by the selected new identity.

After the persistent-key POC APK is installed on the physical POC device:

- do not deploy `debug` APKs to that device;
- do not use Android Studio Run with the debug variant on that device;
- install only `poc` APKs signed with the same persistent POC key;
- keep `WLB_POC_BUILD_NUMBER` strictly increasing.

Switching back to a debug APK would require uninstalling the POC application and losing its app-local state.

## First-install and in-place-update proof

Before any VK live test, prove the signing lifecycle with two locally built APKs.

Build and preserve iteration 1:

```powershell
$env:WLB_POC_BUILD_NUMBER = '1'
.\gradlew.bat --no-daemon :app:assemblePoc
Copy-Item `
  .\app\build\outputs\apk\poc\app-poc.apk `
  .\app\build\outputs\apk\poc\app-poc.1.apk `
  -Force
```

One-time transition from the old debug identity:

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $Adb uninstall bypass.whitelist
& $Adb install .\app\build\outputs\apk\poc\app-poc.1.apk
```

Build iteration 2 with the same keystore:

```powershell
$env:WLB_POC_BUILD_NUMBER = '2'
.\gradlew.bat --no-daemon :app:assemblePoc
Copy-Item `
  .\app\build\outputs\apk\poc\app-poc.apk `
  .\app\build\outputs\apk\poc\app-poc.2.apk `
  -Force

& $Adb install -r .\app\build\outputs\apk\poc\app-poc.2.apk
```

The second command must succeed without uninstalling the first POC APK. Verify the installed version:

```powershell
& $Adb shell dumpsys package bypass.whitelist |
  Select-String 'versionCode=|versionName='
```

This proves that the same private key and a larger `versionCode` support in-place POC updates.

## CI policy

Public CI never uses the real POC key. The Android workflow:

1. verifies that no private-key/signing file is tracked;
2. proves that `assemblePoc`, `bundlePoc` and aggregate `build` fail closed without signing configuration and leave no POC artifact;
3. proves that a partial signing environment is rejected rather than mixed with properties;
4. generates an ephemeral CI-only PKCS12 key;
5. runs unit tests, Android lint and normal debug assembly without POC credentials;
6. builds a synthetic signed POC APK from a complete environment configuration;
7. requires exactly one APK signer and compares its certificate SHA-256 with the certificate exported from the generated CI key;
8. derives expected package/version identity from Gradle and compares it with the APK;
9. builds a signed POC bundle through the ignored `keystore.properties` fallback;
10. does not publish CI-only POC APK/AAB files as live artifacts.

The CI key is disposable and must never be used on a physical POC device.
