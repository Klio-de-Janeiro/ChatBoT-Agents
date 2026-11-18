[CmdletBinding()]
param([string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run bootstrap or create .venv first.' }
$parseErrors = @()
$files = @(Get-Item -LiteralPath (Join-Path $ProjectRoot 'mca.ps1')) + @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'scripts') -Filter '*.ps1') + @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'examples') -Filter '*.ps1')
foreach ($file in $files) {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    $parseErrors += $errors
}
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
& $python (Join-Path $PSScriptRoot 'validate_examples.py') (Join-Path $ProjectRoot 'examples')
if ($LASTEXITCODE -ne 0) { throw 'Example plan validation failed.' }
& $python (Join-Path $PSScriptRoot 'test_provider_launchers.py') $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Provider launcher validation failed.' }
$testParent = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot '.venv')).Path
$testRoot = Join-Path $testParent ('installation-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$keyPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.multichat.agent'
$hadKey = Test-Path -LiteralPath $keyPath
$previousValue = if ($hadKey) { (Get-Item -LiteralPath $keyPath).GetValue('') } else { $null }
try {
    # The mock module runs only inside this test directory, never replacing project code.
    $mockCode = @'
import struct
import sys

assert sys.argv[1:] == ["native-host"], sys.argv
def read_exact(count):
    value = b""
    while len(value) < count:
        block = sys.stdin.buffer.read(count - len(value))
        if not block:
            return value
        value += block
    return value
while True:
    prefix = read_exact(4)
    if not prefix:
        break
    assert len(prefix) == 4
    body = read_exact(struct.unpack("<I", prefix)[0])
    sys.stdout.buffer.write(prefix + body)
    sys.stdout.buffer.flush()
sys.stderr.write("MOCK_STDERR_ONLY\n")
'@
    [IO.File]::WriteAllText((Join-Path $testRoot 'multi_chat_agent.py'), $mockCode, $utf8)
    $nativeDirectory = Join-Path $testRoot 'native host with spaces'
    $prepared = & (Join-Path $PSScriptRoot 'install_native_host.ps1') -ProjectRoot $testRoot -Python $python -NativeHostDirectory $nativeDirectory -McaHome (Join-Path $testRoot 'data') -ExtensionId ('a' * 32) -PrepareOnly
    $manifestBytes = [IO.File]::ReadAllBytes($prepared.Manifest)
    if ($manifestBytes[0] -ne 123) { throw 'Manifest must start with {, without BOM.' }
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    if ($manifest.allowed_origins.Count -ne 1 -or $manifest.allowed_origins[0] -ne ('chrome-extension://' + ('a' * 32) + '/')) { throw 'Origin mismatch.' }
    if ($manifest.path -ne $prepared.Executable -or [IO.Path]::GetExtension($manifest.path) -ne '.exe') { throw 'Manifest must target executable.' }
    & $python (Join-Path $PSScriptRoot 'test_native_launcher.py') $prepared.Executable $manifest.allowed_origins[0]
    if ($LASTEXITCODE -ne 0) { throw 'Native launcher smoke test failed.' }
    $hasKey = Test-Path -LiteralPath $keyPath
    $currentValue = if ($hasKey) { (Get-Item -LiteralPath $keyPath).GetValue('') } else { $null }
    if ($hadKey -ne $hasKey -or $previousValue -ne $currentValue) { throw 'PrepareOnly changed registry.' }
    $rejected = $false
    try { & (Join-Path $PSScriptRoot 'install_native_host.ps1') -ExtensionId 'invalid' -PrepareOnly | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid extension ID was accepted.' }
    $skillDirectory = Join-Path $testRoot 'skills\use-chat-bots'
    & (Join-Path $PSScriptRoot 'install_skill.ps1') -ProjectRoot $ProjectRoot -SkillDirectory $skillDirectory | Out-Null
    & (Join-Path $PSScriptRoot 'install_skill.ps1') -ProjectRoot $ProjectRoot -SkillDirectory $skillDirectory | Out-Null
    $installed = Get-Content -Raw -LiteralPath (Join-Path $skillDirectory 'references\installation.md')
    if (-not $installed.Contains($python)) { throw 'Installed skill is missing absolute venv interpreter.' }
    $unrelated = Join-Path $testRoot 'unrelated-skill'
    $null = New-Item -ItemType Directory -Path $unrelated
    [IO.File]::WriteAllText((Join-Path $unrelated 'SKILL.md'), 'KEEP_UNRELATED', $utf8)
    $rejected = $false
    try { & (Join-Path $PSScriptRoot 'install_skill.ps1') -ProjectRoot $ProjectRoot -SkillDirectory $unrelated | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or (Get-Content -Raw -LiteralPath (Join-Path $unrelated 'SKILL.md')) -ne 'KEEP_UNRELATED') { throw 'Unrelated skill was overwritten.' }
    [PSCustomObject]@{ PowerShellParse = 'passed'; ProviderLaunchers = 'passed'; BinaryLauncher = 'passed'; Manifest = 'passed'; RegistryUnchanged = $true; SkillInstall = 'passed'; UnrelatedSkillProtected = $true; LiveProvidersTested = $false }
} finally {
    # Check the resolved absolute target before deleting only our isolated test tree.
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    $allowedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
    if (-not $resolvedTest.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolvedTest)).StartsWith('installation-test-')) { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolvedTest) { Remove-Item -LiteralPath $resolvedTest -Recurse -Force }
}
