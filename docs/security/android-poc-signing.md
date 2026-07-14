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
- `poc` requires a private external POC key and a positive, bounded `BUILD_NUMBER`;
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
BUILD_NUMBER
```

As a local-only fallback, copy:

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

Do not place real values in screenshots, chat, shell transcripts, issues, PRs or CI variables for public workflows.

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

Every APK copied to the separate test machine must have a new build number from `1` to `999`:

```powershell
Set-Location D:\github\src\whitelist-bypass\android-app

$env:BUILD_NUMBER = '1'

.\gradlew.bat --no-daemon test
.\gradlew.bat --no-daemon lintDebug
.\gradlew.bat --no-daemon assembleDebug
.\gradlew.bat --no-daemon :app:assemblePoc
```

Expected signed artifact:

```text
android-app/app/build/outputs/apk/poc/app-poc.apk
```

The POC version name is derived from the application version and build number, for example:

```text
0.3.7-poc.1
```

`assemblePoc` fails before packaging when:

- `BUILD_NUMBER` is missing, zero, malformed or above `999`;
- any signing input is absent;
- the configured keystore file does not exist.

The failure messages name missing configuration fields but never print passwords.

## Signature verification

Verify the APK before copying it:

```powershell
$Sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ApkSigner = Get-ChildItem "$Sdk\build-tools\*\apksigner.bat" |
  Sort-Object { [version]$_.Directory.Name } |
  Select-Object -Last 1

& $ApkSigner.FullName verify --verbose `
  .\app\build\outputs\apk\poc\app-poc.apk

Get-FileHash `
  .\app\build\outputs\apk\poc\app-poc.apk `
  -Algorithm SHA256
```

Record only the APK SHA-256, application version, Git commit and public signing-certificate fingerprint in the live-test manifest. Never copy the keystore to the test machine.

## Existing debug installation

An APK signed with the new POC key cannot update an APK signed with the old repository debug key. The first transition to the POC key therefore requires one uninstall of the old application, or a deliberately different application ID. This project keeps `bypass.whitelist`, so the current operational rule is one uninstall before the first POC-key installation. Later POC versions update in place as long as the same POC key is used.

## CI policy

Public CI never uses the real POC key. The Android workflow:

1. verifies that no private-key/signing file is tracked;
2. proves that `assemblePoc` fails closed without signing configuration;
3. generates an ephemeral CI-only PKCS12 key;
4. builds a synthetic signed POC APK;
5. verifies the APK signature;
6. does not publish that CI-only POC APK as a live artifact.

The CI key is disposable and must never be used on a physical POC device.
