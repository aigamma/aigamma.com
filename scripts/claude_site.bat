@echo off
cd /d C:\aigamma.com
timeout /t 1 /nobreak >nul
start "aigamma-claude" cmd /k "cd /d C:\aigamma.com && claude --dangerously-skip-permissions --model opus"
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$w = New-Object -ComObject wscript.shell; [void]$w.AppActivate('aigamma-claude'); Start-Sleep -Milliseconds 300; $w.SendKeys('/effort max~')"
exit
