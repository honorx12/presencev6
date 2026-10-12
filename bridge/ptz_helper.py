"""
Presence PTZ helper: lets the website move the camera (pan / tilt).

Runs on the PC that has the camera, listens on 127.0.0.1 ONLY. The site (even when it is
hosted on Vercel) calls http://127.0.0.1:8765/move when your hand gesture says "left", "up", ...

TWO ways to move the camera
  --backend onvif   Camera speaks ONVIF (clean, no app needed).
                    python ptz_helper.py --backend onvif --host 192.168.1.50 --port 8899 --user admin --password 123456
  --backend ui      Presses the joystick arrows INSIDE the V380 PC app with the mouse.
                    1) python ptz_helper.py --calibrate     (once; you hover each arrow, press Enter)
                    2) python ptz_helper.py --backend ui
                    The V380 window must be visible on screen (not minimised, not covered
                    by the browser). Put V380 and the browser side by side.
  --backend mock    Prints what it would do. For testing the site without a camera.

Optional: --v380 "C:\\path\\to\\V380.exe" restarts the V380 app if it closes by itself.

Needs:  pip install pyautogui     (only for --backend ui / --calibrate)
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CAL_FILE = os.path.join(HERE, "ptz_calibration.json")
DIRS = ("up", "down", "left", "right")
MIN_MS, MAX_MS = 80, 1500


# ------------------------------------------------------------------ backends
class MockBackend:
    name = "mock"

    def ready(self):
        return True, "mock backend (no real camera)"

    def move(self, d, ms):
        print(f"[ptz] MOVE {d} {ms}ms")

    def stop(self):
        print("[ptz] STOP")


class UiBackend:
    """Mouse press-and-hold on the V380 joystick arrows, at calibrated screen positions."""

    name = "ui"

    def __init__(self):
        import pyautogui  # lazy: needs a display

        pyautogui.FAILSAFE = False  # we restore the cursor ourselves
        pyautogui.PAUSE = 0
        self.pg = pyautogui
        self.lock = threading.Lock()
        self.cal = self._load()

    @staticmethod
    def _load():
        try:
            with open(CAL_FILE) as f:
                data = json.load(f)
            return {d: tuple(data[d]) for d in DIRS}
        except Exception:
            return None

    def ready(self):
        if not self.cal:
            return False, "not calibrated: run  python ptz_helper.py --calibrate"
        return True, "ui backend, calibrated"

    def move(self, d, ms):
        if not self.cal:
            raise RuntimeError("not calibrated")
        x, y = self.cal[d]
        with self.lock:  # one press at a time
            pg = self.pg
            back = pg.position()
            try:
                pg.moveTo(x, y)
                pg.mouseDown()
                time.sleep(ms / 1000)
            finally:
                pg.mouseUp()
                pg.moveTo(back.x, back.y)

    def stop(self):
        try:
            self.pg.mouseUp()
        except Exception:
            pass


def calibrate():
    import pyautogui

    print("Calibration. In the V380 app click the joystick / PTZ icon so the arrow pad is visible.")
    print("For each arrow: move the mouse onto it, then press Enter here (do not click).\n")
    out = {}
    for d in DIRS:
        input(f"  hover the {d.upper()} arrow, then press Enter ... ")
        p = pyautogui.position()
        out[d] = [p.x, p.y]
        print(f"    saved {d}: {p.x},{p.y}")
    with open(CAL_FILE, "w") as f:
        json.dump(out, f)
    print(f"\nSaved to {CAL_FILE}. Do NOT move/resize the V380 window afterwards (re-calibrate if you do).")


class OnvifBackend:
    """Minimal ONVIF PTZ client: GetCapabilities/GetProfiles + ContinuousMove/Stop (WS-Security digest)."""

    name = "onvif"
    NS_PTZ = "http://www.onvif.org/ver20/ptz/wsdl"
    NS_MEDIA = "http://www.onvif.org/ver10/media/wsdl"
    NS_DEV = "http://www.onvif.org/ver10/device/wsdl"
    NS_SCH = "http://www.onvif.org/ver10/schema"

    def __init__(self, host, port, user, password, speed=0.5):
        self.base = f"http://{host}:{port}"
        self.user, self.password, self.speed = user, password, speed
        self.ptz_url = self.media_url = None
        self.token = None
        self.err = None
        self.lock = threading.Lock()

    def _envelope(self, body):
        nonce = os.urandom(16)
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digest = base64.b64encode(
            hashlib.sha1(nonce + created.encode() + self.password.encode()).digest()
        ).decode()
        sec = (
            '<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
            "<UsernameToken>"
            f"<Username>{self.user}</Username>"
            '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
            f"{digest}</Password>"
            f"<Nonce>{base64.b64encode(nonce).decode()}</Nonce>"
            '<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
            f"{created}</Created></UsernameToken></Security>"
        )
        return (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
            f"<s:Header>{sec}</s:Header><s:Body>{body}</s:Body></s:Envelope>"
        )

    def _post(self, url, body):
        req = urllib.request.Request(
            url,
            self._envelope(body).encode(),
            {"Content-Type": 'application/soap+xml; charset=utf-8'},
        )
        with urllib.request.urlopen(req, timeout=4) as r:
            return r.read().decode("utf-8", "replace")

    def connect(self):
        dev = f"{self.base}/onvif/device_service"
        try:
            xml = self._post(dev, f'<GetCapabilities xmlns="{self.NS_DEV}"><Category>All</Category></GetCapabilities>')
            m = re.search(r"<[^>]*PTZ[^>]*>\s*<[^>]*XAddr[^>]*>([^<]+)<", xml)
            n = re.search(r"<[^>]*Media[^>]*>\s*<[^>]*XAddr[^>]*>([^<]+)<", xml)
            self.ptz_url = m.group(1).strip() if m else f"{self.base}/onvif/ptz_service"
            self.media_url = n.group(1).strip() if n else f"{self.base}/onvif/media_service"
        except Exception:
            self.ptz_url = f"{self.base}/onvif/ptz_service"
            self.media_url = f"{self.base}/onvif/media_service"
        xml = self._post(self.media_url, f'<GetProfiles xmlns="{self.NS_MEDIA}"/>')
        t = re.search(r'Profiles[^>]*\btoken="([^"]+)"', xml)
        if not t:
            raise RuntimeError("camera returned no ONVIF profile (wrong user/password?)")
        self.token = t.group(1)

    def ready(self):
        if self.token:
            return True, f"onvif, profile {self.token}"
        try:
            self.connect()
            return True, f"onvif, profile {self.token}"
        except Exception as exc:
            self.err = str(exc)
            return False, f"onvif not reachable: {exc}"

    def _vel(self, x, y):
        return (
            f'<ContinuousMove xmlns="{self.NS_PTZ}"><ProfileToken>{self.token}</ProfileToken>'
            f'<Velocity><PanTilt xmlns="{self.NS_SCH}" x="{x}" y="{y}"/></Velocity></ContinuousMove>'
        )

    def move(self, d, ms):
        ok, why = self.ready()
        if not ok:
            raise RuntimeError(why)
        s = self.speed
        x, y = {"left": (-s, 0), "right": (s, 0), "up": (0, s), "down": (0, -s)}[d]
        with self.lock:
            self._post(self.ptz_url, self._vel(x, y))
            time.sleep(ms / 1000)
            self.stop()

    def stop(self):
        if not self.token:
            return
        try:
            self._post(
                self.ptz_url,
                f'<Stop xmlns="{self.NS_PTZ}"><ProfileToken>{self.token}</ProfileToken>'
                "<PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>",
            )
        except Exception:
            pass


# ------------------------------------------------------------------ V380 watchdog
def v380_running(exe_name):
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/NH"], capture_output=True, text=True, timeout=8
        ).stdout
        return exe_name.lower() in out.lower()
    except Exception:
        return True  # can't tell -> don't spam restarts


def watchdog(path, every=10):
    name = os.path.basename(path)
    print(f"[watchdog] keeping {name} alive")
    while True:
        time.sleep(every)
        if not v380_running(name):
            print(f"[watchdog] {name} is not running -> starting it")
            try:
                subprocess.Popen([path], cwd=os.path.dirname(path) or None)
                time.sleep(20)  # give it time to open before checking again
            except Exception as exc:
                print(f"[watchdog] cannot start: {exc}")


# ------------------------------------------------------------------ HTTP API
#   GET  /status  -> {ok, backend, ready, detail, last_move}
#   POST /move    {"dir": "left|right|up|down", "ms": 80..1500} -> {ok:true}
#   POST /stop    -> {ok:true}
# Errors: {"error": "..."} with 4xx/5xx.  CORS only for allowed origins.
_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


def origin_allowed(o):
    """Any localhost / 127.0.0.1 port is fine (Vite jumps to 5174 when 5173 is busy and the
    helper used to answer 403 'origin not allowed'); other sites need --origin."""
    return bool(o) and (o in App.origins or _LOCAL_ORIGIN.match(o) is not None)


class App:
    backend = None
    origins = set()
    last_move = None
    last_at = 0.0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _origin_ok(self):
        o = self.headers.get("Origin")
        return o is None or origin_allowed(o)

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        o = self.headers.get("Origin")
        if o and origin_allowed(o):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed (use --origin)"})
        self.send_response(204)
        o = self.headers.get("Origin")
        if o:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed (use --origin)"})
        if self.path.split("?")[0] == "/status":
            ready, detail = App.backend.ready()
            return self._send(
                200,
                {"ok": True, "backend": App.backend.name, "ready": ready, "detail": detail, "last_move": App.last_move},
            )
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed (use --origin)"})
        path = self.path.split("?")[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid JSON"})
        if path == "/stop":
            App.backend.stop()
            return self._send(200, {"ok": True})
        if path == "/move":
            d = data.get("dir")
            if d not in DIRS:
                return self._send(400, {"error": f"dir must be one of {list(DIRS)}"})
            try:
                ms = int(data.get("ms", 350))
            except (TypeError, ValueError):
                return self._send(400, {"error": "ms must be a number"})
            ms = max(MIN_MS, min(MAX_MS, ms))
            ready, detail = App.backend.ready()
            if not ready:
                return self._send(503, {"error": detail})
            try:
                App.backend.move(d, ms)
            except Exception as exc:
                return self._send(502, {"error": f"move failed: {exc}"})
            App.last_move = {"dir": d, "ms": ms, "at": time.time()}
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser(description="Presence PTZ helper")
    ap.add_argument("--backend", choices=["ui", "onvif", "mock"], default="ui")
    ap.add_argument("--calibrate", action="store_true", help="record the V380 joystick arrow positions")
    ap.add_argument("--listen", type=int, default=8765, help="port this helper listens on (127.0.0.1)")
    ap.add_argument("--origin", action="append", default=[], help="extra allowed website origin, e.g. https://presence.vercel.app")
    ap.add_argument("--host", help="ONVIF camera IP")
    ap.add_argument("--port", type=int, default=8899, help="ONVIF port (try 8899, 80, 5000, 8000)")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="")
    ap.add_argument("--speed", type=float, default=0.5, help="ONVIF speed 0.1..1")
    ap.add_argument("--v380", help="full path to V380.exe; restart it when it closes by itself")
    a = ap.parse_args()

    if a.calibrate:
        return calibrate()

    if a.backend == "ui":
        try:
            App.backend = UiBackend()
        except Exception as exc:
            sys.exit(f"Cannot use ui backend: {exc}\n  -> pip install pyautogui")
    elif a.backend == "onvif":
        if not a.host:
            sys.exit("--host <camera ip> is required for onvif")
        App.backend = OnvifBackend(a.host, a.port, a.user, a.password, a.speed)
    else:
        App.backend = MockBackend()

    App.origins = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", *a.origin}
    ok, detail = App.backend.ready()
    print(f"[ptz] backend={App.backend.name} ready={ok} ({detail})")
    if a.v380:
        threading.Thread(target=watchdog, args=(a.v380,), daemon=True).start()
    print(f"[ptz] listening on http://127.0.0.1:{a.listen}   allowed sites: {sorted(App.origins)}")
    ThreadingHTTPServer(("127.0.0.1", a.listen), Handler).serve_forever()


if __name__ == "__main__":
    main()
