@echo off
rem Build and flash app + poster filesystem.
rem Usage: build_and_flash.bat COM5
setlocal
if "%~1"=="" (
  echo Usage: build_and_flash.bat COMx
  exit /b 1
)
pushd "%~dp0.."
if not exist sdkconfig (
  call idf.py set-target esp32p4
  if errorlevel 1 goto :fail
)
call idf.py -p %~1 build flash
if errorlevel 1 goto :fail
popd
echo.
echo Done. Open the serial log with:  idf.py -p %~1 monitor
exit /b 0
:fail
popd
exit /b 1
