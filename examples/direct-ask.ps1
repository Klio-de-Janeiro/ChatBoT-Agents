# Run from any directory. Requires bootstrap, registered host and connected extension.
[CmdletBinding()]
param(
    [string]$Provider = 'qwen',
    [string]$Prompt = 'Объясни смысл транзакции SQLite на коротком примере.',
    [ValidateSet('on', 'off')][string]$Think,
    [ValidateSet('on', 'off')][string]$Search,
    [string[]]$Mode,
    [ValidateSet('txt', 'md', 'ipynb', 'json', 'html')][string]$Format,
    [string]$Output,
    [string]$ProjectRoot
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$python = Join-Path (Resolve-Path -LiteralPath $ProjectRoot).Path '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run scripts/bootstrap.ps1 first.' }
# Only the structured summary/path is printed, never the answer body.
$cliArguments = @('-m', 'multi_chat_agent', 'ask', $Provider, '--prompt', $Prompt, '--wait')
# Omitted settings are absent from argv, preserving the website's current state.
if ($PSBoundParameters.ContainsKey('Think')) { $cliArguments += @('--think', $Think.ToLowerInvariant()) }
if ($PSBoundParameters.ContainsKey('Search')) { $cliArguments += @('--search', $Search.ToLowerInvariant()) }
foreach ($setting in $Mode) { $cliArguments += @('--mode', $setting) }
if ($PSBoundParameters.ContainsKey('Format')) { $cliArguments += @('--format', $Format) }
if ($PSBoundParameters.ContainsKey('Output')) { $cliArguments += @('--output', $Output) }
& $python @cliArguments
if ($LASTEXITCODE -ne 0) { throw "MCA ask exited with code $LASTEXITCODE. See the JSON diagnostic above." }
