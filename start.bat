@echo off
REM Pond — open the app and start the server
cd /d "%~dp0"
start "" http://localhost:8787
node server.js
