[CmdletBinding()]
param(
    [ValidateRange(1, 998)]
    [int]$FirstBuildNumber = 1,

    [ValidateRange(2, 999)]
    [int]$SecondBuildNumber = 2,

    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$BuildToolsVersion = '36.0.0',

    [switch]$SkipQualityChecks,

    # CI-only regression path. It never builds or signs an APK.
    [switch]$RunAcceptanceRollbackSelfTest
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
    # objects. Decide native success only from LASTEXITCODE and never echo
    # arguments because they can name signing-related environment variables.
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
        return @($Output | ForEach-Object { $_.ToString() })
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
    return (Get-GitOutput @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
}

function Get-CurrentTree {
    return (Get-GitOutput @('rev-parse', 'HEAD^{tree}') | Select-Object -First 1).Trim()
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

function Get-SigningEnvironment {
    $EnvironmentNames = @(
        'WLB_POC_KEYSTORE_PATH',
        'WLB_POC_KEYSTORE_PASSWORD',
        'WLB_POC_KEY_ALIAS',
        'WLB_POC_KEY_PASSWORD'
    )
    $Values = @{}
    foreach ($Name in $EnvironmentNames) {
        $Values[$Name] = [Environment]::GetEnvironmentVariable($Name)
    }

    $Missing = @(
        $EnvironmentNames |
            Where-Object { [string]::IsNullOrWhiteSpace($Values[$_]) }
    )
    if ($Missing.Count -ne 0) {
        throw (
            'The canonical signing helper requires all four WLB_POC_* signing ' +
            'environment variables. Direct Gradle builds may use the ignored ' +
            'android-app\keystore.properties fallback, but this helper deliberately ' +
            'does not implement a second Java-properties parser. Missing: {0}' -f `
            ($Missing -join ', ')
        )
    }

    $CandidatePath = $Values['WLB_POC_KEYSTORE_PATH']
    if (-not [System.IO.Path]::IsPathRooted($CandidatePath)) {
        $CandidatePath = Join-Path $RepoRoot $CandidatePath
    }
    $ResolvedPath = [System.IO.Path]::GetFullPath($CandidatePath)
    if (-not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
        throw ('POC keystore does not exist: {0}' -f $ResolvedPath)
    }

    return [pscustomobject]@{
        Path = $ResolvedPath
        Alias = $Values['WLB_POC_KEY_ALIAS']
        StorePasswordEnvironmentName = 'WLB_POC_KEYSTORE_PASSWORD'
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
        $Match = [regex]::Match($Line, '^WLB_POC_([^=]+)=(.*)$')
        if ($Match.Success) {
            $Values[$Match.Groups[1].Value] = $Match.Groups[2].Value
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
    $CertificateText = $CertificateOutput -join "`n"

    $SignerCountMatch = [regex]::Match(
        $CertificateText,
        '(?m)^Number of signers:\s*(\d+)\s*$'
    )
    $SignerDigests = @(
        [regex]::Matches(
            $CertificateText,
            '(?m)^(?:Signer #\d+|.*Signer):?\s+certificate SHA-256 digest:\s*(\S+)\s*$'
        ) |
            ForEach-Object {
                $_.Groups[1].Value.Replace(':', '').ToLowerInvariant()
            } |
            Sort-Object -Unique
    )

    if (-not $SignerCountMatch.Success -or
        [int]$SignerCountMatch.Groups[1].Value -ne 1 -or
        $SignerDigests.Count -ne 1) {
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
    $BadgingText = $BadgingOutput -join "`n"
    if ($BadgingText.Contains('application-debuggable')) {
        throw ('POC APK must not be debuggable: {0}' -f $ApkPath)
    }

    $PackageLine = $BadgingOutput | Select-Object -First 1
    $PackageMatch = [regex]::Match(
        $PackageLine,
        "^package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']+)'(?:\s|$)"
    )
    if (-not $PackageMatch.Success) {
        throw ('Could not parse APK package identity: {0}' -f $ApkPath)
    }

    $ApplicationId = $PackageMatch.Groups[1].Value
    $VersionCode = [int64]$PackageMatch.Groups[2].Value
    $VersionName = $PackageMatch.Groups[3].Value
    if ($ApplicationId -ne $ExpectedIdentity.ApplicationId -or
        $VersionCode -ne $ExpectedIdentity.VersionCode -or
        $VersionName -ne $ExpectedIdentity.VersionName) {
        throw ('APK identity mismatch for {0}. Actual={1}/{2}/{3}; Expected={4}/{5}/{6}' -f `
            $ApkPath,
            $ApplicationId,
            $VersionCode,
            $VersionName,
            $ExpectedIdentity.ApplicationId,
            $ExpectedIdentity.VersionCode,
            $ExpectedIdentity.VersionName)
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
        StagedDirectory = $StagedDirectory
        ApkName = $ApkName
    }
}

function Accept-StagedArtifactPair {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$StagedDirectories,

        [Parameter(Mandatory = $true)]
        [string[]]$FinalDirectories,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Finalize,

        [ValidateSet('None', 'AfterFirstMove', 'AfterSecondMove')]
        [string]$InjectedFailurePoint = 'None'
    )

    if ($StagedDirectories.Count -ne 2 -or $FinalDirectories.Count -ne 2) {
        throw 'Artifact acceptance requires exactly two staged and two final directories.'
    }

    $AcceptedDirectories = @()
    $AcceptanceComplete = $false
    try {
        Move-Item `
            -LiteralPath $StagedDirectories[0] `
            -Destination $FinalDirectories[0]
        $AcceptedDirectories += $FinalDirectories[0]

        if ($InjectedFailurePoint -eq 'AfterFirstMove') {
            throw 'Injected rollback regression after first artifact move.'
        }

        Move-Item `
            -LiteralPath $StagedDirectories[1] `
            -Destination $FinalDirectories[1]
        $AcceptedDirectories += $FinalDirectories[1]

        if ($InjectedFailurePoint -eq 'AfterSecondMove') {
            throw 'Injected rollback regression after second artifact move.'
        }

        & $Finalize
        $AcceptanceComplete = $true
    }
    finally {
        if (-not $AcceptanceComplete) {
            foreach ($Directory in $AcceptedDirectories) {
                Remove-Item `
                    -LiteralPath $Directory `
                    -Recurse `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
        }
    }
}

function Invoke-AcceptanceRollbackSelfTest {
    $SelfTestRoot = Join-Path `
        $ArtifactsRoot `
        ('.rollback-self-test-' + [guid]::NewGuid().ToString('N'))

    try {
        foreach ($Scenario in @('AfterFirstMove', 'AfterSecondMove', 'FinalizeFailure')) {
            $ScenarioRoot = Join-Path $SelfTestRoot $Scenario
            $StagingRoot = Join-Path $ScenarioRoot 'staging'
            $FinalRoot = Join-Path $ScenarioRoot 'final'
            $StagedDirectories = @(
                Join-Path $StagingRoot 'first'
                Join-Path $StagingRoot 'second'
            )
            $FinalDirectories = @(
                Join-Path $FinalRoot 'first'
                Join-Path $FinalRoot 'second'
            )

            New-Item -ItemType Directory -Path $StagedDirectories[0] -Force | Out-Null
            New-Item -ItemType Directory -Path $StagedDirectories[1] -Force | Out-Null
            New-Item -ItemType Directory -Path $FinalRoot -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $StagedDirectories[0] 'marker.txt') -Value 'first'
            Set-Content -LiteralPath (Join-Path $StagedDirectories[1] 'marker.txt') -Value 'second'

            $FailureObserved = $false
            try {
                $FailurePoint = if ($Scenario -eq 'FinalizeFailure') {
                    'None'
                }
                else {
                    $Scenario
                }
                $Finalize = if ($Scenario -eq 'FinalizeFailure') {
                    { throw 'Injected rollback regression from final validation.' }
                }
                else {
                    { }
                }

                Accept-StagedArtifactPair `
                    -StagedDirectories $StagedDirectories `
                    -FinalDirectories $FinalDirectories `
                    -Finalize $Finalize `
                    -InjectedFailurePoint $FailurePoint
            }
            catch {
                $FailureObserved = $true
            }

            if (-not $FailureObserved) {
                throw ('Rollback self-test did not inject a failure: {0}' -f $Scenario)
            }
            foreach ($Directory in $FinalDirectories) {
                if (Test-Path -LiteralPath $Directory) {
                    throw ('Rollback self-test left an accepted directory: {0}' -f $Directory)
                }
            }
        }

        Write-Host '[POC_SIGNING_ROLLBACK_SELF_TEST] PASS'
    }
    finally {
        Remove-Item `
            -LiteralPath $SelfTestRoot `
            -Recurse `
            -Force `
            -ErrorAction SilentlyContinue
    }
}

if ($RunAcceptanceRollbackSelfTest) {
    Invoke-AcceptanceRollbackSelfTest
    return
}

if (-not (Test-Path -LiteralPath $Gradle -PathType Leaf)) {
    throw ('Gradle wrapper was not found: {0}' -f $Gradle)
}

$script:Git = Get-RequiredCommandPath @('git.exe', 'git')
$KeyTool = Get-RequiredCommandPath @('keytool.exe', 'keytool')
$Signing = Get-SigningEnvironment

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
    throw ("Tracked/non-ignored-untracked source tree must be clean before POC artifact production:`n{0}" -f `
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
$RunStagingRoot = Join-Path $ArtifactsRoot ('.run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $RunStagingRoot | Out-Null

$CertificatePath = Join-Path `
    $env:TEMP `
    ('wlb-poc-signing-' + [guid]::NewGuid().ToString('N') + '.der')

try {
    $CertificateArguments = @(
        '-exportcert',
        '-storetype', 'PKCS12',
        '-keystore', $Signing.Path,
        '-alias', $Signing.Alias,
        '-storepass:env', $Signing.StorePasswordEnvironmentName,
        '-file', $CertificatePath
    )
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

    $FinalizeAcceptance = {
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

    Accept-StagedArtifactPair `
        -StagedDirectories @(
            $FirstStaged.StagedDirectory,
            $SecondStaged.StagedDirectory
        ) `
        -FinalDirectories $FinalDirectories `
        -Finalize $FinalizeAcceptance
}
finally {
    if (Test-Path -LiteralPath $CertificatePath) {
        Remove-Item -LiteralPath $CertificatePath -Force
    }
    if (Test-Path -LiteralPath $RunStagingRoot) {
        Remove-Item -LiteralPath $RunStagingRoot -Recurse -Force
    }
}
