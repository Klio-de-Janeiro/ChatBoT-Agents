@echo off
setlocal DisableDelayedExpansion
set "MCA_LAUNCH_PYTHON=%~dp0..\.venv\Scripts\python.exe"
if not exist "%MCA_LAUNCH_PYTHON%" (
    echo [MultiChatAgent] Python environment is missing.
    echo Run scripts\bootstrap.ps1 from the project folder first.
    pause
    exit /b 2
)
"%MCA_LAUNCH_PYTHON%" -m multi_chat_agent open perplexity --wait %*
set "MCA_LAUNCH_EXIT=%ERRORLEVEL%"
if not "%MCA_LAUNCH_EXIT%"=="0" (
    echo.
    echo [MultiChatAgent] Opening Perplexity did not complete. CLI exit code: %MCA_LAUNCH_EXIT%
    echo See the JSON diagnostic above. Check Chrome, the extension and native host.
    echo If a task is pending, timed out or unknown, check its status before retrying.
    pause
)
exit /b %MCA_LAUNCH_EXIT%
