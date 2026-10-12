"""
FastAPI service around FaceRecognitionModel.
Auth, roster storage, and attendance records all live in Supabase:
  - Auth        -> Supabase Auth (teacher / developer accounts + `profiles.role`)
  - Roster      -> Supabase Storage bucket "known-faces" (photo = source of truth)
  - Attendance  -> Supabase Postgres table "attendance"

Run:  uvicorn api:app --reload --port 8000
Docs: http://localhost:8000/docs
"""

import io
import os
import re
import smtplib
from datetime import datetime
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from urllib.parse import quote

import face_recognition
from fastapi.concurrency import run_in_threadpool
from fastapi import Depends, FastAPI, Header, Request, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from openpyxl import Workbook
from pydantic import BaseModel

from face_model import FaceRecognitionModel, IMG_EXT
from supabase_client import anon_client, fresh_anon_client, client_as, list_bucket, BUCKET

app = FastAPI(title="Face Recognition API")

# ALLOWED_ORIGINS = comma-separated frontend URLs, e.g. "https://presence.vercel.app".
# Unset / "*" = any origin (fine: auth is a bearer token, not a cookie).
_origins = [o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_origin_regex=os.environ.get("ALLOWED_ORIGIN_REGEX") or None,  # e.g. https://.*\\.vercel\\.app
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = FaceRecognitionModel()
_startup_error: str | None = None
try:
    model.load()  # syncs from Storage + builds/loads encoding cache at startup
except Exception as exc:  # never die at boot: /health reports it, /reload retries
    _startup_error = f"{type(exc).__name__}: {exc}"
    print(f"[WARN] startup load failed: {_startup_error}")


def _resync_forever():
    """Every RESYNC_SECONDS: pull photo changes made directly in the Supabase
    dashboard (replace/upload/delete). Re-encodes only if something changed."""
    import time

    interval = int(os.environ.get("RESYNC_SECONDS", "45"))
    while True:
        time.sleep(interval)
        try:
            model.load()
        except Exception as exc:
            print(f"[WARN] background resync failed: {exc}")


@app.on_event("startup")
def _start_resync():
    import threading

    threading.Thread(target=_resync_forever, daemon=True).start()


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Surface a JSON body instead of a bare 'Internal Server Error' so the
    frontend's error handling (and this terminal) can show what broke."""
    name = type(exc).__name__
    # Supabase unreachable (no internet / DNS blocked / project paused): say so, as 503, not a mystery 500
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)) or any(
        k in name for k in ("ConnectError", "ConnectTimeout", "ReadTimeout", "TimeoutException", "NetworkError", "RemoteProtocolError")
    ):
        return JSONResponse(
            status_code=503,
            content={"detail": "Cannot reach Supabase (check internet / DNS, or the project may be paused). " f"[{name}: {exc}]"},
        )
    return JSONResponse(status_code=500, content={"detail": f"{name}: {exc}"})

ROLE_RANK = {"teacher": 1, "developer": 2}

# ---------- email config (all optional; export still works without it) ----------
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER)
TEACHER_EMAIL = os.environ.get("TEACHER_EMAIL", "")


# ---------- auth helpers ----------
def get_token(authorization: str | None = Header(default=None)) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1]


def get_role(token: str | None = Depends(get_token)) -> str | None:
    if not token:
        return None
    sb = client_as(token)
    try:
        user = sb.auth.get_user(token).user
    except Exception:
        return None
    if not user:
        return None
    try:
        res = sb.table("profiles").select("role").eq("id", user.id).limit(1).execute()
    except Exception:
        return None
    return res.data[0]["role"] if res.data else None


def require_role(min_role: str):
    """Dependency factory. Validates the bearer token + role, and hands the
    endpoint the raw token back (needed to make Supabase calls as that user
    so RLS policies apply correctly)."""

    def dependency(
        token: str | None = Depends(get_token),
        role: str | None = Depends(get_role),
    ) -> str:
        if role is None:
            raise HTTPException(401, detail="login required")
        if ROLE_RANK.get(role, 0) < ROLE_RANK[min_role]:
            raise HTTPException(403, detail=f"{min_role} access required")
        return token

    return dependency


require_teacher = require_role("teacher")  # teacher or developer
require_developer = require_role("developer")  # developer only


# ---------- models ----------
class MatchResult(BaseModel):
    name: str
    distance: float | None
    box: list[int] | None  # [top, right, bottom, left]


class RecognizeResponse(BaseModel):
    faces: list[MatchResult]
    logged: list[str]


class AttendanceRecord(BaseModel):
    id: int
    name: str
    date: str
    time: str
    out_time: str | None = None
    status: str


