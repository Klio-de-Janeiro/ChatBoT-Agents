# Open an owned provider conversation without sending a prompt or generating a document.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Provider,
    [ValidateSet('on', 'off')][string]$Think,
    [ValidateSet('on', 'off')][string]$Search,
    [string[]]$Mode,
    [string]$ProjectRoot
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$python = Join-Path (Resolve-Path -LiteralPath $ProjectRoot).Path '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run scripts/bootstrap.ps1 first.' }
$cliArguments = @('-m', 'multi_chat_agent', 'open', $Provider, '--wait')
# Omitted settings are absent from argv, preserving the website's current state.
if ($PSBoundParameters.ContainsKey('Think')) { $cliArguments += @('--think', $Think.ToLowerInvariant()) }
if ($PSBoundParameters.ContainsKey('Search')) { $cliArguments += @('--search', $Search.ToLowerInvariant()) }
foreach ($setting in $Mode) { $cliArguments += @('--mode', $setting) }
# Only status and conversation_url metadata are returned. No demo message is used.
& $python @cliArguments
if ($LASTEXITCODE -ne 0) { throw "MCA open exited with code $LASTEXITCODE. See the JSON diagnostic above." }
