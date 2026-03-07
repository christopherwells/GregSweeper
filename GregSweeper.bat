@echo off
title GregSweeper
cd /d "%~dp0"
echo Starting GregSweeper on http://localhost:8080 ...
echo (Keep this window open while playing)
echo.
start "" http://localhost:8080
python -m http.server 8080
pause
