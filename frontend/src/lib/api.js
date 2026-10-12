import { supabase } from './supabaseClient';

// Local dev: '/api' (Vite proxies it to uvicorn on :8000).
// Deployed: set VITE_API_URL to the backend URL, e.g. https://presence-api.up.railway.app
const BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');

// fetch wrapper: network failure / timeout -> readable error instead of "Failed to fetch"
async function req(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 60000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    throw new Error(
      err?.name === 'AbortError'
        ? 'Server took too long to answer (it may be waking up) — try again.'
        : 'Cannot reach the server. Check your internet connection / that the backend is running.'
    );
  } finally {
    clearTimeout(timer);
  }
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function handle(res) {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || '');
    } catch {
      /* no JSON body */
    }
    // A bare 500/502/503/504 with no JSON never reached our API code = backend down/restarting.
    if (!detail && res.status >= 500) detail = `Backend unavailable (HTTP ${res.status}) — it may be restarting; retrying.`;
    throw new Error(detail || res.statusText || `HTTP ${res.status}`);
  }
  return res.json();
}

export function getHealth() {
  return req(`${BASE}/health`).then(handle);
}

export function listFaces() {
  return req(`${BASE}/faces`).then(handle);
}

export async function registerFace(name, file) {
  const form = new FormData();
  form.append('name', name);
  form.append('file', file);
  return req(`${BASE}/register`, { method: 'POST', body: form, headers: await authHeaders() }).then(handle);
}

export async function renameStudent(name, newName) {
  return req(`${BASE}/faces/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ new_name: newName })
  }).then(handle);
}

export async function deleteStudent(name) {
  return req(`${BASE}/faces/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: await authHeaders()
  }).then(handle);
}

export function recognizeFace(file, markAttendance = true) {
  const form = new FormData();
  form.append('file', file);
  form.append('mark_attendance', String(markAttendance));
  return req(`${BASE}/recognize`, { method: 'POST', body: form }).then(handle);
}

export function identifyFace(file) {
  const form = new FormData();
  form.append('file', file);
  return req(`${BASE}/identify`, { method: 'POST', body: form }).then(handle);
}

export function markPresent(name) {
  return req(`${BASE}/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(handle);
}

export function getAttendance(date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return req(`${BASE}/attendance${qs}`).then(handle);
}

export function getAttendanceDates() {
  return req(`${BASE}/attendance/dates`).then(handle);
}

export async function setAttendanceStatus(id, status) {
  return req(`${BASE}/attendance/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ status })
  }).then(handle);
}

export async function deleteAttendance(id) {
  return req(`${BASE}/attendance/${id}`, { method: 'DELETE', headers: await authHeaders() }).then(handle);
}

// ---- full-roster attendance grid (every enrolled name, present or absent) ----

export function getAttendanceRoster(date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return req(`${BASE}/attendance/roster${qs}`).then(handle);
}

export async function getAttendanceHistory(name, start, end) {
  const params = new URLSearchParams({ name });
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  return req(`${BASE}/attendance/history?${params.toString()}`, {
    headers: await authHeaders()
  }).then(handle);
}

export async function setRosterStatus(name, date, status) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return req(`${BASE}/attendance/roster/${encodeURIComponent(name)}${qs}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ status })
  }).then(handle);
}

// Requires teacher auth, so this can't be a plain <a href> — fetch as a blob
// and trigger the save ourselves.
export async function exportAttendance(date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await req(`${BASE}/attendance/export${qs}`, { headers: await authHeaders() });
  if (!res.ok) return handle(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance_${date || 'today'}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function emailAttendance(date, to) {
  return req(`${BASE}/attendance/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ date, to })
  }).then(handle);
}

// Opens WhatsApp (app or web) with a pre-filled attendance summary. WhatsApp
// has no free API for attaching a file from the browser, so this only sends
// text — the teacher attaches the .xlsx from "Export" themselves if needed.
export function sendAttendanceWhatsApp(phone, date, summaryText) {
  const digits = phone.replace(/[^\d]/g, '');
  const text = summaryText || `Attendance for ${date}`;
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Sign in via Supabase Auth directly, then ask the backend which role this
// account has (from the `profiles` table) so the UI can gate pages.
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  const res = await req(`${BASE}/me`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` }
  });
  const me = await handle(res);
  return { email: data.user.email, role: me.role };
}
