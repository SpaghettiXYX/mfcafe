@echo off
rem Flash the USB-extend-screen firmware onto the ESP32-P4 board.
rem Usage: flash.bat COM5      (COM port = the board's USB port in Device Manager)
setlocal
set PORT=%~1
if "%PORT%"=="" (
  echo Usage: flash.bat COMx
  pause
  exit /b 1
)
python -m esptool --chip esp32p4 -p %PORT% -b 460800 ^
  write_flash 0x2000 firmware\bootloader.bin ^
              0x8000 firmware\partition-table.bin ^
              0x20000 firmware\lakala.bin
pause
