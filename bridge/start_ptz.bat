@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  py -3.12 -m venv .venv || py -3.11 -m venv .venv || py -m venv .venv || python -m venv .venv
  call .venv\Scripts\activate
  pip install pyautogui
) else (
  call .venv\Scripts\activate
)
echo.
echo  1 = first time: calibrate V380 joystick arrows
echo  2 = run helper (V380 joystick mode)
echo  3 = run helper (ONVIF camera)
echo  4 = run helper (test mode, no camera)
set /p CH=Choose 1-4: 
if "%CH%"=="1" goto :cal
if "%CH%"=="2" goto :ui
if "%CH%"=="3" goto :onvif
if "%CH%"=="4" goto :mock
goto :end

:cal
python ptz_helper.py --calibrate
goto :end

:ui
set "V380="
set /p V380=Full path to V380.exe to auto-restart it when it closes (Enter = skip): 
if defined V380 goto :ui_watch
python ptz_helper.py --backend ui
goto :end
:ui_watch
python ptz_helper.py --backend ui --v380 "%V380%"
goto :end

:onvif
set /p IP=Camera IP: 
set /p PW=Camera password: 
python ptz_helper.py --backend onvif --host %IP% --password %PW%
goto :end

:mock
python ptz_helper.py --backend mock

:end
pause
