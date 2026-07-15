[CmdletBinding()]
param(
    [ValidateRange(1, 998)]
    [int]$FirstBuildNumber = 1,

    [ValidateRange(2, 999)]
    [int]$SecondBuildNumber = 2,

    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$BuildToolsVersion = '36.0.0',

    [switch]$SkipQualityChecks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($SecondBuildNumber -le $FirstBuildNumber) {
    throw 'SecondBuildNumber must be greater than FirstBuildNumber.'
}

$ScriptRoot = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptRoot '..')).Path
$AndroidRoot = Join-Path $RepoRoot 'android-app'
$Gradle = Join-Path $AndroidRoot 'gradlew.bat'
$ArtifactsRoot = Join-Path $RepoRoot 'local-artifacts\poc-signing-smoke'
$MutablePocOutput = Join-Path $AndroidRoot 'app\build\outputs\apk\poc'
$MutablePocApk = Join-Path $MutablePocOutput 'app-poc.apk'

function Get-RequiredCommandPath {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Names
    )

    foreach ($Name in $Names) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($Command) {
            return $Command.Source
        }
    }

    throw ('Required command was not found: {0}' -f ($Names -join ', '))
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [switch]$CaptureOutput
    )

    # Windows PowerShell 5.1 converts redirected native stderr into ErrorRecord
    # objects. A successful keytool/Gradle command can therefore terminate a
    # script whose global ErrorActionPreference is Stop. Limit Continue to this
    # native invocation and decide success exclusively from LASTEXITCODE.
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $Output = @(& $Command @Arguments 2>&1)
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }

    if ($ExitCode -ne 0) {
        $Output | ForEach-Object { Write-Host $_ }
        throw ('External command failed with exit code {0}: {1}' -f $ExitCode, $Command)
    }

    if ($CaptureOutput) {
        return $Output
    }

    $Output | ForEach-Object { Write-Host $_ }
}

function Get-GitOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    return @(
        Invoke-NativeCommand `
            -Command $script:Git `
            -Arguments (@('-C', $RepoRoot) + $Arguments) `
            -CaptureOutput
    )
}

function Get-CurrentCommit {
    return (Get-GitOutput @('rev-parse', 'HEAD') | Select-Object -First 1).ToString().Trim()
}

function Get-CurrentTree {
    return (Get-GitOutput @('rev-parse', 'HEAD^{tree}') | Select-Object -First 1).ToString().Trim()
}

function Get-SourceStatus {
    return @(Get-GitOutput @('status', '--porcelain=v1', '--untracked-files=all'))
}

function Assert-SourceUnchanged {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCommit,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedTree,

        [Parameter(Mandatory = $true)]
        [string]$Stage
    )

    if ((Get-CurrentCommit) -ne $ExpectedCommit) {
        throw ("HEAD changed during POC artifact production at stage '{0}'." -f $Stage)
    }
    if ((Get-CurrentTree) -ne $ExpectedTree) {
        throw ("Git tree changed during POC artifact production at stage '{0}'." -f $Stage)
    }

    $Status = @(Get-SourceStatus)
    if ($Status.Count -ne 0) {
        throw ("Source tree is not clean at stage '{0}':`n{1}" -f `
            $Stage,
            ($Status -join [Environment]::NewLine))
    }
}

function Read-PropertiesValue {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Lines,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $Pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
    foreach ($Line in $Lines) {
        if ($Line -match $Pattern) {
            return $Matches[1].Trim()
        }
    }

    return $null
}

function Convert-PropertiesPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $Backslash = [string][char]92
    return $Value.Replace($Backslash + $Backslash, $Backslash).Replace($Backslash + ':', ':')
}

