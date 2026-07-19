[CmdletBinding()]
param(
    [ValidateRange(1, 998)]
    [int]$FirstBuildNumber = 1,

    [ValidateRange(2, 999)]
    [int]$SecondBuildNumber = 2,

    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedCertificateSha256,

    [switch]$SkipQualityChecks,

    # Public CI may verify the mechanism with a disposable certificate even
    # after the real public identity is committed. This switch is rejected
    # outside GitHub Actions.
    [switch]$AllowSyntheticCiCertificate,

    # CI-only regression path. It never builds or signs an APK.
    [switch]$RunSafetySelfTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PinnedBuildToolsVersion = '36.0.0'
$ExpectedApplicationId = 'app.northbridge.mobile'
$ExpectedPocLauncher = 'app.northbridge.mobile.EntryActivity'
$ExpectedPocLabel = 'Northbridge'
$SigningEnvironmentNames = @(
    'WLB_POC_KEYSTORE_PATH',
    'WLB_POC_KEYSTORE_PASSWORD',
    'WLB_POC_KEY_ALIAS',
    'WLB_POC_KEY_PASSWORD'
)

$ScriptRoot = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptRoot '..')).Path
$AndroidRoot = Join-Path $RepoRoot 'android-app'
$Gradle = Join-Path $AndroidRoot 'gradlew.bat'
$ArtifactsRoot = Join-Path $RepoRoot 'local-artifacts\poc-signing-smoke'
$MutablePocOutput = Join-Path $AndroidRoot 'app\build\outputs\apk\poc'
$MutablePocApk = Join-Path $MutablePocOutput 'app-poc.apk'
$RunLockPath = Join-Path $ArtifactsRoot '.locks\poc-signing-smoke.lock'
$PublicIdentityPath = Join-Path $AndroidRoot 'poc-signing-identity.json'

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
    # arguments because they may identify signing-related environment variables.
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

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $Resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $Separator = [System.IO.Path]::DirectorySeparatorChar
    $Alternate = [System.IO.Path]::AltDirectorySeparatorChar
    return ([System.IO.Path]::GetFullPath($Resolved).Replace($Alternate, $Separator)).TrimEnd($Separator)
}

function Test-PathWithinDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath,

        [Parameter(Mandatory = $true)]
        [string]$DirectoryPath
    )

    $Candidate = Get-NormalizedPath -Path $CandidatePath
    $Directory = Get-NormalizedPath -Path $DirectoryPath
    $Comparison = if ($env:OS -eq 'Windows_NT') {
        [System.StringComparison]::OrdinalIgnoreCase
    }
    else {
        [System.StringComparison]::Ordinal
    }
    $Separator = [System.IO.Path]::DirectorySeparatorChar

    return $Candidate.Equals($Directory, $Comparison) -or
        $Candidate.StartsWith($Directory + $Separator, $Comparison)
}

function Assert-KeystoreOutsideRepository {
    param(
        [Parameter(Mandatory = $true)]
        [string]$KeystorePath
    )

    if (Test-PathWithinDirectory -CandidatePath $KeystorePath -DirectoryPath $RepoRoot) {
        throw 'POC signing keystore must be outside the repository, including ignored directories such as secrets and local-artifacts.'
    }
}

