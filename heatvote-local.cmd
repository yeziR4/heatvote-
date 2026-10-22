@echo off
cd /d %~dp0
echo Starting HeatVote local campaign (fleet + refill + scheduler)...
node src\boot.js
pause