class AttendanceStatusUpdate(BaseModel):
    status: str  # "present" | "absent"


class KnownFace(BaseModel):
    name: str
    image_url: str


class RenameStudent(BaseModel):
    new_name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class RosterAttendanceRow(BaseModel):
    name: str
    status: str  # "present" | "absent" — every enrolled name gets a row, even with no scan yet
    id: int | None
    time: str | None
    out_time: str | None = None


class HistoryRow(BaseModel):
    date: str
    time: str | None  # in-time
    out_time: str | None
    status: str


class EmailRequest(BaseModel):
    date: str | None = None
    to: str | None = None  # falls back to TEACHER_EMAIL env var if omitted


# ---------- health ----------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "known_faces": len(model.names),
        "startup_error": _startup_error,
        "sync": model.sync,  # ok / error / remote_photos / local_photos / undetected (photos with no face)
    }


# ---------- auth (thin passthrough to Supabase Auth) ----------
@app.post("/login")
def login(body: LoginRequest):
    sb = fresh_anon_client()
    try:
        res = sb.auth.sign_in_with_password({"email": body.email, "password": body.password})
    except Exception as exc:
        raise HTTPException(401, detail=str(exc))
    profile = sb.table("profiles").select("role").eq("id", res.user.id).limit(1).execute()
    if not profile.data:
        raise HTTPException(403, detail="account has no assigned role — ask a developer to add one")
    return {
        "access_token": res.session.access_token,
        "refresh_token": res.session.refresh_token,
        "email": res.user.email,
        "role": profile.data[0]["role"],
    }


@app.get("/me")
def me(role: str | None = Depends(get_role)):
    if role is None:
        raise HTTPException(401, detail="login required")
    return {"role": role}


# ---------- roster ----------
@app.get("/faces", response_model=list[KnownFace])
def list_faces():
    sb = anon_client()
    objects = list_bucket(sb)
    faces = []
    for obj in sorted(objects, key=lambda o: o["name"]):
        fname = obj["name"]
        if fname.lower().endswith(IMG_EXT):
            name = os.path.splitext(fname)[0]
            url = sb.storage.from_(BUCKET).get_public_url(fname)
            # cache-bust: a photo replaced under the SAME name otherwise keeps showing the old image
            ver = obj.get("updated_at") or obj.get("created_at") or ""
            if ver:
                url = f"{url}{'&' if '?' in url else '?'}v={quote(str(ver), safe='')}"
            faces.append(KnownFace(name=name, image_url=url))
    return faces


def _encode_has_face(contents: bytes) -> bool:
    img = face_recognition.load_image_file(io.BytesIO(contents))
    return bool(face_recognition.face_encodings(img))


def _clean_name(name: str) -> str:
    """Name becomes the storage filename — strip anything Storage rejects."""
    cleaned = re.sub(r"[^\w\- .]", "", name, flags=re.UNICODE).strip().replace("/", "")
    if not cleaned:
        raise HTTPException(400, detail="name has no usable characters")
    return cleaned[:80]


@app.post("/register")
async def register(
    name: str = Form(...),
    file: UploadFile = File(...),
    token: str = Depends(require_teacher),
):
    name = _clean_name(name)
    ext = os.path.splitext(file.filename or "")[1].lower()
    suffix = ext if ext in (".jpg", ".jpeg", ".png") else (".png" if file.content_type == "image/png" else ".jpg")
    contents = await file.read()
    if not contents:
        raise HTTPException(400, detail="empty image")

    # validate a face is actually detectable before uploading
    try:
        has_face = await run_in_threadpool(_encode_has_face, contents)
    except Exception as exc:
        raise HTTPException(400, detail=f"could not read image: {exc}")
    if not has_face:
        raise HTTPException(400, detail="no face detected in image")

    sb = client_as(token)
    path = f"{name}{suffix}"
    try:
        await run_in_threadpool(
            lambda: sb.storage.from_(BUCKET).upload(
                path,
                contents,
                {"content-type": "image/png" if suffix == ".png" else "image/jpeg", "upsert": "true"},
            )
        )
    except Exception as exc:
        raise HTTPException(400, detail=f"upload failed: {exc}")

    await run_in_threadpool(model.load)  # re-sync + re-encode, picks up the new photo
    return {"registered": name, "known_faces": len(model.names)}