function Get-SigningMetadata {
    $EnvironmentNames = @(
        'WLB_POC_KEYSTORE_PATH',
        'WLB_POC_KEYSTORE_PASSWORD',
        'WLB_POC_KEY_ALIAS',
        'WLB_POC_KEY_PASSWORD'
    )
    $EnvironmentValues = @{}
    foreach ($Name in $EnvironmentNames) {
        $EnvironmentValues[$Name] = [Environment]::GetEnvironmentVariable($Name)
    }

    $PresentEnvironmentNames = @(
        $EnvironmentNames |
            Where-Object { -not [string]::IsNullOrWhiteSpace($EnvironmentValues[$_]) }
    )

    if ($PresentEnvironmentNames.Count -gt 0 -and
        $PresentEnvironmentNames.Count -ne $EnvironmentNames.Count) {
        throw 'POC signing environment is partial. Supply all four WLB_POC_* signing values or clear all four and use android-app\keystore.properties.'
    }

    $PasswordEnvironmentName = $null
    if ($PresentEnvironmentNames.Count -eq $EnvironmentNames.Count) {
        $StorePath = $EnvironmentValues['WLB_POC_KEYSTORE_PATH']
        $Alias = $EnvironmentValues['WLB_POC_KEY_ALIAS']
        $PasswordEnvironmentName = 'WLB_POC_KEYSTORE_PASSWORD'
    }
    else {
        $PropertiesPath = Join-Path $AndroidRoot 'keystore.properties'
        if (-not (Test-Path -LiteralPath $PropertiesPath -PathType Leaf)) {
            throw 'POC signing is not configured. Set all four WLB_POC_* signing variables or create android-app\keystore.properties.'
        }

        $Lines = Get-Content -LiteralPath $PropertiesPath
        $PropertyNames = @(
            'wlb.poc.storeFile',
            'wlb.poc.storePassword',
            'wlb.poc.keyAlias',
            'wlb.poc.keyPassword'
        )
        $PropertyValues = @{}
        foreach ($Name in $PropertyNames) {
            $PropertyValues[$Name] = Read-PropertiesValue -Lines $Lines -Name $Name
        }

        $MissingProperties = @(
            $PropertyNames |
                Where-Object { [string]::IsNullOrWhiteSpace($PropertyValues[$_]) }
        )
        if ($MissingProperties.Count -ne 0) {
            throw ('keystore.properties is missing: {0}' -f ($MissingProperties -join ', '))
        }

        $StorePath = Convert-PropertiesPath $PropertyValues['wlb.poc.storeFile']
        $Alias = $PropertyValues['wlb.poc.keyAlias']
    }

    $CandidatePath = if ([System.IO.Path]::IsPathRooted($StorePath)) {
        $StorePath
    }
    else {
        Join-Path $AndroidRoot $StorePath
    }
    $ResolvedPath = [System.IO.Path]::GetFullPath($CandidatePath)

    if (-not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
        throw ('POC keystore does not exist: {0}' -f $ResolvedPath)
    }

    return [pscustomobject]@{
        Path = $ResolvedPath
        Alias = $Alias
        PasswordEnvironmentName = $PasswordEnvironmentName
    }
}

function Invoke-AndroidGradle {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [switch]$CaptureOutput
    )

    Push-Location $AndroidRoot
    try {
        return Invoke-NativeCommand `
            -Command $Gradle `
            -Arguments $Arguments `
            -CaptureOutput:$CaptureOutput
    }
    finally {
        Pop-Location
    }
}

function Get-PocIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [int]$BuildNumber
    )

    $PreviousBuildNumber = $env:WLB_POC_BUILD_NUMBER
    try {
        $env:WLB_POC_BUILD_NUMBER = [string]$BuildNumber
        $Output = @(
            Invoke-AndroidGradle `
                -Arguments @('--no-daemon', '--quiet', ':app:printPocIdentity') `
                -CaptureOutput
        )
    }
    finally {
        $env:WLB_POC_BUILD_NUMBER = $PreviousBuildNumber
    }

    $Values = @{}
    foreach ($Line in $Output) {
        $Text = $Line.ToString()
        if ($Text -match '^WLB_POC_([^=]+)=(.*)$') {
            $Values[$Matches[1]] = $Matches[2]
        }
    }

    foreach ($RequiredName in @('APPLICATION_ID', 'VERSION_CODE', 'VERSION_NAME')) {
        if (-not $Values.ContainsKey($RequiredName) -or
            [string]::IsNullOrWhiteSpace($Values[$RequiredName])) {
            throw ('Gradle did not report WLB_POC_{0} for build number {1}.' -f `
                $RequiredName,
                $BuildNumber)
        }
    }

    return [pscustomobject]@{
        ApplicationId = $Values['APPLICATION_ID']
        VersionCode = [int64]$Values['VERSION_CODE']
        VersionName = $Values['VERSION_NAME']
    }
}

