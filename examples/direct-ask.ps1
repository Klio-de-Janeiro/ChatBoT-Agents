# Run from any directory. Requires bootstrap, registered host and connected extension.
[CmdletBinding()]
param(
    [ValidateSet('deepseek', 'qwen')][string]$Provider = 'qwen',
    [string]$Prompt = 'Объясни смысл транзакции SQLite на коротком примере.',
    [string]$ProjectRoot
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$python = Join-Path (Resolve-Path -LiteralPath $ProjectRoot).Path '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run scripts/bootstrap.ps1 first.' }
# Only the structured summary/path is printed, never the answer body.
& $python -m multi_chat_agent ask $Provider --prompt $Prompt --wait
if ($LASTEXITCODE -ne 0) { throw "MCA ask exited with code $LASTEXITCODE. See the JSON diagnostic above." }