@app.put("/faces/{name}")
def rename_face(name: str, body: RenameStudent, token: str = Depends(require_teacher)):
    """Teacher or developer: correct a student's name on the roster."""
    sb = client_as(token)
    objects = list_bucket(sb)
    match = next((o for o in objects if os.path.splitext(o["name"])[0] == name), None)
    if not match:
        raise HTTPException(404, detail="student not found")
    ext = os.path.splitext(match["name"])[1]
    new_path = f"{body.new_name}{ext}"
    if any(os.path.splitext(o["name"])[0] == body.new_name for o in objects):
        raise HTTPException(409, detail="a student with that name already exists")

    try:
        sb.storage.from_(BUCKET).move(match["name"], new_path)
    except Exception as exc:
        raise HTTPException(400, detail=f"rename failed: {exc}")

    # keep historical attendance rows pointing at the new name
    sb.table("attendance").update({"name": body.new_name}).eq("name", name).execute()

    model.load()
    return {"renamed": name, "to": body.new_name}


@app.delete("/faces/{name}")
def delete_face(name: str, token: str = Depends(require_developer)):
    """Developer only: remove a student and their photo entirely."""
    sb = client_as(token)
    objects = list_bucket(sb)
    match = next((o for o in objects if os.path.splitext(o["name"])[0] == name), None)
    if not match:
        raise HTTPException(404, detail="student not found")
    try:
        sb.storage.from_(BUCKET).remove([match["name"]])
    except Exception as exc:
        raise HTTPException(400, detail=f"delete failed: {exc}")

    model.load()
    return {"deleted": name}


@app.post("/reload")
def reload_cache():
    """Force re-sync from Storage + re-encode (e.g. after editing the bucket directly)."""
    global _startup_error
    try:
        model.load()
        _startup_error = None
    except Exception as exc:
        _startup_error = f"{type(exc).__name__}: {exc}"
        raise HTTPException(500, detail=_startup_error)
    return {"known_faces": len(model.names), "sync": model.sync}


# ---------- recognition / attendance ----------
@app.post("/recognize", response_model=RecognizeResponse)
async def recognize(file: UploadFile = File(...), mark_attendance: bool = Form(True)):
    contents = await file.read()
    if not contents:
        raise HTTPException(400, detail="empty frame received")

    # A frame from a live scan loop is occasionally a truncated/garbled JPEG
    # (tab backgrounded, camera hiccup, etc). Treat that as "no face this
    # tick" instead of a hard failure so the terminal loop just keeps going.
    try:
        img = face_recognition.load_image_file(io.BytesIO(contents))
        locations = face_recognition.face_locations(img)
        encodings = face_recognition.face_encodings(img, locations)
    except Exception as exc:
        raise HTTPException(422, detail=f"could not read frame: {exc}")

    results = []
    logged = []
    sb = anon_client() if mark_attendance else None

    for loc, enc in zip(locations, encodings):
        try:
            name, dist = model.match(enc)
        except Exception as exc:
            raise HTTPException(500, detail=f"matching failed: {exc}")
        final_name = name or "Unknown"
        results.append(MatchResult(name=final_name, distance=dist, box=list(loc)))

        if mark_attendance and final_name != "Unknown" and sb is not None:
            now = datetime.now()
            today = now.strftime("%Y-%m-%d")
            now_time = now.strftime("%H:%M:%S")
            try:
                sb.table("attendance").insert(
                    {
                        "name": final_name,
                        "date": today,
                        "time": now_time,
                        "status": "present",
                    }
                ).execute()
                logged.append(final_name)
            except Exception:
                # Already has an "in" row today (unique constraint) — treat
                # this scan as the student leaving and stamp out_time,
                # as long as it's been a little while since the last scan.
                try:
                    existing = (
                        sb.table("attendance")
                        .select("id,time,out_time")
                        .eq("name", final_name)
                        .eq("date", today)
                        .execute()
                        .data
                    )
                    if existing:
                        row = existing[0]
                        in_time = datetime.strptime(row["time"], "%H:%M:%S").time()
                        elapsed = (
                            datetime.combine(now.date(), now.time())
                            - datetime.combine(now.date(), in_time)
                        ).total_seconds()
                        if elapsed > 60:  # ignore rapid re-scans of the same frame
                            sb.table("attendance").update({"out_time": now_time}).eq(
                                "id", row["id"]
                            ).execute()
                            logged.append(final_name)
                except Exception:
                    pass  # transient error — skip silently, next scan will retry

    return RecognizeResponse(faces=results, logged=logged)



