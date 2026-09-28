@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
if "%OPERANT_EXE%"=="" (
  node "%~dp0operant-cli.js" %*
) else (
  "%OPERANT_EXE%" "%~dp0operant-cli.js" %*
)
exit /b %ERRORLEVEL%
