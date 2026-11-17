[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$Python,
    [string]$OutputDirectory,
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$McaHome,
    [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if (-not $CompileOnly -and -not $ExtensionId) { throw 'ExtensionId is required unless -CompileOnly is used.' }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not $Python) { $Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe' }
$Python = (Resolve-Path -LiteralPath $Python).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ProjectRoot '.venv\native-host' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $McaHome) {
    if ($env:MCA_HOME) { $McaHome = $env:MCA_HOME }
    else { $McaHome = Join-Path $env:LOCALAPPDATA 'MultiChatAgent' }
}
$McaHome = [IO.Path]::GetFullPath($McaHome)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x C# compiler not found. Enable/install .NET Framework 4.x.' }
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
$executable = Join-Path $OutputDirectory 'mca-native-host.exe'
$source = Join-Path $PSScriptRoot 'native_host_launcher.cs'
$compilerOutput = & $compiler '/nologo' '/target:exe' '/optimize+' '/reference:System.Web.Extensions.dll' "/out:$executable" $source 2>&1
if ($LASTEXITCODE -ne 0) { throw "Native launcher compilation failed: $compilerOutput" }
if ($CompileOnly) {
    # Preserve an existing installation's config; bootstrap never changes its origin.
    [PSCustomObject]@{ Executable = $executable; Config = (Join-Path $OutputDirectory 'mca-native-host.json'); McaHome = $McaHome; CompileOnly = $true }
    return
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$config = [ordered]@{
    python = $Python
    project_root = $ProjectRoot
    mca_home = $McaHome
    allowed_origin = "chrome-extension://$ExtensionId/"
}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'mca-native-host.json'), ($config | ConvertTo-Json), $utf8)
[PSCustomObject]@{ Executable = $executable; Config = (Join-Path $OutputDirectory 'mca-native-host.json'); McaHome = $McaHome }
