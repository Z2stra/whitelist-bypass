[CmdletBinding()]
param(
    [ValidateRange(1, 998)]
    [int]$FirstBuildNumber = 1,

    [ValidateRange(2, 999)]
    [int]$SecondBuildNumber = 2,

    [string]$KeystorePath = 'D:\wlb-secrets\wlb-poc.keystore',

    [string]$KeyAlias = 'wlb-poc',

    # First persistent-key run only. Creates a public identity file after the
    # signing smoke succeeds. That file must be reviewed and committed before
    # a source-free live bundle is accepted.
    [switch]$InitializeSigningIdentity,

    # CI regression path for the pre-prompt phase. It never reads a signing key
    # or prompts for passwords.
    [switch]$RunQualityGateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PinnedBuildToolsVersion = '36.0.0'
$ScriptRoot = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptRoot '..')).Path
$AndroidRoot = Join-Path $RepoRoot 'android-app'
$Gradle = Join-Path $AndroidRoot 'gradlew.bat'
$LowLevelHelper = Join-Path $ScriptRoot 'preserve-poc-signing-smoke.ps1'
$IdentityPath = Join-Path $AndroidRoot 'poc-signing-identity.json'
$ArtifactsRoot = Join-Path $RepoRoot 'local-artifacts\poc-signing-smoke'
$SigningEnvironmentNames = @(
    'WLB_POC_KEYSTORE_PATH',
    'WLB_POC_KEYSTORE_PASSWORD',
    'WLB_POC_KEY_ALIAS',
    'WLB_POC_KEY_PASSWORD'
)

function Get-RequiredCommandPath {
    param([Parameter(Mandatory = $true)][string[]]$Names)

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
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$CaptureOutput
    )

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

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $Separator = [System.IO.Path]::DirectorySeparatorChar
    $Alternate = [System.IO.Path]::AltDirectorySeparatorChar
    return ([System.IO.Path]::GetFullPath($Resolved).Replace($Alternate, $Separator)).TrimEnd($Separator)
}

function Test-PathWithinDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$CandidatePath,
        [Parameter(Mandatory = $true)][string]$DirectoryPath
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

function Clear-SigningEnvironment {
    foreach ($Name in $SigningEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
}

function Convert-SecureStringToPlainText {
    param(
        [Parameter(Mandatory = $true)]
        [System.Security.SecureString]$SecureValue,

        [Parameter(Mandatory = $true)]
        [ref]$Bstr
    )

    $Bstr.Value = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr.Value)
}

function Write-Utf8NoBomJson {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $Json = $Value | ConvertTo-Json -Depth 5
    $Utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText(
        $Path,
        $Json + [Environment]::NewLine,
        $Utf8NoBom
    )
}

function Get-GitValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    return (
        Invoke-NativeCommand `
            -Command $script:Git `
            -Arguments (@('-C', $RepoRoot) + $Arguments) `
            -CaptureOutput |
            Select-Object -First 1
    ).Trim()
}

function Get-SourceStatus {
    return @(
        Invoke-NativeCommand `
            -Command $script:Git `
            -Arguments @('-C', $RepoRoot, 'status', '--porcelain=v1', '--untracked-files=all') `
            -CaptureOutput
    )
}

function Assert-Provenance {
    param(
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$Tree,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    if ((Get-GitValue @('rev-parse', 'HEAD')) -ne $Commit -or
        (Get-GitValue @('rev-parse', 'HEAD^{tree}')) -ne $Tree) {
        throw ("Git provenance changed during operator signing smoke at stage '{0}'." -f $Stage)
    }
    $Status = @(Get-SourceStatus)
    if ($Status.Count -ne 0) {
        throw ("Source tree is not clean at stage '{0}':`n{1}" -f `
            $Stage,
            ($Status -join [Environment]::NewLine))
    }
}

function Invoke-AndroidQualityGate {
    Clear-SigningEnvironment
    $InitialStatus = @(Get-SourceStatus)
    if ($InitialStatus.Count -ne 0) {
        throw ("Tracked/non-ignored-untracked source tree must be clean before Android quality checks:`n{0}" -f `
            ($InitialStatus -join [Environment]::NewLine))
    }

    $Commit = Get-GitValue @('rev-parse', 'HEAD')
    $Tree = Get-GitValue @('rev-parse', 'HEAD^{tree}')

    Push-Location $AndroidRoot
    try {
        Invoke-NativeCommand -Command $Gradle -Arguments @('--no-daemon', 'test')
        Invoke-NativeCommand -Command $Gradle -Arguments @('--no-daemon', 'lint')
        Invoke-NativeCommand -Command $Gradle -Arguments @('--no-daemon', 'assembleDebug')
    }
    finally {
        Pop-Location
        Clear-SigningEnvironment
    }

    Assert-Provenance -Commit $Commit -Tree $Tree -Stage 'after Android quality gate'
    return [pscustomobject]@{
        Commit = $Commit
        Tree = $Tree
    }
}

function Get-AcceptedDirectories {
    param(
        [Parameter(Mandatory = $true)][object[]]$HelperOutput,
        [Parameter(Mandatory = $true)][int]$FirstNumber,
        [Parameter(Mandatory = $true)][int]$SecondNumber
    )

    $Directories = @()
    foreach ($Line in $HelperOutput) {
        $Match = [regex]::Match($Line.ToString(), '^(?:First|Second):\s+(.+)$')
        if ($Match.Success) {
            $Directories += $Match.Groups[1].Value.Trim()
        }
    }
    if ($Directories.Count -ne 2 -and
        (Test-Path -LiteralPath $ArtifactsRoot -PathType Container)) {
        $Directories = @(
            Get-ChildItem -LiteralPath $ArtifactsRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -match ('-poc\.({0}|{1})$' -f $FirstNumber, $SecondNumber)
                } |
                Select-Object -ExpandProperty FullName
        )
    }
    return @($Directories)
}

