@echo off
cd /d "%~dp0"
title Second Brain (keep open for reminders)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
start "" http://localhost:4321
node server.js
pause
