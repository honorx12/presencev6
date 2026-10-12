import json, sys, threading, time, types, urllib.request, urllib.error, base64, hashlib, re, importlib
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import ptz_helper as P

fails = 0
def chk(label, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + label)
    fails += 0 if ok else 1

def http(port, method, path, body=None, origin=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**({"Origin": origin} if origin else {}), **({"Content-Type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read() or b"{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)

def serve(backend, port):
    P.App.backend = backend
    P.App.origins = {"http://localhost:5173"}
    srv = P.ThreadingHTTPServer(("127.0.0.1", port), P.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

# ---------- 1. mock backend + HTTP rules ----------
moves = []
class Rec(P.MockBackend):
    def move(self, d, ms): moves.append((d, ms))
serve(Rec(), 18765)
o = "http://localhost:5173"
s, j, h = http(18765, "GET", "/status", origin=o)
chk("status 200 + ready", s == 200 and j["ready"] and j["backend"] == "mock")
chk("CORS header echoes allowed origin", h.get("Access-Control-Allow-Origin") == o)
chk("Private-Network header present", h.get("Access-Control-Allow-Private-Network") == "true")
s, j, h = http(18765, "POST", "/move", {"dir": "left", "ms": 350}, origin=o)
chk("move left ok", s == 200 and moves[-1] == ("left", 350))
s, j, _ = http(18765, "POST", "/move", {"dir": "left", "ms": 99999}, origin=o)
chk("ms clamped to 1500", moves[-1] == ("left", 1500))
s, j, _ = http(18765, "POST", "/move", {"dir": "left", "ms": 1}, origin=o)
chk("ms clamped to 80", moves[-1] == ("left", 80))
s, j, _ = http(18765, "POST", "/move", {"dir": "diagonal"}, origin=o)
chk("bad dir -> 400", s == 400 and "error" in j)
s, j, _ = http(18765, "POST", "/move", {"dir": "up", "ms": "abc"}, origin=o)
chk("bad ms -> 400", s == 400)
n = len(moves)
s, j, h = http(18765, "POST", "/move", {"dir": "up", "ms": 300}, origin="https://evil.example")
chk("foreign website origin -> 403 and NO move", s == 403 and len(moves) == n and "Access-Control-Allow-Origin" not in h)
s, j, h = http(18765, "OPTIONS", "/move", origin=o)
chk("preflight 204 w/ methods", s == 204 and "POST" in h.get("Access-Control-Allow-Methods", ""))
s, j, _ = http(18765, "OPTIONS", "/move", origin="https://evil.example")
chk("preflight from foreign origin -> 403", s == 403)
s, j, _ = http(18765, "GET", "/nope", origin=o)
chk("unknown path 404", s == 404)

# ---------- 2. ONVIF against a fake camera ----------
seen = {"digest_ok": False, "ops": [], "vel": None}
class Cam(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        xml = self.rfile.read(int(self.headers["Content-Length"])).decode()
        # verify WS-Security digest with password "secret"
        nonce = base64.b64decode(re.search(r"<Nonce>([^<]+)</Nonce>", xml).group(1))
        created = re.search(r"<Created[^>]*>([^<]+)</Created>", xml).group(1)
        dig = re.search(r"PasswordDigest\">([^<]+)</Password>", xml).group(1)
        want = base64.b64encode(hashlib.sha1(nonce + created.encode() + b"secret").digest()).decode()
        seen["digest_ok"] = (dig == want)
        if "GetCapabilities" in xml:
            seen["ops"].append("caps"); body = '<c><PTZ><XAddr>http://127.0.0.1:18899/onvif/ptz</XAddr></PTZ><Media><XAddr>http://127.0.0.1:18899/onvif/media</XAddr></Media></c>'
        elif "GetProfiles" in xml:
            seen["ops"].append("profiles"); body = '<trt:Profiles token="Profile_1" fixed="true"><Name>m</Name></trt:Profiles>'
        elif "ContinuousMove" in xml:
            seen["ops"].append("move"); m = re.search(r'PanTilt[^>]*x="([^"]+)" y="([^"]+)"', xml); seen["vel"] = (float(m.group(1)), float(m.group(2))); seen["tok"] = re.search(r"<ProfileToken>([^<]+)", xml).group(1); body = "<ok/>"
        elif "<Stop" in xml:
            seen["ops"].append("stop"); body = "<ok/>"
        else: body = "<x/>"
        out = f"<Envelope><Body>{body}</Body></Envelope>".encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
cam = HTTPServer(("127.0.0.1", 18899), Cam); threading.Thread(target=cam.serve_forever, daemon=True).start()
ob = P.OnvifBackend("127.0.0.1", 18899, "admin", "secret", speed=0.5)
serve(ob, 18766)
s, j, _ = http(18766, "GET", "/status", origin=o)
chk("onvif status ready, profile found", j["ready"] and "Profile_1" in j["detail"])
chk("WS-Security digest valid", seen["digest_ok"])
for d, exp in [("left", (-0.5, 0)), ("right", (0.5, 0)), ("up", (0, 0.5)), ("down", (0, -0.5))]:
    seen["ops"].clear(); seen["vel"] = None
    s, j, _ = http(18766, "POST", "/move", {"dir": d, "ms": 100}, origin=o)
    chk(f"onvif {d}: velocity {seen['vel']} then stop", s == 200 and seen["vel"] == exp and seen["ops"][-2:] == ["move", "stop"] and seen["tok"] == "Profile_1")
bad = P.OnvifBackend("127.0.0.1", 1, "a", "b")   # nothing listening
serve(bad, 18767)
s, j, _ = http(18767, "POST", "/move", {"dir": "left"}, origin=o)
chk("camera unreachable -> 503 with message", s == 503 and "onvif" in j["error"])

# ---------- 3. UI backend with a fake mouse ----------
log = []
fake = types.ModuleType("pyautogui")
Pos = type("Pos", (), {"__init__": lambda s, x, y: (setattr(s, "x", x), setattr(s, "y", y)) and None})
state = {"p": (500, 400)}
fake.position = lambda: Pos(*state["p"])
fake.moveTo = lambda x, y: (log.append(("move", x, y)), state.__setitem__("p", (x, y)))
fake.mouseDown = lambda: log.append(("down",))
fake.mouseUp = lambda: log.append(("up",))
sys.modules["pyautogui"] = fake
import os, tempfile
P.CAL_FILE = os.path.join(tempfile.mkdtemp(), "cal.json")
ub = P.UiBackend()
ok, why = ub.ready()
chk("ui backend: uncalibrated reports how to fix", (not ok) and "calibrate" in why)
inputs = iter([""] * 4); pts = iter([(100, 200), (110, 300), (50, 250), (170, 250)])
fake.position = lambda: Pos(*next(pts)) if "cal" in state else Pos(*state["p"])
state["cal"] = 1
P.input = lambda prompt="": next(inputs)
import builtins; builtins.input = P.input
P.calibrate()
del state["cal"]; fake.position = lambda: Pos(*state["p"])
cal = json.load(open(P.CAL_FILE))
chk("calibration saved 4 arrows", cal == {"up": [100, 200], "down": [110, 300], "left": [50, 250], "right": [170, 250]})
ub = P.UiBackend(); log.clear(); state["p"] = (500, 400)
serve(ub, 18768)
t0 = time.time(); s, j, _ = http(18768, "POST", "/move", {"dir": "right", "ms": 200}, origin=o); dt = time.time() - t0
chk("ui move: goto arrow, press, hold ~200ms, release, restore cursor",
    s == 200 and log == [("move", 170, 250), ("down",), ("up",), ("move", 500, 400)] and 0.19 < dt < 0.6)

print("\nALL PASS" if not fails else f"\n{fails} FAILED"); sys.exit(1 if fails else 0)
