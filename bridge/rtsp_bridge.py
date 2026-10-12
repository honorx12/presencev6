"""
Presence camera bridge: IP / RTSP / V380-style camera  ->  MJPEG stream the website can use.

Browsers cannot open rtsp:// directly. Run this on the PC that can see the camera:

    pip install opencv-python-headless
    python rtsp_bridge.py --url "rtsp://USER:PASS@192.168.1.50:554/live/ch00_0"

Then on the website: Camera dropdown -> "Network camera (stream URL)..." ->
    http://localhost:8090/stream      (press Connect)

--url also accepts a webcam index (0, 1, ...), a video file, or any http(s) MJPEG URL.
No OBS, no window capture: nothing to minimise.
"""
import argparse
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# RTSP over TCP (UDP drops packets on Wi-Fi -> grey/torn/frozen picture) + socket timeouts so a
# dead camera makes read() fail in ~5 s instead of hanging forever. MUST be set before cv2 loads.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|timeout;5000000|stimeout;5000000|fflags;nobuffer|max_delay;500000",
)

import cv2

latest = {"jpg": None, "t": 0.0, "err": "starting"}
lock = threading.Lock()
VIEW_GRACE = 3.0  # keep encoding this long after the last viewer asked for a frame
wanted = {"t": 0.0}  # last time a browser asked for a picture


def open_capture(source):
    """Open with explicit open/read timeouts for network sources."""
    if isinstance(source, str):
        try:
            return cv2.VideoCapture(
                source,
                cv2.CAP_FFMPEG,
                [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000],
            )
        except Exception:
            pass  # older OpenCV without the params overload
    return cv2.VideoCapture(source)


def capture_loop(src, width, quality, fps):
    source = int(src) if src.isdigit() else src
    delay = 1.0 / fps
    wait = 2
    while True:  # reconnect forever: camera reboot / Wi-Fi blip / app restart
        cap = open_capture(source)
        if not cap.isOpened():
            with lock:
                latest["err"] = "cannot open source - check URL / user / password / same network"
            print(f"[bridge] cannot open source, retry in {wait}s")
            cap.release()
            time.sleep(wait)
            wait = min(wait * 2, 15)
            continue
        print("[bridge] connected")
        wait = 2
        fails = 0
        last_ok = time.time()
        while fails < 30 and time.time() - last_ok < 15:
            ok, frame = cap.read()  # always read: keeps the camera buffer drained
            if not ok:
                fails += 1
                time.sleep(0.1)
                continue
            fails = 0
            last_ok = time.time()
            # No browser watching -> skip resize + JPEG encode (this is most of the CPU / heat).
            if time.time() - wanted["t"] > VIEW_GRACE:
                with lock:
                    latest["err"] = ""
                time.sleep(delay)
                continue
            if width and frame.shape[1] > width:
                h = int(frame.shape[0] * width / frame.shape[1])
                frame = cv2.resize(frame, (width, h))
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if ok:
                with lock:
                    latest.update(jpg=buf.tobytes(), t=time.time(), err="")
            time.sleep(delay)
        cap.release()
        with lock:
            latest["err"] = "lost source, reconnecting"
        print("[bridge] lost source, reconnecting")
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/stream"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            last = 0.0
            try:
                while True:
                    wanted["t"] = time.time()
                    with lock:
                        jpg, t = latest["jpg"], latest["t"]
                    if jpg is None or t == last:
                        time.sleep(0.02)
                        continue
                    last = t
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpg))
                    self.wfile.write(jpg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
        elif self.path.startswith("/snapshot"):
            wanted["t"] = time.time()
            t0 = time.time()
            while time.time() - t0 < 1.5:  # wait for a fresh frame if the encoder was idle
                with lock:
                    if latest["t"] >= t0:
                        break
                time.sleep(0.05)
            with lock:
                jpg = latest["jpg"]
            if jpg is None:
                self.send_response(503)
                self._cors()
                self.end_headers()
                return
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "image/jpeg")
            self.end_headers()
            self.wfile.write(jpg)
        else:
            body = f'Presence bridge OK. Use /stream. status: {latest["err"] or "streaming"}'.encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="rtsp://..., http MJPEG url, video file, or webcam index")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--width", type=int, default=640, help="downscale to this width (0 = keep)")
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--fps", type=int, default=15)
    a = ap.parse_args()
    threading.Thread(target=capture_loop, args=(a.url, a.width, a.quality, a.fps), daemon=True).start()
    print(f"[bridge] stream at http://localhost:{a.port}/stream  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
