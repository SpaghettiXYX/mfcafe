@echo off
rem Flash build\storage.bin with esptool only (does not need an IDF shell).
rem Usage: flash_storage_esptool.bat COM5
setlocal
if "%~1"=="" (
  echo Usage: flash_storage_esptool.bat COMx
  exit /b 1
)
pushd "%~dp0.."
python -m esptool --chip esp32p4 -p %~1 -b 921600 write_flash 0x420000 build\storage.bin
popd
