@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  py -3.12 -m venv .venv || py -3.11 -m venv .venv || py -m venv .venv || python -m venv .venv
  call .venv\Scripts\activate
  pip install opencv-python-headless
) else (
  call .venv\Scripts\activate
)
set /p CAM_URL=Camera URL (rtsp://user:pass@ip:554/... or 0 for webcam): 
python rtsp_bridge.py --url "%CAM_URL%" --fps 12
pause
