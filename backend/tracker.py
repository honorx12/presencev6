"""Server-side multi-face tracker.

Each /track call sends one frame. We detect faces, keep a Track per face across
frames (so the box follows the person), identify each track, watch its eye
aspect ratio for a blink (anti-photo), and fire on_verified(name) once when a
known face has blinked.
"""

import threading
import time
from collections import deque

import face_recognition

from liveness import face_ear

MAX_MISSING = 1.0      # drop a track unseen this long (s)
REID_EVERY = 3.0       # re-check identity of a known track (s)
RETRY_UNKNOWN = 1.2    # retry identity of an unknown track (s)
BLINK_RATIO = 0.78     # eye "closed" when EAR < ratio * recent open EAR
MIN_OPEN_EAR = 0.2     # ignore baseline below this (eyes half shut / bad landmarks)


def _iou(a, b):
    t, r, bo, l = max(a[0], b[0]), min(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3])
    inter = max(0, r - l) * max(0, bo - t)
    area = lambda x: max(0, x[1] - x[3]) * max(0, x[2] - x[0])
    union = area(a) + area(b) - inter
    return inter / union if union else 0.0


def _score(a, b):
    """Higher = more likely same face. IoU plus a centre-distance fallback for fast movement."""
    iou = _iou(a, b)
    ca = ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2)
    cb = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
    size = max(a[2] - a[0], a[1] - a[3], 1)
    dist = ((ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2) ** 0.5
    return iou + max(0.0, 1 - dist / (1.5 * size)) * 0.1


class Track:
    _next = 1

    def __init__(self, box, now):
        self.id = Track._next
        Track._next += 1
        self.box = box
        self.last_seen = now
        self.name = None       # None = not tried yet, "Unknown", or a roster name
        self.last_id = 0.0
        self.ears = deque(maxlen=12)
        self.closed = False
        self.blinked = False
        self.verified = False
        self.announced = False

    def reset_verify(self):
        self.ears.clear()
        self.closed = self.blinked = self.verified = False


class FaceTracker:
    def __init__(self, model, on_verified):
        self.model = model
        self.on_verified = on_verified  # name -> "in" | "out" | "skip"
        self.sessions = {}
        self.lock = threading.Lock()

    def _update_blink(self, t, img, loc):
        lms = face_recognition.face_landmarks(img, [loc])
        if not lms:
            return
        ear = face_ear(lms[0])
        t.ears.append(ear)
        base = max(t.ears)
        if len(t.ears) < 3 or base < MIN_OPEN_EAR:
            return
        if ear < BLINK_RATIO * base:
            t.closed = True
        elif t.closed and ear >= 0.9 * base:
            t.blinked = True
            t.closed = False

    def _identify(self, t, img, loc, now):
        enc = face_recognition.face_encodings(img, [loc])
        t.last_id = now
        if not enc:
            return
        name, _ = self.model.match(enc[0])
        name = name or "Unknown"
        if t.name not in (None, name):
            t.reset_verify()  # identity changed: earlier blink no longer counts
        t.name = name

    def process(self, sid, img):
        now = time.time()
        h, w = img.shape[:2]
        with self.lock:
            tracks = self.sessions.setdefault(sid, [])
            locs = face_recognition.face_locations(img)

            pairs = sorted(
                ((_score(t.box, l), ti, li) for ti, t in enumerate(tracks) for li, l in enumerate(locs)),
                reverse=True,
            )
            t_used, l_used, seen = set(), set(), []
            for sc, ti, li in pairs:
                if sc < 0.05:
                    break
                if ti in t_used or li in l_used:
                    continue
                t_used.add(ti)
                l_used.add(li)
                tracks[ti].box = locs[li]
                tracks[ti].last_seen = now
                seen.append(tracks[ti])
            for li, l in enumerate(locs):
                if li not in l_used:
                    t = Track(l, now)
                    tracks.append(t)
                    seen.append(t)
            tracks[:] = [t for t in tracks if now - t.last_seen < MAX_MISSING]

            events, faces = [], []
            for t in seen:
                loc = t.box
                self._update_blink(t, img, loc)
                known = t.name not in (None, "Unknown")
                if (
                    t.name is None
                    or (t.name == "Unknown" and now - t.last_id > RETRY_UNKNOWN)
                    or (known and now - t.last_id > REID_EVERY)
                ):
                    self._identify(t, img, loc, now)
                    known = t.name not in (None, "Unknown")

                if known and t.blinked and not t.verified:
                    t.verified = True
                    events.append({"id": t.id, "name": t.name, "kind": self.on_verified(t.name)})
                if t.name == "Unknown" and not t.announced:
                    t.announced = True
                    events.append({"id": t.id, "name": "Unknown", "kind": "unknown"})

                status = "verified" if t.verified else "matched" if known else "unknown" if t.name else "detecting"
                faces.append(
                    {"id": t.id, "box": list(loc), "name": t.name if known else None, "status": status}
                )
            return {"w": w, "h": h, "faces": faces, "events": events}