def _mark_attendance(name: str) -> str:
    """Log a verified person. Returns "in" (first scan today), "out" (leaving,
    >60s after in) or "skip" (already logged, too soon / error)."""
    sb = anon_client()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    now_time = now.strftime("%H:%M:%S")
    try:
        sb.table("attendance").insert(
            {"name": name, "date": today, "time": now_time, "status": "present"}
        ).execute()
        return "in"
    except Exception:
        try:
            existing = (
                sb.table("attendance").select("id,time,out_time")
                .eq("name", name).eq("date", today).execute().data
            )
            if existing:
                row = existing[0]
                in_time = datetime.strptime(row["time"], "%H:%M:%S").time()
                elapsed = (
                    datetime.combine(now.date(), now.time()) - datetime.combine(now.date(), in_time)
                ).total_seconds()
                if elapsed > 60:
                    sb.table("attendance").update({"out_time": now_time}).eq("id", row["id"]).execute()
                    return "out"
        except Exception:
            pass
    return "skip"


class MarkRequest(BaseModel):
    name: str


@app.post("/identify")
def identify(file: UploadFile = File(...)):
    """Face crop in, roster name out. Used by the browser after it tracks a face.
    name = None when no face found in the crop, "Unknown" when not in roster."""
    try:
        img = face_recognition.load_image_file(io.BytesIO(file.file.read()))
        locs = face_recognition.face_locations(img)
        if not locs:
            return {"name": None, "distance": None}
        loc = max(locs, key=lambda l: (l[2] - l[0]) * (l[1] - l[3]))
        enc = face_recognition.face_encodings(img, [loc])
        if not enc:
            return {"name": None, "distance": None}
        name, dist = model.match(enc[0])
        return {"name": name or "Unknown", "distance": dist}
    except Exception:
        return {"name": None, "distance": None}


@app.post("/mark")
def mark(body: MarkRequest):
    """Log attendance for a face the browser identified AND saw blink."""
    if body.name not in model.names:
        raise HTTPException(404, detail="name not in roster")
    try:
        return {"kind": _mark_attendance(body.name)}
    except Exception as exc:
        raise HTTPException(503, detail=f"attendance store unreachable: {exc}")


@app.get("/attendance", response_model=list[AttendanceRecord])
def get_attendance(date: str | None = None):
    sb = anon_client()
    q = sb.table("attendance").select("*")
    if date:
        q = q.eq("date", date).order("time", desc=True)
    else:
        q = q.order("date", desc=True).order("time", desc=True).limit(200)
    rows = q.execute().data
    return [
        AttendanceRecord(
            id=r["id"],
            name=r["name"],
            date=str(r["date"]),
            time=str(r["time"]),
            out_time=str(r["out_time"]) if r.get("out_time") else None,
            status=r["status"],
        )
        for r in rows
    ]


@app.get("/attendance/history", response_model=list[HistoryRow])
def get_attendance_history(
    name: str,
    start: str | None = None,
    end: str | None = None,
    token: str = Depends(require_teacher),
):
    """Per-student in/out log across a date range, for the teacher calendar view."""
    sb = anon_client()
    q = sb.table("attendance").select("*").eq("name", name)
    if start:
        q = q.gte("date", start)
    if end:
        q = q.lte("date", end)
    rows = q.order("date", desc=True).execute().data
    return [
        HistoryRow(
            date=str(r["date"]),
            time=str(r["time"]) if r.get("time") else None,
            out_time=str(r["out_time"]) if r.get("out_time") else None,
            status=r["status"],
        )
        for r in rows
    ]


@app.get("/attendance/dates", response_model=list[str])
def get_attendance_dates():
    sb = anon_client()
    rows = sb.table("attendance").select("date").order("date", desc=True).execute().data
    seen, dates = set(), []
    for r in rows:
        d = str(r["date"])
        if d not in seen:
            seen.add(d)
            dates.append(d)
    return dates


def _roster_rows(date: str | None = None) -> tuple[str, list[RosterAttendanceRow]]:
    """Every enrolled name for one day, joined against that day's scans.
    Names with no scan come back 'absent' with id=None (nothing to update
    yet — set_roster_status inserts on first manual override)."""
    sb = anon_client()
    d = date or datetime.now().strftime("%Y-%m-%d")
    objects = list_bucket(sb)
    names = sorted(
        os.path.splitext(o["name"])[0] for o in objects if o["name"].lower().endswith(IMG_EXT)
    )
    day_rows = sb.table("attendance").select("*").eq("date", d).execute().data
    by_name = {r["name"]: r for r in day_rows}
    result = []
    for name in names:
        r = by_name.get(name)
        if r:
            result.append(
                RosterAttendanceRow(
                    name=name,
                    status=r["status"],
                    id=r["id"],
                    time=str(r["time"]),
                    out_time=str(r["out_time"]) if r.get("out_time") else None,
                )
            )
        else:
            result.append(RosterAttendanceRow(name=name, status="absent", id=None, time=None))
    return d, result


