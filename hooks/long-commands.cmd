@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
if "%OPERANT_EXE%"=="" (
  node "%~dp0long-commands.js" %*
) else (
  "%OPERANT_EXE%" "%~dp0long-commands.js" %*
)
exit /b %ERRORLEVEL%
