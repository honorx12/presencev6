@echo off
cd /d "%~dp0"

if not exist frontend\node_modules call :install

netstat -ano | findstr ":8000 " | findstr LISTENING >nul
if errorlevel 1 start "backend" cmd /k call "%~dp0start_backend.bat"

netstat -ano | findstr ":5173 " | findstr LISTENING >nul
if errorlevel 1 start "frontend" cmd /k "cd /d frontend && npm run dev"

echo Waiting for backend...
set n=0
:wait
curl -s -o nul http://127.0.0.1:8000/health
if not errorlevel 1 goto ready
set /a n+=1
if %n% geq 90 goto ready
timeout /t 1 /nobreak >nul
goto wait

:ready
start http://localhost:5173
exit /b

:install
cd frontend
call npm install
cd ..
exit /b