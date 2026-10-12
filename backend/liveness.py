"""Blink-based liveness check. A static photo (phone screen, print) never blinks."""

import numpy as np
import face_recognition

EAR_CLOSED = 0.21  # eye counts as closed below this
EAR_OPEN = 0.26    # eye counts as open above this


def _ear(eye):
    p = np.array(eye, dtype=float)
    a = np.linalg.norm(p[1] - p[5])
    b = np.linalg.norm(p[2] - p[4])
    c = np.linalg.norm(p[0] - p[3])
    return (a + b) / (2.0 * c) if c else 0.0


def frame_ear(img):
    """Mean eye aspect ratio for the largest face in frame, or None."""
    lms = face_recognition.face_landmarks(img)
    if not lms:
        return None
    f = lms[0]
    return (_ear(f["left_eye"]) + _ear(f["right_eye"])) / 2.0


def has_blink(ears):
    """True when eyes go open -> closed -> open across the burst."""
    seq = [e for e in ears if e is not None]
    if len(seq) < 4:
        return False
    state, opened, closed = "start", False, False
    for e in seq:
        if e > EAR_OPEN:
            if closed:
                return True
            opened = True
        elif e < EAR_CLOSED and opened:
            closed = True
    return False


def face_ear(lm):
    """EAR from one face_landmarks() dict."""
    return (_ear(lm["left_eye"]) + _ear(lm["right_eye"])) / 2.0
