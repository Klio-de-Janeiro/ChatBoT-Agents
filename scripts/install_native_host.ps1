[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$ProjectRoot,
    [string]$Python,
    [string]$NativeHostDirectory,
    [string]$McaHome,
    [switch]$PrepareOnly,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not $NativeHostDirectory) { $NativeHostDirectory = Join-Path $ProjectRoot '.venv\native-host' }
$NativeHostDirectory = [IO.Path]::GetFullPath($NativeHostDirectory)
$manifestPath = Join-Path $NativeHostDirectory 'com.multichat.agent.json'
$keyPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.multichat.agent'
if (-not $PrepareOnly -and (Test-Path -LiteralPath $keyPath)) {
    $existing = (Get-Item -LiteralPath $keyPath).GetValue('')
    if ($existing -ne $manifestPath -and -not $Force) {
        throw "Host already points to '$existing'. Use -Force only to replace that registration."
    }
}
$target = if ($PrepareOnly) { $NativeHostDirectory } else { $keyPath }
if (-not $PSCmdlet.ShouldProcess($target, 'Build MCA native executable and write host manifest/registration')) { return }
$buildArguments = @{ ProjectRoot = $ProjectRoot; ExtensionId = $ExtensionId; OutputDirectory = $NativeHostDirectory }
if ($Python) { $buildArguments.Python = $Python }
if ($McaHome) { $buildArguments.McaHome = $McaHome }
$build = & (Join-Path $PSScriptRoot 'build_native_host.ps1') @buildArguments
$manifest = [ordered]@{
    name = 'com.multichat.agent'
    description = 'Multi-Chat Agent local bridge'
    path = $build.Executable
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
if (-not $PrepareOnly) {
    $null = New-Item -Path $keyPath -Force
    Set-Item -LiteralPath $keyPath -Value $manifestPath
}
[PSCustomObject]@{
    Registered = (-not $PrepareOnly)
    Manifest = $manifestPath
    Executable = $build.Executable
    ExtensionId = $ExtensionId
    McaHome = $build.McaHome
    RegistryKey = $keyPath
}
