[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$Python = 'python',
    [switch]$SkipTests,
    [switch]$InstallSkill
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
Push-Location -LiteralPath $ProjectRoot
try {
    & $Python -c "import sys; assert sys.version_info >= (3, 11), 'Python >=3.11 required'"
    if ($LASTEXITCODE -ne 0) { throw 'Python >=3.11 is required.' }
    $venvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $Python -m venv (Join-Path $ProjectRoot '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'venv creation failed.' }
    }
    & $venvPython -m pip install -e '.[dev]'
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
    $launcher = & (Join-Path $PSScriptRoot 'build_native_host.ps1') -ProjectRoot $ProjectRoot -Python $venvPython -CompileOnly
    Push-Location -LiteralPath (Join-Path $ProjectRoot 'extension')
    try {
        # npm.cmd also works with Windows PowerShell execution policies that block npm.ps1.
        if (Test-Path -LiteralPath 'package-lock.json') { & npm.cmd ci }
        else { & npm.cmd install }
        if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Extension build failed.' }
        if (-not $SkipTests) {
            & npm.cmd test
            if ($LASTEXITCODE -ne 0) { throw 'Extension tests failed.' }
        }
    } finally { Pop-Location }
    if (-not $SkipTests) {
        & $venvPython -m pytest
        if ($LASTEXITCODE -ne 0) { throw 'Python tests failed.' }
        & (Join-Path $PSScriptRoot 'test_installation.ps1') -ProjectRoot $ProjectRoot
    }
    if ($InstallSkill) { & (Join-Path $PSScriptRoot 'install_skill.ps1') -ProjectRoot $ProjectRoot }
    [PSCustomObject]@{ ProjectRoot = $ProjectRoot; Python = $venvPython; NativeExecutable = $launcher.Executable; ExtensionDirectory = (Join-Path $ProjectRoot 'extension\dist'); TestsSkipped = [bool]$SkipTests; NativeHostRegistrationChanged = $false }
} finally { Pop-Location }
