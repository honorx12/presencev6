@echo off
rem Backend only. Double-click. No Activate.ps1, no Set-ExecutionPolicy needed:
rem it calls the venv's python directly.
cd /d "%~dp0backend"

if not exist ".env" (
  echo ERROR: backend\.env is missing. Copy .env.example to .env and fill the Supabase keys.
  goto :fail
)

rem Pick a Python. dlib-bin ships Windows wheels for 3.11 - 3.14; 3.12 is the safest, newer also works.
set "PYV="
for %%V in (3.12 3.11 3.13 3.14) do (
  if not defined PYV (
    py -%%V -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PYV=%%V"
  )
)
if not defined PYV (
  echo ERROR: no usable Python found ^(need 3.11 to 3.14^). Install Python from python.org ^(tick "Add python.exe to PATH"^), then run this again.
  goto :fail
)

rem A venv whose Python was uninstalled / moved cannot run at all -> only then delete and rebuild it.
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys" >nul 2>nul
  if errorlevel 1 (
    echo Old environment is broken ^(its Python is gone^), rebuilding it ...
    rmdir /s /q .venv
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo First run: creating Python %PYV% environment, takes a few minutes...
  py -%PYV% -m venv .venv
  if errorlevel 1 goto :fail
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :fail
  ".venv\Scripts\python.exe" -m pip install --no-deps face_recognition
  if errorlevel 1 goto :fail
)

rem Packages missing (interrupted install)? Repair in place. Never deletes a working environment.
".venv\Scripts\python.exe" -c "import face_recognition, fastapi, supabase, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo Some packages are missing, installing them ...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :fail
  ".venv\Scripts\python.exe" -m pip install --no-deps face_recognition
  if errorlevel 1 goto :fail
)

".venv\Scripts\python.exe" -m uvicorn api:app --reload --port 8000
pause
exit /b

:fail
echo.
echo Setup failed. Read the message above.
pause
exit /b 1