function Assert-AcceptedProvenance {
    param(
        [Parameter(Mandatory = $true)][string[]]$Directories,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit,
        [Parameter(Mandatory = $true)][string]$ExpectedTree,
        [Parameter(Mandatory = $true)][string]$ExpectedCertificateSha256
    )

    if ($Directories.Count -ne 2) {
        throw 'Could not identify both accepted artifact directories.'
    }
    foreach ($Directory in $Directories) {
        $ManifestPath = Join-Path $Directory 'BUILD-MANIFEST.json'
        if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
            throw ('Accepted artifact manifest is missing: {0}' -f $ManifestPath)
        }
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        if ($Manifest.schemaVersion -ne 2 -or
            $Manifest.gitCommit -ne $ExpectedCommit -or
            $Manifest.gitTree -ne $ExpectedTree -or
            $Manifest.androidBuildToolsVersion -ne $PinnedBuildToolsVersion -or
            ([string]$Manifest.certificateSha256).ToLowerInvariant() -ne $ExpectedCertificateSha256) {
            throw ('Accepted artifact provenance does not match the pre-prompt quality gate: {0}' -f $ManifestPath)
        }
    }
}

$script:Git = Get-RequiredCommandPath @('git.exe', 'git')
if (-not (Test-Path -LiteralPath $Gradle -PathType Leaf)) {
    throw ('Gradle wrapper was not found: {0}' -f $Gradle)
}

if ($RunQualityGateOnly) {
    $Quality = Invoke-AndroidQualityGate
    Write-Host '[POC_SIGNING_OPERATOR_QUALITY] PASS'
    Write-Host ('Commit: {0}' -f $Quality.Commit)
    Write-Host ('Tree:   {0}' -f $Quality.Tree)
    return
}

if ($SecondBuildNumber -le $FirstBuildNumber) {
    throw 'SecondBuildNumber must be greater than FirstBuildNumber.'
}
if (-not (Test-Path -LiteralPath $LowLevelHelper -PathType Leaf)) {
    throw ('Low-level signing helper was not found: {0}' -f $LowLevelHelper)
}

if (-not [System.IO.Path]::IsPathRooted($KeystorePath)) {
    $KeystorePath = Join-Path $RepoRoot $KeystorePath
}
$KeystorePath = (Resolve-Path -LiteralPath $KeystorePath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $KeystorePath -PathType Leaf)) {
    throw ('POC keystore does not exist: {0}' -f $KeystorePath)
}
if (Test-PathWithinDirectory -CandidatePath $KeystorePath -DirectoryPath $RepoRoot) {
    throw 'POC signing keystore must be outside the repository, including ignored directories such as secrets and local-artifacts.'
}

if ((Test-Path -LiteralPath $IdentityPath -PathType Leaf) -and $InitializeSigningIdentity) {
    throw 'Signing identity is already initialized. Omit -InitializeSigningIdentity.'
}
if ((-not (Test-Path -LiteralPath $IdentityPath -PathType Leaf)) -and
    (-not $InitializeSigningIdentity)) {
    throw (
        'Public POC signing identity is not initialized. For the first persistent-key ' +
        'smoke, rerun with -InitializeSigningIdentity. Review and commit the generated ' +
        'android-app\poc-signing-identity.json before any live bundle is accepted.'
    )
}

# The complete Android quality gate is intentionally completed before any
# signing password is requested or materialized in process memory.
$Quality = Invoke-AndroidQualityGate

$StorePasswordSecure = Read-Host 'POC keystore password' -AsSecureString
$KeyPasswordSecure = Read-Host 'POC key password' -AsSecureString
$StorePasswordBstr = [IntPtr]::Zero
$KeyPasswordBstr = [IntPtr]::Zero
$StorePasswordPlain = $null
$KeyPasswordPlain = $null
$CertificatePath = Join-Path `
    $env:TEMP `
    ('wlb-poc-identity-' + [guid]::NewGuid().ToString('N') + '.der')
$PasswordEnvironmentName = 'WLB_POC_PROMPT_STORE_PASSWORD_' + [guid]::NewGuid().ToString('N')
$AcceptedDirectories = @()
$WrapperComplete = $false
$IdentityWasCreated = $false

