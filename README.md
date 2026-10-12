# Presence — face-recognition attendance

```
frontend/  React + Vite   -> deploy on Vercel   (Root Directory = frontend)
backend/   FastAPI + dlib -> deploy on Railway  (Root Directory = backend, uses Dockerfile)
bridge/    optional: RTSP / V380 IP cam -> MJPEG for the website (runs on the PC that sees the camera)
```
Why split: Vercel can't run dlib/face_recognition (too big, no native build). Frontend there, backend in Docker elsewhere.

## Run locally (Windows)
1. `backend/.env` from `backend/.env.example`; `frontend/.env` from `frontend/.env.example` (leave `VITE_API_URL` empty).
2. `.\start.bat`

## Deploy

### 0. Supabase (once)
SQL Editor -> run `backend/supabase_schema.sql`. Each staff user needs a row in `profiles`
(`insert into profiles (id, role) values ('<auth-user-uuid>', 'developer');`).

### 1. Backend -> Railway
- New Project -> Deploy from GitHub repo.
- Service **Settings -> Root Directory = `/backend`** (the failed build was missing this: Railway scanned the repo root and found no app).
- Builder uses the `Dockerfile` (pinned in `backend/railway.json`).
- **Variables**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`; optional `SMTP_*`; optional `ALLOWED_ORIGINS=https://<your-app>.vercel.app`.
- Settings -> Networking -> **Generate Domain**. `https://<domain>/health` must return `{"status":"ok",...}`.
- Alternative host: Render -> New -> Blueprint (uses `render.yaml`).

### 2. Frontend -> Vercel
- Import repo. **Root Directory = `frontend`**, preset = Vite (not "Services").
- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL=https://<railway-domain>` (no trailing `/`, no `/api`).
- `frontend/vercel.json` handles reload on routes like `/verify` and camera permission.

### 3. Supabase auth URL
Authentication -> URL Configuration -> Site URL = your Vercel URL.

## Cameras
Verify and Enroll have a **Camera** dropdown listing every camera the OS exposes: built-in webcam, USB, OBS Virtual Camera. Choice is remembered per browser. Status pill shows live / black / frozen / reconnecting and says why.

**Why OBS goes black when V380 is minimised:** OBS *Window Capture* can't capture a minimised window, so OBS Virtual Camera outputs black/frozen. Fixes, best first:
1. **No OBS:** run `bridge/start_bridge.bat` with the camera RTSP URL, then pick *Network camera* -> `http://localhost:8090/stream`.
2. OBS: use a **Media Source / VLC Source** with the RTSP URL instead of Window Capture.
3. OBS Window Capture: keep the V380 window open (behind other windows is fine, minimised is not).

V380 note: the V380 Pro app uses its own cloud protocol. RTSP works only if your camera model/firmware exposes RTSP/ONVIF (enable in the app's camera settings; commonly `rtsp://<ip>:554/live/ch00_0`). If not, use option 3.

## Other-laptop checklist
- Open the **https** URL (camera API needs https or localhost; `http://192.168.x.x` gets no camera).
- Allow camera when asked; close other apps/tabs holding the camera.
- First request after idle on a free host can take seconds; site shows a retry message instead of crashing.

## Gesture camera control (Verify page -> "Gesture camera control")
Runs in the browser (MediaPipe hands). Moves the camera through a small local helper.

| You do | Result |
|---|---|
| Hold a 🤘 rock sign (or ✊ fist, pick in the panel) beside your face ~1 s | Locks onto THAT face. Only that face stays boxed (blue). Other people's hands are ignored. |
| Open hand clearly to the left / right of your face | Camera pans that way (one nudge every ~0.45 s) |
| One finger pointing ☝ up / 👇 down | Camera tilts up / down |
| Rock sign again, 30 s idle, or leave the picture | Unlocks |

Camera moves toward where your hand appears in the picture. Reversed (camera mounted upside-down)? tick "invert" in the panel.

### Start the helper (on the PC with the camera)
`bridge\start_ptz.bat`, then choose:
1. **Calibrate** (once, V380 app): click V380's joystick icon so the arrow pad shows, hover each arrow, press Enter.
2. **V380 joystick mode**: clicks the arrows for you. V380 window must be visible (side by side with the browser, not minimised, not covered).
3. **ONVIF**: if the camera supports ONVIF (try ports 8899, 80, 5000). No app needed.
4. **Test mode**: prints moves, no camera.

Site on Vercel (https)? start the helper with `--origin https://<your-app>.vercel.app`. The helper only accepts listed sites and only listens on 127.0.0.1.

### Keep V380 from staying closed
`python ptz_helper.py --backend ui --v380 "C:\full\path\V380.exe"` restarts the app if it exits. Find the path: Task Manager -> V380 -> right click -> Open file location.

### Tests
`cd frontend && npm run test:gesture` (22 checks) and `python bridge/test_ptz_helper.py` (25 checks).

## Troubleshooting (quick)
- **Backend window closes / "Python not found"**: `start_backend.bat` picks Python 3.12, 3.11, 3.13 or 3.14 automatically. A venv whose Python was uninstalled is rebuilt; a working venv is never deleted.
- **New photo in Supabase does not show**: open `http://127.0.0.1:8000/health` -> `sync`:
  `ok:false` = no internet/DNS to Supabase, `failed` = those photos could not be downloaded (retried every 45 s),
  `undetected` = no face found in that photo, `remote_photos` lower than expected = unsupported format (use jpg/png/webp/bmp).
- **Roster** refreshes itself every 30 s and has a Refresh button; replaced photos are cache-busted.
- **PTZ helper** accepts any `http://localhost:<port>` site (Vite may use 5174 when 5173 is busy). Other sites need `--origin`.
- **Network camera (bridge)** reconnects by itself when the bridge or camera restarts (takes up to ~15 s to notice).
- `.env.example` files hold placeholders only. Real keys go in `backend/.env` and `frontend/.env` (never committed).