function Get-ApkEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ApkPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedCertificateSha256,

        [Parameter(Mandatory = $true)]
        [pscustomobject]$ExpectedIdentity,

        [Parameter(Mandatory = $true)]
        [string]$Aapt,

        [Parameter(Mandatory = $true)]
        [string]$ApkSigner
    )

    $CertificateOutput = @(
        Invoke-NativeCommand `
            -Command $ApkSigner `
            -Arguments @('verify', '--verbose', '--print-certs', $ApkPath) `
            -CaptureOutput
    )

    $SignerCount = $null
    $SignerDigests = @()
    foreach ($Line in $CertificateOutput) {
        $Text = $Line.ToString()
        if ($Text -match '^Number of signers:\s*(\d+)\s*$') {
            $SignerCount = [int]$Matches[1]
        }
        if ($Text -match '^(?:Signer #\d+|.*Signer):?\s+certificate SHA-256 digest:\s*(\S+)\s*$') {
            $SignerDigests += $Matches[1].Replace(':', '').ToLowerInvariant()
        }
    }
    $SignerDigests = @($SignerDigests | Sort-Object -Unique)

    if ($SignerCount -ne 1 -or $SignerDigests.Count -ne 1) {
        throw ('APK must contain exactly one unique signer certificate: {0}' -f $ApkPath)
    }
    if ($SignerDigests[0] -ne $ExpectedCertificateSha256) {
        throw ('APK signer certificate does not match the configured POC keystore: {0}' -f $ApkPath)
    }

    $BadgingOutput = @(
        Invoke-NativeCommand `
            -Command $Aapt `
            -Arguments @('dump', 'badging', $ApkPath) `
            -CaptureOutput
    )
    $BadgingText = ($BadgingOutput | ForEach-Object { $_.ToString() }) -join "`n"
    if ($BadgingText -match 'application-debuggable') {
        throw ('POC APK must not be debuggable: {0}' -f $ApkPath)
    }

    $PackageLine = ($BadgingOutput | Select-Object -First 1).ToString()
    if ($PackageLine -notmatch "^package: name='([^']+)'.*versionCode='([^']+)'.*versionName='([^']+)'") {
        throw ('Could not parse APK package identity: {0}' -f $ApkPath)
    }

    $ApplicationId = $Matches[1]
    $VersionCode = [int64]$Matches[2]
    $VersionName = $Matches[3]

    if ($ApplicationId -ne $ExpectedIdentity.ApplicationId -or
        $VersionCode -ne $ExpectedIdentity.VersionCode -or
        $VersionName -ne $ExpectedIdentity.VersionName) {
        throw ('APK identity does not match Gradle identity: {0}' -f $ApkPath)
    }

    return [pscustomobject]@{
        ApplicationId = $ApplicationId
        VersionCode = $VersionCode
        VersionName = $VersionName
        CertificateSha256 = $SignerDigests[0]
        ApkSha256 = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Debuggable = $false
    }
}

function Write-Utf8NoBomJson {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $Json = $Value | ConvertTo-Json -Depth 5
    $Utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText(
        $Path,
        $Json + [Environment]::NewLine,
        $Utf8NoBom
    )
}

