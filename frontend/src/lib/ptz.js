// Tiny client for the local PTZ helper (bridge/ptz_helper.py) that actually moves the camera.
// The helper runs on the PC that has the camera / V380 app, listens on 127.0.0.1 only.

const KEY = 'presence.ptz.url';
export const DEFAULT_PTZ_URL = 'http://127.0.0.1:8765';

export function getPtzUrl() {
  try {
    return localStorage.getItem(KEY) || DEFAULT_PTZ_URL;
  } catch {
    return DEFAULT_PTZ_URL;
  }
}

export function setPtzUrl(url) {
  try {
    localStorage.setItem(KEY, url);
  } catch {
    /* private mode */
  }
}

async function call(url, path, body, timeout = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url.replace(/\/+$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const ptzStatus = (url) => call(url, '/status');
export const ptzMove = (url, dir, ms) => call(url, '/move', { dir, ms });
export const ptzStop = (url) => call(url, '/stop', {});
