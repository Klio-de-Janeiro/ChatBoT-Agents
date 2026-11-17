# Forward arguments without reconstructing a shell command or requiring venv activation.
$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw 'Python environment is missing. Run .\scripts\bootstrap.ps1 first.'
}
& $python -m multi_chat_agent @args
exit $LASTEXITCODE
