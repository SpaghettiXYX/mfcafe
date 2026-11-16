@echo off
rem Re-flash only the poster filesystem (no app rebuild needed).
rem Usage: update_posters.bat COM5
setlocal
if "%~1"=="" (
  echo Usage: update_posters.bat COMx
  exit /b 1
)
pushd "%~dp0.."
call idf.py -p %~1 storage-flash
if errorlevel 1 goto :fail
popd
echo Posters updated.
exit /b 0
:fail
popd
exit /b 1
