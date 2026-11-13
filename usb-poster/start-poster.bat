@echo off
rem Launch the poster player on the USB panel (second display).
rem Put this folder next to poster.html and the assets folder, then double-click.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-poster.ps1" %*
if errorlevel 1 pause