function Build-PocIntoStaging {
    param(
        [Parameter(Mandatory = $true)]
        [int]$BuildNumber,

        [Parameter(Mandatory = $true)]
        [pscustomobject]$Identity,

        [Parameter(Mandatory = $true)]
        [string]$RunStagingRoot,

        [Parameter(Mandatory = $true)]
        [string]$SourceCommit,

        [Parameter(Mandatory = $true)]
        [string]$SourceTree,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedCertificateSha256,

        [Parameter(Mandatory = $true)]
        [string]$Aapt,

        [Parameter(Mandatory = $true)]
        [string]$ApkSigner
    )

    $PreviousBuildNumber = $env:WLB_POC_BUILD_NUMBER
    try {
        $env:WLB_POC_BUILD_NUMBER = [string]$BuildNumber
        Remove-Item `
            -LiteralPath $MutablePocOutput `
            -Recurse `
            -Force `
            -ErrorAction SilentlyContinue
        Invoke-AndroidGradle -Arguments @('--no-daemon', ':app:assemblePoc')
    }
    finally {
        $env:WLB_POC_BUILD_NUMBER = $PreviousBuildNumber
    }

    Assert-SourceUnchanged `
        -ExpectedCommit $SourceCommit `
        -ExpectedTree $SourceTree `
        -Stage ('after build {0}' -f $BuildNumber)

    if (-not (Test-Path -LiteralPath $MutablePocApk -PathType Leaf)) {
        throw ('Gradle did not produce the expected POC APK: {0}' -f $MutablePocApk)
    }

    $StagedDirectory = Join-Path $RunStagingRoot $Identity.VersionName
    New-Item -ItemType Directory -Path $StagedDirectory | Out-Null
    $ApkName = 'whitelist-bypass-{0}.apk' -f $Identity.VersionName
    $StagedApk = Join-Path $StagedDirectory $ApkName
    Copy-Item -LiteralPath $MutablePocApk -Destination $StagedApk

    $Evidence = Get-ApkEvidence `
        -ApkPath $StagedApk `
        -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
        -ExpectedIdentity $Identity `
        -Aapt $Aapt `
        -ApkSigner $ApkSigner

    Assert-SourceUnchanged `
        -ExpectedCommit $SourceCommit `
        -ExpectedTree $SourceTree `
        -Stage ('before manifest {0}' -f $BuildNumber)

    $Manifest = [ordered]@{
        schemaVersion = 1
        applicationId = $Evidence.ApplicationId
        version = $Evidence.VersionName
        versionCode = $Evidence.VersionCode
        gitCommit = $SourceCommit
        gitTree = $SourceTree
        apk = $ApkName
        apkSha256 = $Evidence.ApkSha256
        certificateSha256 = $Evidence.CertificateSha256
        debuggable = $Evidence.Debuggable
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-Utf8NoBomJson `
        -Value $Manifest `
        -Path (Join-Path $StagedDirectory 'BUILD-MANIFEST.json')

    return [pscustomobject]@{
        Identity = $Identity
        StagedDirectory = $StagedDirectory
        ApkName = $ApkName
    }
}

if (-not (Test-Path -LiteralPath $Gradle -PathType Leaf)) {
    throw ('Gradle wrapper was not found: {0}' -f $Gradle)
}

$script:Git = Get-RequiredCommandPath @('git.exe', 'git')
$KeyTool = Get-RequiredCommandPath @('keytool.exe', 'keytool')
$Signing = Get-SigningMetadata

$SdkRoot = if (-not [string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) {
    $env:ANDROID_HOME
}
else {
    Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}
$BuildToolsRoot = Join-Path $SdkRoot ('build-tools\{0}' -f $BuildToolsVersion)
$Aapt = Join-Path $BuildToolsRoot 'aapt.exe'
$ApkSigner = Join-Path $BuildToolsRoot 'apksigner.bat'

if (-not (Test-Path -LiteralPath $Aapt -PathType Leaf) -or
    -not (Test-Path -LiteralPath $ApkSigner -PathType Leaf)) {
    throw ('Pinned Android build-tools {0} were not found under {1}.' -f `
        $BuildToolsVersion,
        $BuildToolsRoot)
}

$InitialStatus = @(Get-SourceStatus)
if ($InitialStatus.Count -ne 0) {
    throw ("Tracked/untracked source tree must be clean before POC artifact production:`n{0}" -f `
        ($InitialStatus -join [Environment]::NewLine))
}

$SourceCommit = Get-CurrentCommit
$SourceTree = Get-CurrentTree
$FirstIdentity = Get-PocIdentity -BuildNumber $FirstBuildNumber
$SecondIdentity = Get-PocIdentity -BuildNumber $SecondBuildNumber

if ($SecondIdentity.VersionCode -le $FirstIdentity.VersionCode) {
    throw 'Second POC versionCode must be greater than the first POC versionCode.'
}

$FinalDirectories = @(
    Join-Path $ArtifactsRoot $FirstIdentity.VersionName
    Join-Path $ArtifactsRoot $SecondIdentity.VersionName
)
foreach ($Directory in $FinalDirectories) {
    if (Test-Path -LiteralPath $Directory) {
        throw ('Refusing to reuse existing smoke artifact directory: {0}' -f $Directory)
    }
}

Assert-SourceUnchanged `
    -ExpectedCommit $SourceCommit `
    -ExpectedTree $SourceTree `
    -Stage 'before quality checks'

if (-not $SkipQualityChecks) {
    Invoke-AndroidGradle -Arguments @('--no-daemon', 'test')
    Invoke-AndroidGradle -Arguments @('--no-daemon', 'lint')
    Invoke-AndroidGradle -Arguments @('--no-daemon', 'assembleDebug')

    Assert-SourceUnchanged `
        -ExpectedCommit $SourceCommit `
        -ExpectedTree $SourceTree `
        -Stage 'after quality checks'
}

New-Item -ItemType Directory -Path $ArtifactsRoot -Force | Out-Null
$RunStagingRoot = Join-Path `
    $ArtifactsRoot `
    ('.run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $RunStagingRoot | Out-Null

$CertificatePath = Join-Path `
    $env:TEMP `
    ('wlb-poc-signing-' + [guid]::NewGuid().ToString('N') + '.der')

try {
    $CertificateArguments = @(
        '-exportcert',
        '-storetype', 'PKCS12',
        '-keystore', $Signing.Path,
        '-alias', $Signing.Alias
    )
    if (-not [string]::IsNullOrWhiteSpace($Signing.PasswordEnvironmentName)) {
        $CertificateArguments += '-storepass:env'
        $CertificateArguments += $Signing.PasswordEnvironmentName
    }
    $CertificateArguments += '-file'
    $CertificateArguments += $CertificatePath

    Invoke-NativeCommand -Command $KeyTool -Arguments $CertificateArguments
    $ExpectedCertificateSha256 = (
        Get-FileHash -LiteralPath $CertificatePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()

    $FirstStaged = Build-PocIntoStaging `
        -BuildNumber $FirstBuildNumber `
        -Identity $FirstIdentity `
        -RunStagingRoot $RunStagingRoot `
        -SourceCommit $SourceCommit `
        -SourceTree $SourceTree `
        -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
        -Aapt $Aapt `
        -ApkSigner $ApkSigner

    $SecondStaged = Build-PocIntoStaging `
        -BuildNumber $SecondBuildNumber `
        -Identity $SecondIdentity `
        -RunStagingRoot $RunStagingRoot `
        -SourceCommit $SourceCommit `
        -SourceTree $SourceTree `
        -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
        -Aapt $Aapt `
        -ApkSigner $ApkSigner

    Assert-SourceUnchanged `
        -ExpectedCommit $SourceCommit `
        -ExpectedTree $SourceTree `
        -Stage 'before accepting artifact pair'

    foreach ($Directory in $FinalDirectories) {
        if (Test-Path -LiteralPath $Directory) {
            throw ('Refusing to overwrite smoke artifact directory created concurrently: {0}' -f $Directory)
        }
    }

    Move-Item `
        -LiteralPath $FirstStaged.StagedDirectory `
        -Destination $FinalDirectories[0]
    Move-Item `
        -LiteralPath $SecondStaged.StagedDirectory `
        -Destination $FinalDirectories[1]

    Assert-SourceUnchanged `
        -ExpectedCommit $SourceCommit `
        -ExpectedTree $SourceTree `
        -Stage 'after artifact preservation'

    Write-Host '[POC_SIGNING_SMOKE] PASS'
    Write-Host ('Commit: {0}' -f $SourceCommit)
    Write-Host ('Tree:   {0}' -f $SourceTree)
    Write-Host ('First:  {0}' -f $FinalDirectories[0])
    Write-Host ('Second: {0}' -f $FinalDirectories[1])
}
finally {
    if (Test-Path -LiteralPath $CertificatePath) {
        Remove-Item -LiteralPath $CertificatePath -Force
    }
    if (Test-Path -LiteralPath $RunStagingRoot) {
        Remove-Item -LiteralPath $RunStagingRoot -Recurse -Force
    }
}