function Clear-SigningEnvironment {
    foreach ($Name in $SigningEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
}

function Get-SigningEnvironmentSnapshot {
    $Values = @{}
    foreach ($Name in $SigningEnvironmentNames) {
        $Values[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }

    $Missing = @(
        $SigningEnvironmentNames |
            Where-Object { [string]::IsNullOrWhiteSpace($Values[$_]) }
    )
    if ($Missing.Count -ne 0) {
        throw (
            'The canonical signing helper requires all four WLB_POC_* signing ' +
            'environment variables. Use tools\invoke-poc-signing-smoke.ps1 for ' +
            'interactive operator runs. Missing: {0}' -f ($Missing -join ', ')
        )
    }

    $CandidatePath = $Values['WLB_POC_KEYSTORE_PATH']
    if (-not [System.IO.Path]::IsPathRooted($CandidatePath)) {
        $CandidatePath = Join-Path $RepoRoot $CandidatePath
    }
    $ResolvedPath = (Resolve-Path -LiteralPath $CandidatePath -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
        throw ('POC keystore does not exist: {0}' -f $ResolvedPath)
    }
    Assert-KeystoreOutsideRepository -KeystorePath $ResolvedPath

    return [pscustomobject]@{
        Path = $ResolvedPath
        StorePassword = $Values['WLB_POC_KEYSTORE_PASSWORD']
        Alias = $Values['WLB_POC_KEY_ALIAS']
        KeyPassword = $Values['WLB_POC_KEY_PASSWORD']
    }
}

function Invoke-WithSigningEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Signing,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    try {
        [Environment]::SetEnvironmentVariable('WLB_POC_KEYSTORE_PATH', $Signing.Path, 'Process')
        [Environment]::SetEnvironmentVariable('WLB_POC_KEYSTORE_PASSWORD', $Signing.StorePassword, 'Process')
        [Environment]::SetEnvironmentVariable('WLB_POC_KEY_ALIAS', $Signing.Alias, 'Process')
        [Environment]::SetEnvironmentVariable('WLB_POC_KEY_PASSWORD', $Signing.KeyPassword, 'Process')
        & $Action
    }
    finally {
        Clear-SigningEnvironment
    }
}

function Enter-RunLock {
    $LockDirectory = Split-Path -Parent $RunLockPath
    New-Item -ItemType Directory -Path $LockDirectory -Force | Out-Null

    try {
        $Stream = [System.IO.File]::Open(
            $RunLockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch [System.IO.IOException] {
        throw 'Another POC signing smoke is already running for this repository.'
    }

    $Bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$PID)
    $Stream.SetLength(0)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush()
    return $Stream
}

function Exit-RunLock {
    param([System.IO.FileStream]$Stream)

    if ($null -ne $Stream) {
        $Stream.Dispose()
    }
    # Keep the ignored lock file in place. Deleting it after releasing the
    # handle would create a race on platforms that allow unlinking an open file.
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
    param([Parameter(Mandatory = $true)][int]$BuildNumber)

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
        [Parameter(Mandatory = $true)][string]$ApkPath,
        [Parameter(Mandatory = $true)][string]$ExpectedCertificateSha256,
        [Parameter(Mandatory = $true)][pscustomobject]$ExpectedIdentity,
        [Parameter(Mandatory = $true)][string]$Aapt,
        [Parameter(Mandatory = $true)][string]$ApkSigner
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
        throw ('APK signer certificate does not match the pinned POC signing identity: {0}' -f $ApkPath)
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

    $ApplicationLabelMatch = [regex]::Match(
        $BadgingText,
        "(?m)^application-label:'([^']*)'\s*$"
    )
    if (-not $ApplicationLabelMatch.Success -or
        $ApplicationLabelMatch.Groups[1].Value -ne $ExpectedPocLabel) {
        throw ('POC APK application label mismatch: {0}' -f $ApkPath)
    }

    $ManifestTreeOutput = @(
        Invoke-NativeCommand `
            -Command $Aapt `
            -Arguments @('dump', 'xmltree', $ApkPath, 'AndroidManifest.xml') `
            -CaptureOutput
    )
    $ElementBlocks = @()
    for ($Index = 0; $Index -lt $ManifestTreeOutput.Count; $Index++) {
        $ElementMatch = [regex]::Match(
            $ManifestTreeOutput[$Index],
            '^(\s*)E:\s+(application|activity|activity-alias|service|provider)(?:\s|\(|$)'
        )
        if (-not $ElementMatch.Success) {
            continue
        }

        $Indent = $ElementMatch.Groups[1].Value.Length
        $EndIndex = $ManifestTreeOutput.Count
        for ($NextIndex = $Index + 1; $NextIndex -lt $ManifestTreeOutput.Count; $NextIndex++) {
            $NextElementMatch = [regex]::Match(
                $ManifestTreeOutput[$NextIndex],
                '^(\s*)E:\s+'
            )
            if ($NextElementMatch.Success -and
                $NextElementMatch.Groups[1].Value.Length -le $Indent) {
                $EndIndex = $NextIndex
                break
            }
        }

        $BlockText = ($ManifestTreeOutput[$Index..($EndIndex - 1)] -join "`n")
        $NameMatch = [regex]::Match(
            $BlockText,
            '(?m)^\s*A:\s+android:name(?:\([^)]*\))?="([^"]+)"(?:\s|\(|$)'
        )
        $ElementBlocks += [pscustomobject]@{
            ElementName = $ElementMatch.Groups[2].Value
            AndroidName = if ($NameMatch.Success) { $NameMatch.Groups[1].Value } else { $null }
            Text = $BlockText
        }
    }

    $ApplicationBlocks = @($ElementBlocks | Where-Object { $_.ElementName -eq 'application' })
    if ($ApplicationBlocks.Count -ne 1) {
        throw ('POC APK must contain exactly one application element: {0}' -f $ApkPath)
    }
    $ApplicationBlock = $ApplicationBlocks[0].Text
    if ($ApplicationBlock -notmatch '(?m)^\s*A:\s+android:allowBackup(?:\([^)]*\))?=\(type 0x12\)0x0\s*$' -or
        $ApplicationBlock -notmatch '(?m)^\s*A:\s+android:usesCleartextTraffic(?:\([^)]*\))?=\(type 0x12\)0x0\s*$') {
        throw ('POC APK application backup/cleartext isolation is invalid: {0}' -f $ApkPath)
    }

    $ComponentBlocks = @(
        $ElementBlocks |
            Where-Object { $_.ElementName -in @('activity', 'activity-alias', 'service', 'provider') }
    )
    foreach ($ForbiddenComponent in @(
        'bypass.whitelist.MainActivity',
        'bypass.whitelist.tunnel.TunnelVpnService',
        'bypass.whitelist.tunnel.ProxyService',
        'bypass.whitelist.tunnel.HeadlessSessionService',
        'bypass.whitelist.tunnel.VpnTileService',
        'androidx.core.content.FileProvider'
    )) {
        if ($ComponentBlocks.AndroidName -contains $ForbiddenComponent) {
            throw ('POC APK contains a forbidden legacy component: {0}' -f $ForbiddenComponent)
        }
    }

    $MainPattern =
        '(?m)^\s*A:\s+android:name(?:\([^)]*\))?="android\.intent\.action\.MAIN"(?:\s|\(|$)'
    $LauncherPattern =
        '(?m)^\s*A:\s+android:name(?:\([^)]*\))?="android\.intent\.category\.LAUNCHER"(?:\s|\(|$)'
    $LauncherBlocks = @(
        $ComponentBlocks |
            Where-Object {
                $_.ElementName -in @('activity', 'activity-alias') -and
                $_.Text -match $MainPattern -and
                $_.Text -match $LauncherPattern
            }
    )
    if ($LauncherBlocks.Count -ne 1 -or
        $LauncherBlocks[0].AndroidName -ne $ExpectedPocLauncher) {
        throw ('POC APK must expose exactly one expected launcher alias: {0}' -f $ApkPath)
    }

    $AliasBlocks = @(
        $ComponentBlocks |
            Where-Object {
                $_.ElementName -eq 'activity-alias' -and
                $_.AndroidName -eq $ExpectedPocLauncher
            }
    )
    $TargetActivityName = 'bypass.whitelist.vkpoc.VkPocActivity'
    $TargetActivityBlocks = @(
        $ComponentBlocks |
            Where-Object {
                $_.ElementName -eq 'activity' -and
                $_.AndroidName -eq $TargetActivityName
            }
    )
    if ($AliasBlocks.Count -ne 1 -or $TargetActivityBlocks.Count -ne 1) {
        throw ('POC APK launcher alias or target activity is missing/duplicated: {0}' -f $ApkPath)
    }

    $AliasBlock = $AliasBlocks[0].Text
    $TargetActivityBlock = $TargetActivityBlocks[0].Text
    $TargetPattern =
        '(?m)^\s*A:\s+android:targetActivity(?:\([^)]*\))?="' +
        [regex]::Escape($TargetActivityName) +
        '"(?:\s|\(|$)'
    $AliasValid =
        $AliasBlock -match '(?m)^\s*A:\s+android:enabled(?:\([^)]*\))?=\(type 0x12\)0xffffffff\s*$' -and
        $AliasBlock -match '(?m)^\s*A:\s+android:exported(?:\([^)]*\))?=\(type 0x12\)0xffffffff\s*$' -and
        $AliasBlock -match '(?m)^\s*A:\s+android:label(?:\([^)]*\))?=@0x[0-9a-fA-F]+(?:\s|$)' -and
        $AliasBlock -match $TargetPattern -and
        $AliasBlock -match $MainPattern -and
        $AliasBlock -match $LauncherPattern
    if (-not $AliasValid) {
        throw ('POC APK launcher alias attributes are invalid: {0}' -f $ApkPath)
    }
    if ($TargetActivityBlock -notmatch '(?m)^\s*A:\s+android:exported(?:\([^)]*\))?=\(type 0x12\)0x0\s*$') {
        throw ('POC APK target activity must remain unexported: {0}' -f $ApkPath)
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
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $Json = $Value | ConvertTo-Json -Depth 6
    $Utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText(
        $Path,
        $Json + [Environment]::NewLine,
        $Utf8NoBom
    )
}

function Export-SigningCertificate {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Signing,
        [Parameter(Mandatory = $true)][string]$CertificatePath,
        [Parameter(Mandatory = $true)][string]$KeyTool
    )

    $PasswordEnvironmentName = 'WLB_POC_KEYTOOL_STORE_PASSWORD_' + [guid]::NewGuid().ToString('N')
    try {
        [Environment]::SetEnvironmentVariable(
            $PasswordEnvironmentName,
            $Signing.StorePassword,
            'Process'
        )
        Invoke-NativeCommand -Command $KeyTool -Arguments @(
            '-exportcert',
            '-storetype', 'PKCS12',
            '-keystore', $Signing.Path,
            '-alias', $Signing.Alias,
            '-storepass:env', $PasswordEnvironmentName,
            '-file', $CertificatePath
        )
    }
    finally {
        [Environment]::SetEnvironmentVariable($PasswordEnvironmentName, $null, 'Process')
    }
}

function Build-PocIntoStaging {
    param(
        [Parameter(Mandatory = $true)][int]$BuildNumber,
        [Parameter(Mandatory = $true)][pscustomobject]$Identity,
        [Parameter(Mandatory = $true)][string]$RunStagingRoot,
        [Parameter(Mandatory = $true)][string]$SourceCommit,
        [Parameter(Mandatory = $true)][string]$SourceTree,
        [Parameter(Mandatory = $true)][string]$ExpectedCertificateSha256,
        [Parameter(Mandatory = $true)][pscustomobject]$Signing,
        [Parameter(Mandatory = $true)][string]$Aapt,
        [Parameter(Mandatory = $true)][string]$ApkSigner
    )

    $PreviousBuildNumber = $env:WLB_POC_BUILD_NUMBER
    try {
        $env:WLB_POC_BUILD_NUMBER = [string]$BuildNumber
        Remove-Item `
            -LiteralPath $MutablePocOutput `
            -Recurse `
            -Force `
            -ErrorAction SilentlyContinue
        Invoke-WithSigningEnvironment -Signing $Signing -Action {
            Invoke-AndroidGradle -Arguments @('--no-daemon', ':app:assemblePoc')
        }
    }
    finally {
        $env:WLB_POC_BUILD_NUMBER = $PreviousBuildNumber
        Clear-SigningEnvironment
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
    $ApkName = 'northbridge-mobile-{0}.apk' -f $Identity.VersionName
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
        schemaVersion = 2
        applicationId = $Evidence.ApplicationId
        version = $Evidence.VersionName
        versionCode = $Evidence.VersionCode
        gitCommit = $SourceCommit
        gitTree = $SourceTree
        apk = $ApkName
        apkSha256 = $Evidence.ApkSha256
        certificateSha256 = $Evidence.CertificateSha256
        debuggable = $Evidence.Debuggable
        androidBuildToolsVersion = $PinnedBuildToolsVersion
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
        [Parameter(Mandatory = $true)][string[]]$StagedDirectories,
        [Parameter(Mandatory = $true)][string[]]$FinalDirectories,
        [Parameter(Mandatory = $true)][scriptblock]$Finalize,
        [ValidateSet('None', 'AfterFirstMove', 'AfterSecondMove')]
        [string]$InjectedFailurePoint = 'None'
    )

    if ($StagedDirectories.Count -ne 2 -or $FinalDirectories.Count -ne 2) {
        throw 'Artifact acceptance requires exactly two staged and two final directories.'
    }

    $AcceptedDirectories = @()
    $AcceptanceComplete = $false
    try {
        Move-Item -LiteralPath $StagedDirectories[0] -Destination $FinalDirectories[0]
        $AcceptedDirectories += $FinalDirectories[0]
        if ($InjectedFailurePoint -eq 'AfterFirstMove') {
            throw 'Injected rollback regression after first artifact move.'
        }

        Move-Item -LiteralPath $StagedDirectories[1] -Destination $FinalDirectories[1]
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

function Invoke-SafetySelfTests {
    $SelfTestRoot = Join-Path `
        $ArtifactsRoot `
        ('.safety-self-test-' + [guid]::NewGuid().ToString('N'))
    $OutsideFile = Join-Path `
        ([System.IO.Path]::GetTempPath()) `
        ('wlb-poc-outside-' + [guid]::NewGuid().ToString('N') + '.keystore')

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

            $FailureObserved = $false
            try {
                $FailurePoint = if ($Scenario -eq 'FinalizeFailure') { 'None' } else { $Scenario }
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

        $FirstLock = Enter-RunLock
        try {
            $SecondLockRejected = $false
            try {
                $SecondLock = Enter-RunLock
                Exit-RunLock -Stream $SecondLock
            }
            catch {
                $SecondLockRejected = $_.Exception.Message -like '*already running*'
            }
            if (-not $SecondLockRejected) {
                throw 'Exclusive-run-lock self-test did not reject a second holder.'
            }
        }
        finally {
            Exit-RunLock -Stream $FirstLock
        }

        $InsideDirectory = Join-Path $SelfTestRoot 'inside-repository'
        New-Item -ItemType Directory -Path $InsideDirectory -Force | Out-Null
        $InsideFile = Join-Path $InsideDirectory 'test.keystore'
        Set-Content -LiteralPath $InsideFile -Value 'test'
        $InsideRejected = $false
        try {
            Assert-KeystoreOutsideRepository -KeystorePath $InsideFile
        }
        catch {
            $InsideRejected = $_.Exception.Message -like '*must be outside the repository*'
        }
        if (-not $InsideRejected) {
            throw 'Repository-keystore-boundary self-test did not reject an internal file.'
        }

        Set-Content -LiteralPath $OutsideFile -Value 'test'
        Assert-KeystoreOutsideRepository -KeystorePath $OutsideFile

        [Environment]::SetEnvironmentVariable('WLB_POC_KEYSTORE_PATH', $OutsideFile, 'Process')
        [Environment]::SetEnvironmentVariable('WLB_POC_KEYSTORE_PASSWORD', 'synthetic-store', 'Process')
        [Environment]::SetEnvironmentVariable('WLB_POC_KEY_ALIAS', 'synthetic-alias', 'Process')
        [Environment]::SetEnvironmentVariable('WLB_POC_KEY_PASSWORD', 'synthetic-key', 'Process')
        $Snapshot = Get-SigningEnvironmentSnapshot
        Clear-SigningEnvironment
        foreach ($Name in $SigningEnvironmentNames) {
            if (-not [string]::IsNullOrEmpty(
                [Environment]::GetEnvironmentVariable($Name, 'Process')
            )) {
                throw ('Signing environment cleanup self-test failed: {0}' -f $Name)
            }
        }
        if ($env:OS -eq 'Windows_NT') {
            $ChildLeakCount = & powershell.exe -NoProfile -Command @'
$Names = @(
  'WLB_POC_KEYSTORE_PATH',
  'WLB_POC_KEYSTORE_PASSWORD',
  'WLB_POC_KEY_ALIAS',
  'WLB_POC_KEY_PASSWORD'
)
@($Names | Where-Object {
  -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, 'Process'))
}).Count
'@
            if ([int]$ChildLeakCount -ne 0) {
                throw 'Signing environment cleanup self-test leaked values to a child process.'
            }
        }
        $Snapshot.StorePassword = $null
        $Snapshot.KeyPassword = $null

        Write-Host '[POC_SIGNING_SAFETY_SELF_TEST] PASS'
    }
    finally {
        Clear-SigningEnvironment
        Remove-Item -LiteralPath $SelfTestRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $OutsideFile -Force -ErrorAction SilentlyContinue
    }
}

if ($RunSafetySelfTests) {
    Invoke-SafetySelfTests
    return
}

if ($SecondBuildNumber -le $FirstBuildNumber) {
    throw 'SecondBuildNumber must be greater than FirstBuildNumber.'
}
if ([string]::IsNullOrWhiteSpace($ExpectedCertificateSha256)) {
    throw 'ExpectedCertificateSha256 is required for every accepted POC signing smoke.'
}
$ExpectedCertificateSha256 = $ExpectedCertificateSha256.ToLowerInvariant()

if ($AllowSyntheticCiCertificate -and $env:GITHUB_ACTIONS -ne 'true') {
    throw 'AllowSyntheticCiCertificate is restricted to GitHub Actions.'
}

if ((Test-Path -LiteralPath $PublicIdentityPath -PathType Leaf) -and
    (-not $AllowSyntheticCiCertificate)) {
    $PublicIdentity = Get-Content -LiteralPath $PublicIdentityPath -Raw | ConvertFrom-Json
    if ($PublicIdentity.schemaVersion -ne 1 -or
        $PublicIdentity.applicationId -ne $ExpectedApplicationId -or
        $PublicIdentity.androidBuildToolsVersion -ne $PinnedBuildToolsVersion -or
        [string]$PublicIdentity.certificateSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'android-app\poc-signing-identity.json has an invalid schema.'
    }
    if (([string]$PublicIdentity.certificateSha256).ToLowerInvariant() -ne
        $ExpectedCertificateSha256) {
        throw 'ExpectedCertificateSha256 does not match the committed public POC signing identity.'
    }
}

if (-not (Test-Path -LiteralPath $Gradle -PathType Leaf)) {
    throw ('Gradle wrapper was not found: {0}' -f $Gradle)
}

$script:Git = Get-RequiredCommandPath @('git.exe', 'git')
$KeyTool = Get-RequiredCommandPath @('keytool.exe', 'keytool')
$RunLock = $null
$Signing = $null
$RunStagingRoot = $null
$CertificatePath = $null

try {
    $RunLock = Enter-RunLock
    $Signing = Get-SigningEnvironmentSnapshot
    Clear-SigningEnvironment

    $SdkRoot = if (-not [string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) {
        $env:ANDROID_HOME
    }
    else {
        Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    }
    $BuildToolsRoot = Join-Path $SdkRoot ('build-tools\{0}' -f $PinnedBuildToolsVersion)
    $Aapt = Join-Path $BuildToolsRoot 'aapt.exe'
    $ApkSigner = Join-Path $BuildToolsRoot 'apksigner.bat'
    if (-not (Test-Path -LiteralPath $Aapt -PathType Leaf) -or
        -not (Test-Path -LiteralPath $ApkSigner -PathType Leaf)) {
        throw ('Pinned Android build-tools {0} were not found under {1}.' -f `
            $PinnedBuildToolsVersion,
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
    $PocApplicationIds = @(
        @(
            $FirstIdentity.ApplicationId
            $SecondIdentity.ApplicationId
        ) | Sort-Object -Unique
    )
    if ($PocApplicationIds.Count -ne 1 -or
        $PocApplicationIds[0] -ne $ExpectedApplicationId) {
        throw 'Gradle POC applicationId does not match the pinned external identity.'
    }
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
        ('northbridge-mobile-signing-' + [guid]::NewGuid().ToString('N') + '.der')

    Export-SigningCertificate `
        -Signing $Signing `
        -CertificatePath $CertificatePath `
        -KeyTool $KeyTool
    $ActualCertificateSha256 = (
        Get-FileHash -LiteralPath $CertificatePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($ActualCertificateSha256 -ne $ExpectedCertificateSha256) {
        throw 'Configured POC keystore certificate does not match the pinned public signing identity.'
    }

    $FirstStaged = Build-PocIntoStaging `
        -BuildNumber $FirstBuildNumber `
        -Identity $FirstIdentity `
        -RunStagingRoot $RunStagingRoot `
        -SourceCommit $SourceCommit `
        -SourceTree $SourceTree `
        -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
        -Signing $Signing `
        -Aapt $Aapt `
        -ApkSigner $ApkSigner

    $SecondStaged = Build-PocIntoStaging `
        -BuildNumber $SecondBuildNumber `
        -Identity $SecondIdentity `
        -RunStagingRoot $RunStagingRoot `
        -SourceCommit $SourceCommit `
        -SourceTree $SourceTree `
        -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
        -Signing $Signing `
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
        Write-Host ('Signer: {0}' -f $ExpectedCertificateSha256)
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
    Clear-SigningEnvironment
    if ($null -ne $Signing) {
        $Signing.StorePassword = $null
        $Signing.KeyPassword = $null
    }
    if ($CertificatePath -and (Test-Path -LiteralPath $CertificatePath)) {
        Remove-Item -LiteralPath $CertificatePath -Force
    }
    if ($RunStagingRoot -and (Test-Path -LiteralPath $RunStagingRoot)) {
        Remove-Item -LiteralPath $RunStagingRoot -Recurse -Force
    }
    if ($null -ne $RunLock) {
        Exit-RunLock -Stream $RunLock
    }
}
