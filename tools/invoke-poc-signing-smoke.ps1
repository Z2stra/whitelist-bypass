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
    [switch]$InitializeSigningIdentity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PinnedBuildToolsVersion = '36.0.0'
$ScriptRoot = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptRoot '..')).Path
$AndroidRoot = Join-Path $RepoRoot 'android-app'
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

# Clear stale values before prompting so the operator wrapper has one explicit
# signing source and never restores old secrets after completion.
Clear-SigningEnvironment

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
            -ExpectedCertificateSha256 $ExpectedCertificateSha256 2>&1)
        $HelperExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    $HelperOutput | ForEach-Object { Write-Host $_ }
    if ($HelperExitCode -ne 0) {
        throw 'Low-level POC signing smoke failed.'
    }

    if ($InitializeSigningIdentity) {
        $AcceptedDirectories = @()
        foreach ($Line in $HelperOutput) {
            $Match = [regex]::Match($Line.ToString(), '^(?:First|Second):\s+(.+)$')
            if ($Match.Success) {
                $AcceptedDirectories += $Match.Groups[1].Value.Trim()
            }
        }
        if ($AcceptedDirectories.Count -ne 2 -and
            (Test-Path -LiteralPath $ArtifactsRoot -PathType Container)) {
            $AcceptedDirectories = @(
                Get-ChildItem -LiteralPath $ArtifactsRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.Name -match ('-poc\.({0}|{1})$' -f $FirstBuildNumber, $SecondBuildNumber)
                    } |
                    Select-Object -ExpandProperty FullName
            )
        }
        if ($AcceptedDirectories.Count -ne 2) {
            foreach ($Directory in $AcceptedDirectories) {
                Remove-Item -LiteralPath $Directory -Recurse -Force -ErrorAction SilentlyContinue
            }
            throw 'Could not identify both accepted artifact directories for identity initialization.'
        }

        try {
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
        catch {
            foreach ($Directory in $AcceptedDirectories) {
                Remove-Item `
                    -LiteralPath $Directory `
                    -Recurse `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
            throw
        }
    }

    Write-Host '[POC_SIGNING_OPERATOR_WRAPPER] PASS'
    if ($IdentityWasCreated) {
        Write-Host ('Created public signing identity: {0}' -f $IdentityPath)
        Write-Host 'Review and commit that public file in a dedicated follow-up PR before building a live bundle.'
    }
}
finally {
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