def _build_workbook(date: str, rows: list[RosterAttendanceRow]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = date[:31]
    ws.append(["Name", "Status", "In Time", "Out Time"])
    for r in rows:
        ws.append([r.name, r.status.capitalize(), r.time or "", r.out_time or ""])
    for col in ("A", "B", "C", "D"):
        ws.column_dimensions[col].width = 22
    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()


def _send_attendance_email(to: str, date: str, xlsx_bytes: bytes):
    if not (SMTP_HOST and SMTP_USER and SMTP_PASS):
        raise HTTPException(
            500, detail="email not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS (see backend/.env.example)"
        )
    msg = MIMEMultipart()
    msg["Subject"] = f"Attendance — {date}"
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg.attach(MIMEText(f"Attendance sheet for {date} attached.", "plain"))
    part = MIMEApplication(xlsx_bytes, Name=f"attendance_{date}.xlsx")
    part["Content-Disposition"] = f'attachment; filename="attendance_{date}.xlsx"'
    msg.attach(part)
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_FROM, [to], msg.as_string())
    except Exception as exc:
        raise HTTPException(502, detail=f"email send failed: {exc}")


@app.get("/attendance/roster", response_model=list[RosterAttendanceRow])
def get_attendance_roster(date: str | None = None):
    """Full enrolled roster for one day, present/absent per student. This is
    what the teacher's manual-edit grid renders."""
    _, rows = _roster_rows(date)
    return rows


@app.put("/attendance/roster/{name}", response_model=AttendanceRecord)
def set_roster_status(
    name: str, body: AttendanceStatusUpdate, date: str | None = None, token: str = Depends(require_teacher)
):
    """Teacher override for one student on one day — ticks a student present
    who was never scanned, or flips a false match back to absent."""
    if body.status not in ("present", "absent"):
        raise HTTPException(400, detail="status must be 'present' or 'absent'")
    sb = client_as(token)
    d = date or datetime.now().strftime("%Y-%m-%d")
    existing = sb.table("attendance").select("id").eq("name", name).eq("date", d).execute().data
    if existing:
        res = sb.table("attendance").update({"status": body.status}).eq("id", existing[0]["id"]).execute()
    else:
        res = sb.table("attendance").insert(
            {"name": name, "date": d, "time": datetime.now().strftime("%H:%M:%S"), "status": body.status}
        ).execute()
    r = res.data[0]
    return AttendanceRecord(id=r["id"], name=r["name"], date=str(r["date"]), time=str(r["time"]), status=r["status"])


@app.get("/attendance/export")
def export_attendance(date: str | None = None, token: str = Depends(require_teacher)):
    """Download the day's roster as .xlsx."""
    d, rows = _roster_rows(date)
    xlsx = _build_workbook(d, rows)
    return StreamingResponse(
        io.BytesIO(xlsx),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="attendance_{d}.xlsx"'},
    )


@app.post("/attendance/email")
def email_attendance(body: EmailRequest, token: str = Depends(require_teacher)):
    """Email the day's roster as .xlsx. `to` falls back to TEACHER_EMAIL env var."""
    to = body.to or TEACHER_EMAIL
    if not to:
        raise HTTPException(400, detail="no recipient — pass 'to' or set TEACHER_EMAIL in backend/.env")
    d, rows = _roster_rows(body.date)
    xlsx = _build_workbook(d, rows)
    _send_attendance_email(to, d, xlsx)
    return {"sent_to": to, "date": d}


@app.patch("/attendance/{record_id}", response_model=AttendanceRecord)
def set_attendance_status(record_id: int, body: AttendanceStatusUpdate, token: str = Depends(require_teacher)):
    """Manual override — teacher or developer can flip Present/Absent."""
    if body.status not in ("present", "absent"):
        raise HTTPException(400, detail="status must be 'present' or 'absent'")
    sb = client_as(token)
    res = sb.table("attendance").update({"status": body.status}).eq("id", record_id).execute()
    if not res.data:
        raise HTTPException(404, detail="attendance record not found")
    r = res.data[0]
    return AttendanceRecord(id=r["id"], name=r["name"], date=str(r["date"]), time=str(r["time"]), status=r["status"])


@app.delete("/attendance/{record_id}")
def delete_attendance(record_id: int, token: str = Depends(require_developer)):
    sb = client_as(token)
    res = sb.table("attendance").delete().eq("id", record_id).execute()
    if not res.data:
        raise HTTPException(404, detail="attendance record not found")
    return {"deleted": record_id}