try {
    $StorePasswordPlain = Convert-SecureStringToPlainText `
        -SecureValue $StorePasswordSecure `
        -Bstr ([ref]$StorePasswordBstr)
    $KeyPasswordPlain = Convert-SecureStringToPlainText `
        -SecureValue $KeyPasswordSecure `
        -Bstr ([ref]$KeyPasswordBstr)

    [Environment]::SetEnvironmentVariable(
        $PasswordEnvironmentName,
        $StorePasswordPlain,
        'Process'
    )
    $KeyTool = Get-RequiredCommandPath @('keytool.exe', 'keytool')
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $KeyToolOutput = @(& $KeyTool `
            -exportcert `
            -storetype PKCS12 `
            -keystore $KeystorePath `
            -alias $KeyAlias `
            -storepass:env $PasswordEnvironmentName `
            -file $CertificatePath 2>&1)
        $KeyToolExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($KeyToolExitCode -ne 0) {
        $KeyToolOutput | ForEach-Object { Write-Host $_ }
        throw 'Could not export the public certificate from the configured POC keystore.'
    }

    $ObservedCertificateSha256 = (
        Get-FileHash -LiteralPath $CertificatePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()

    if (Test-Path -LiteralPath $IdentityPath -PathType Leaf) {
        $Identity = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
        if ($Identity.schemaVersion -ne 1 -or
            $Identity.applicationId -ne 'bypass.whitelist' -or
            $Identity.androidBuildToolsVersion -ne $PinnedBuildToolsVersion -or
            [string]$Identity.certificateSha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw 'android-app\poc-signing-identity.json has an invalid schema.'
        }
        $ExpectedCertificateSha256 = ([string]$Identity.certificateSha256).ToLowerInvariant()
        if ($ObservedCertificateSha256 -ne $ExpectedCertificateSha256) {
            throw 'Configured POC keystore does not match the committed public signing identity.'
        }
    }
    else {
        $ExpectedCertificateSha256 = $ObservedCertificateSha256
    }

    Assert-Provenance `
        -Commit $Quality.Commit `
        -Tree $Quality.Tree `
        -Stage 'immediately before signed POC packaging'

    [Environment]::SetEnvironmentVariable('WLB_POC_KEYSTORE_PATH', $KeystorePath, 'Process')
    [Environment]::SetEnvironmentVariable('WLB_POC_KEYSTORE_PASSWORD', $StorePasswordPlain, 'Process')
    [Environment]::SetEnvironmentVariable('WLB_POC_KEY_ALIAS', $KeyAlias, 'Process')
    [Environment]::SetEnvironmentVariable('WLB_POC_KEY_PASSWORD', $KeyPasswordPlain, 'Process')

    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $HelperOutput = @(& powershell.exe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $LowLevelHelper `
            -FirstBuildNumber $FirstBuildNumber `
            -SecondBuildNumber $SecondBuildNumber `
            -ExpectedCertificateSha256 $ExpectedCertificateSha256 `
            -SkipQualityChecks 2>&1)
        $HelperExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    $HelperOutput | ForEach-Object { Write-Host $_ }
    if ($HelperExitCode -ne 0) {
        throw 'Low-level POC signing smoke failed.'
    }

    $AcceptedDirectories = Get-AcceptedDirectories `
        -HelperOutput $HelperOutput `
        -FirstNumber $FirstBuildNumber `
        -SecondNumber $SecondBuildNumber
    Assert-AcceptedProvenance `
        -Directories $AcceptedDirectories `
        -ExpectedCommit $Quality.Commit `
        -ExpectedTree $Quality.Tree `
        -ExpectedCertificateSha256 $ExpectedCertificateSha256

    if ($InitializeSigningIdentity) {
        $Identity = [ordered]@{
            schemaVersion = 1
            applicationId = 'bypass.whitelist'
            certificateSha256 = $ExpectedCertificateSha256
            androidBuildToolsVersion = $PinnedBuildToolsVersion
            initializedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-Utf8NoBomJson -Value $Identity -Path $IdentityPath
        $IdentityWasCreated = $true
    }

    $WrapperComplete = $true
    Write-Host '[POC_SIGNING_OPERATOR_WRAPPER] PASS'
    if ($IdentityWasCreated) {
        Write-Host ('Created public signing identity: {0}' -f $IdentityPath)
        Write-Host 'Review and commit that public file in a dedicated follow-up PR before building a live bundle.'
    }
}
finally {
    if (-not $WrapperComplete) {
        foreach ($Directory in $AcceptedDirectories) {
            Remove-Item `
                -LiteralPath $Directory `
                -Recurse `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }
    Clear-SigningEnvironment
    [Environment]::SetEnvironmentVariable($PasswordEnvironmentName, $null, 'Process')
    if (Test-Path -LiteralPath $CertificatePath) {
        Remove-Item -LiteralPath $CertificatePath -Force -ErrorAction SilentlyContinue
    }
    if ($StorePasswordBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($StorePasswordBstr)
    }
    if ($KeyPasswordBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($KeyPasswordBstr)
    }
    $StorePasswordPlain = $null
    $KeyPasswordPlain = $null
    $StorePasswordSecure = $null
    $KeyPasswordSecure = $null
}
