"""
FaceRecognitionModel
Encoding, caching, and matching logic — separated from webcam/DB/UI code.
Photos live in Supabase Storage (bucket "known-faces"); this module mirrors
them into a local folder so face_recognition can read plain files, then
encodes/caches.

Change detection: each remote photo's (updated_at, size) is remembered in a
manifest. A photo replaced under the SAME name is re-downloaded and re-encoded.
(Old code only checked "does the local file exist", so replaced photos were
never picked up until the local known_faces/ folder was deleted.)
"""

import json
import os
import pickle
import threading
import time

import face_recognition
import numpy as np

from supabase_client import anon_client, list_bucket, BUCKET

IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")  # phone photos are often .webp
MANIFEST = ".sync_manifest.json"


def _version(obj: dict) -> str:
    meta = obj.get("metadata") or {}
    return f"{obj.get('updated_at') or obj.get('last_modified') or ''}|{meta.get('size', '')}|{meta.get('eTag', '')}"


class FaceRecognitionModel:
    def __init__(self, faces_dir="known_faces", cache_path="encodings_cache.pkl", threshold=0.5):
        self.faces_dir = faces_dir
        self.cache_path = cache_path
        self.threshold = threshold
        self.encodings = []
        self.names = []
        self._lock = threading.RLock()  # guards the encodings/names swap (held briefly)
        self._load_lock = threading.Lock()  # one load() at a time; slow work happens under this only
        # visible in /health: did the last Supabase sync work, and if not, why
        self.sync = {"ok": None, "error": None, "at": None, "remote_photos": None, "local_photos": 0, "undetected": [], "failed": []}

    # ---- sync from Supabase Storage ----
    def _read_manifest(self):
        try:
            with open(os.path.join(self.faces_dir, MANIFEST)) as f:
                return json.load(f)
        except Exception:
            return {}

    def sync_from_storage(self):
        """Mirror the bucket into faces_dir. Downloads new AND changed photos,
        removes local photos no longer in the bucket. Returns True if anything changed."""
        os.makedirs(self.faces_dir, exist_ok=True)
        sb = anon_client()
        remote = [o for o in list_bucket(sb) if o["name"].lower().endswith(IMG_EXT)]
        self.sync["remote_photos"] = len(remote)
        manifest = self._read_manifest()
        new_manifest = {}
        changed = False

        failed = []
        for obj in remote:
            fname = obj["name"]
            ver = _version(obj)
            local_path = os.path.join(self.faces_dir, fname)
            if os.path.exists(local_path) and manifest.get(fname) == ver:
                new_manifest[fname] = ver
                continue
            try:
                data = sb.storage.from_(BUCKET).download(fname)
                tmp = local_path + ".part"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, local_path)  # atomic: never leaves a half-written photo
                new_manifest[fname] = ver
                changed = True
            except Exception as exc:
                # ONE bad/slow photo must not block the others (it used to abort the whole sync).
                # Keep the old manifest entry so it is retried on the next pass.
                failed.append(fname)
                print(f"[WARN] could not download {fname}: {exc}")
                if fname in manifest:
                    new_manifest[fname] = manifest[fname]
        self.sync["failed"] = failed

        remote_names = {o["name"] for o in remote}
        for fname in os.listdir(self.faces_dir):
            if fname.lower().endswith(IMG_EXT) and fname not in remote_names:
                os.remove(os.path.join(self.faces_dir, fname))
                changed = True

        with open(os.path.join(self.faces_dir, MANIFEST), "w") as f:
            json.dump(new_manifest, f)
        return changed

    # ---- encoding ----
    def _encode_folder(self, folder):
        encodings, names = [], []
        self.sync["undetected"] = []
        for fname in sorted(os.listdir(folder)):
            if not fname.lower().endswith(IMG_EXT):
                continue
            path = os.path.join(folder, fname)
            try:
                img = face_recognition.load_image_file(path)
                # upsample=2: finds smaller faces (e.g. full-body photos like a person standing far away)
                locs = face_recognition.face_locations(img, number_of_times_to_upsample=2)
                if not locs:
                    print(f"[SKIP] no face in {fname}")
                    self.sync["undetected"].append(fname)
                    continue
                # biggest face wins if several people are in the photo
                loc = max(locs, key=lambda l: (l[2] - l[0]) * (l[1] - l[3]))
                enc = face_recognition.face_encodings(img, [loc], num_jitters=2)
                if enc:
                    encodings.append(enc[0])
                    names.append(os.path.splitext(fname)[0])
            except Exception as exc:
                print(f"[SKIP] {fname}: {exc}")
        return encodings, names

    def _folder_signature(self):
        if not os.path.isdir(self.faces_dir):
            return ()
        return tuple(sorted(
            (f, os.path.getmtime(os.path.join(self.faces_dir, f)), os.path.getsize(os.path.join(self.faces_dir, f)))
            for f in os.listdir(self.faces_dir)
            if f.lower().endswith(IMG_EXT)
        ))

    def load(self):
        """Sync photos, then use cache if nothing changed, else re-encode.
        Slow work runs outside self._lock so live matching never stalls."""
        with self._load_lock:
            try:
                self.sync_from_storage()
                self.sync.update(ok=True, error=None)
            except Exception as exc:  # offline / Supabase hiccup: keep what we have
                self.sync.update(ok=False, error=f"{type(exc).__name__}: {exc}")
                print(f"[WARN] storage sync failed, using local photos: {exc}")
            self.sync["at"] = time.strftime("%H:%M:%S")
            sig = self._folder_signature()
            self.sync["local_photos"] = len(sig)

            if os.path.exists(self.cache_path):
                try:
                    with open(self.cache_path, "rb") as f:
                        cached_sig, encodings, names = pickle.load(f)
                    if cached_sig == sig:
                        with self._lock:
                            self.encodings, self.names = encodings, names
                        return
                except Exception as exc:
                    print(f"[WARN] cache unreadable, rebuilding: {exc}")

            encodings, names = self._encode_folder(self.faces_dir)
            with self._lock:
                self.encodings, self.names = encodings, names
            try:
                with open(self.cache_path, "wb") as f:
                    pickle.dump((sig, encodings, names), f)
            except Exception as exc:
                print(f"[WARN] could not write cache: {exc}")
            print(f"[CACHE] rebuilt, {len(names)} face(s)")

    # ---- matching ----
    def match(self, face_encoding):
        """Best match for one encoding. Returns (name, distance) or ('Unknown', distance)."""
        with self._lock:
            encodings, names = self.encodings, self.names
        if not encodings:
            return None, None
        distances = face_recognition.face_distance(encodings, face_encoding)
        best = int(np.argmin(distances))
        if distances[best] < self.threshold:
            return names[best], float(distances[best])
        return "Unknown", float(distances[best])
