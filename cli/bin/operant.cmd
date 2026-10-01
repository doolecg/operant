@echo off
rem Runs the operant CLI with the Operant app binary as Node (OPERANT_NODE), or plain node.
rem ELECTRON_RUN_AS_NODE is set only inside this script, never in the operator's shell.
setlocal
set "OPERANT_CJS=%~dp0operant.cjs"
if not exist "%OPERANT_CJS%" set "OPERANT_CJS=%~dp0..\..\out\cli\operant.cjs"
if not defined OPERANT_NODE goto plain
set ELECTRON_RUN_AS_NODE=1
"%OPERANT_NODE%" "%OPERANT_CJS%" %*
exit /b %ERRORLEVEL%
:plain
node "%OPERANT_CJS%" %*
exit /b %ERRORLEVEL%
