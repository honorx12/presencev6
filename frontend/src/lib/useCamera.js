import { useCallback, useEffect, useRef, useState } from 'react';
import { isVirtualLabel, pickRealCamera } from './cameraPick';

// One camera hook for every page. Handles:
//  - picking ANY camera the OS exposes (built-in webcam, USB, OBS Virtual Camera, ...)
//  - or a network MJPEG stream URL (see /bridge — turns a V380/RTSP cam into one)
//  - recovering when the source drops (track ended, tab hidden/shown, device unplugged)
//  - telling the user WHY the picture is black/frozen instead of silently showing nothing
//
// status: idle | starting | live | black | frozen | stalled | error

const LS = {
  device: 'presence.cam.deviceId',
  source: 'presence.cam.source',
  url: 'presence.cam.url',
  mirror: 'presence.cam.mirror'
};
const ls = {
  get: (k, d = '') => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  }
};

const WATCH_MS = 1500;
const STALL_MS = 5000; // no new video frames this long -> restart
const BLACK_MS = 4000; // picture black this long -> tell the user
const FROZEN_MS = 12000; // picture identical this long -> tell the user

const BLACK_HINT =
  'Camera feed is black. If the source is OBS Virtual Camera: OBS cannot capture a MINIMISED window — ' +
  'restore the V380 window (it may sit behind others), or in OBS use a Media Source / VLC Source with the camera RTSP URL, ' +
  'or use "Network camera" below.';
const FROZEN_HINT =
  'Picture is frozen. The source app probably stopped sending frames (V380 window minimised/closed?). Restore it, then press Reconnect.';

function explain(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return 'Camera permission blocked. Click the camera icon in the address bar, allow it, then press Reconnect. (Camera only works on https:// or localhost.)';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No camera found. Plug one in or start OBS Virtual Camera, then press Reconnect.';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError')
    return 'Camera is busy — another app or browser tab is using it (OBS, V380, Zoom, another tab). Close it or pick a different camera.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot access a camera here. Open the site over https:// in Chrome, Edge or Firefox.';
  return `Camera error: ${err?.message || n || 'unknown'}`;
}

export default function useCamera({ videoRef, enabled = true, width = 640, height = 480 }) {
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceIdState] = useState(() => ls.get(LS.device));
  const [source, setSourceState] = useState(() => ls.get(LS.source, 'device')); // device | url
  const [netUrl, setNetUrlState] = useState(() => ls.get(LS.url));
  const [mirror, setMirrorState] = useState(() => ls.get(LS.mirror, '1') === '1');
  const [status, setStatus] = useState('idle');
  const [hint, setHint] = useState('');
  const [nonce, setNonce] = useState(0); // bump to force a reconnect

  const streamRef = useRef(null);
  const netRef = useRef(null); // { img, canvas, timer }
  const retryRef = useRef({ n: 0, timer: 0 });
  const watchRef = useRef({ lastTime: -1, lastProgress: 0, blackSince: 0, lastSig: null, sameSince: 0 });
  const probeRef = useRef(null);
  const statusRef = useRef('idle');
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const setStat = (s, h = '') => {
    statusRef.current = s;
    setStatus(s);
    setHint(h);
  };

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'videoinput'));
    } catch {
      /* ignore */
    }
  }, []);

  const stopAll = useCallback(() => {
    clearTimeout(retryRef.current.timer);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (netRef.current) {
      clearInterval(netRef.current.timer);
      netRef.current.img.src = '';
      netRef.current = null;
    }
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }, [videoRef]);

  const scheduleRetry = useCallback(() => {
    const r = retryRef.current;
    clearTimeout(r.timer);
    const delay = Math.min(1000 * 2 ** r.n, 8000);
    r.n += 1;
    r.timer = setTimeout(() => setNonce((n) => n + 1), delay);
  }, []);

  // ---- (re)connect whenever the chosen source changes or a reconnect is requested ----
  useEffect(() => {
    if (!enabled) {
      stopAll();
      setStat('idle');
      return undefined;
    }
    let cancelled = false;

    async function attach(stream) {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => {});
      watchRef.current = { lastTime: -1, lastProgress: performance.now(), blackSince: 0, lastSig: null, sameSince: 0 };
      stream.getVideoTracks().forEach((t) => {
        t.onended = () => {
          if (cancelled) return;
          setStat('stalled', 'Camera disconnected — reconnecting…');
          scheduleRetry();
        };
        t.onmute = () => {
          if (!cancelled) setStat('stalled', 'Camera stopped sending frames…');
        };
        t.onunmute = () => {
          if (!cancelled) setStat('live');
        };
      });
      retryRef.current.n = 0;
      setStat('live');

      // nothing chosen yet and the browser handed us a virtual camera (OBS...): prefer a real webcam
      const label = stream.getVideoTracks()[0]?.label || '';
      if (!deviceId && sourceRef.current === 'device' && isVirtualLabel(label)) {
        navigator.mediaDevices
          .enumerateDevices()
          .then((all) => {
            const real = pickRealCamera(all);
            if (real && !cancelled) {
              ls.set(LS.device, real.deviceId);
              setDeviceIdState(real.deviceId);
            }
          })
          .catch(() => {});
      }
    }

    async function startDevice() {
      const base = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } };
      const tries = [];
      if (deviceId) tries.push({ video: { ...base, deviceId: { exact: deviceId } } });
      tries.push({ video: { ...base, facingMode: 'user' } });
      tries.push({ video: true });
      let lastErr;
      for (const c of tries) {
        try {
          return await navigator.mediaDevices.getUserMedia(c);
        } catch (err) {
          lastErr = err;
          if (err.name === 'NotAllowedError' || err.name === 'NotReadableError') break; // retrying won't help
        }
      }
      throw lastErr;
    }

    async function startNetwork() {
      const url = netUrl.trim();
      if (!url) throw Object.assign(new Error('Enter the stream URL first.'), { name: 'NoUrl' });
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('timed out')), 10000);
        img.onload = () => {
          clearTimeout(to);
          resolve();
        };
        img.onerror = () => {
          clearTimeout(to);
          reject(new Error('stream not reachable'));
        };
        img.src = url;
      });
      // stream ended after it had connected (bridge restarted, camera rebooted): reconnect by itself
      img.onerror = () => {
        if (cancelled) return;
        setStat('stalled', 'Network stream dropped — reconnecting…');
        scheduleRetry();
      };
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 640;
      canvas.height = img.naturalHeight || 480;
      const ctx = canvas.getContext('2d');
      const timer = setInterval(() => {
        try {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        } catch {
          /* frame not ready */
        }
      }, 66);
      netRef.current = { img, canvas, timer };
      return canvas.captureStream(15);
    }

    (async () => {
      setStat('starting');
      stopAll();
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no mediaDevices');
        const stream = sourceRef.current === 'url' ? await startNetwork() : await startDevice();
        await attach(stream);
        if (!cancelled) refreshDevices(); // labels only exist after permission
      } catch (err) {
        if (cancelled) return;
        if (err?.name === 'NoUrl') {
          setStat('error', err.message);
          return;
        }
        const msg =
          sourceRef.current === 'url'
            ? `Network camera failed: ${err.message}. Is the bridge running? (https sites can only reach http://localhost streams.)`
            : explain(err);
        setStat('error', msg);
        if (err?.name !== 'NotAllowedError') scheduleRetry();
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, deviceId, source, netUrl, nonce]);

  // ---- watchdog: detect stalled / black / frozen pictures ----
  useEffect(() => {
    if (!enabled) return undefined;
    const probe = (probeRef.current ||= document.createElement('canvas'));
    probe.width = 16;
    probe.height = 12;
    const pctx = probe.getContext('2d', { willReadFrequently: true });

    const id = setInterval(() => {
      const v = videoRef.current;
      const st = statusRef.current;
      if (!v || !['live', 'black', 'frozen', 'stalled'].includes(st)) return;
      const w = watchRef.current;
      const now = performance.now();

      if (v.paused && streamRef.current) v.play().catch(() => {});

      if (v.currentTime !== w.lastTime) {
        w.lastTime = v.currentTime;
        w.lastProgress = now;
      } else if (now - w.lastProgress > STALL_MS) {
        setStat('stalled', 'No video frames arriving — reconnecting…');
        w.lastProgress = now;
        scheduleRetry();
        return;
      }

      if (!v.videoWidth) return;
      try {
        pctx.drawImage(v, 0, 0, 16, 12);
        const px = pctx.getImageData(0, 0, 16, 12).data;
        let sum = 0;
        const sig = new Uint8Array(192);
        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
          const y = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10;
          sig[j] = y;
          sum += y;
        }
        const mean = sum / 192;

        // black?
        if (mean < 6) {
          w.blackSince ||= now;
          if (now - w.blackSince > BLACK_MS && st !== 'black') setStat('black', BLACK_HINT);
        } else {
          w.blackSince = 0;
          // frozen? (a real sensor always has noise; identical frames for 12 s = dead feed)
          let diff = 0;
          if (w.lastSig) for (let i = 0; i < 192; i++) diff += Math.abs(sig[i] - w.lastSig[i]);
          w.lastSig = sig;
          if (w.lastSig && diff / 192 < 0.15) {
            w.sameSince ||= now;
            if (now - w.sameSince > FROZEN_MS && st !== 'frozen') {
              setStat('frozen', FROZEN_HINT);
              if (sourceRef.current === 'url') {
                // a dead bridge keeps the last picture on the canvas forever: reopen the stream
                w.sameSince = now;
                scheduleRetry();
              }
            }
          } else {
            w.sameSince = 0;
            if (st !== 'live') setStat('live');
          }
        }
      } catch {
        /* tainted canvas or not ready */
      }
    }, WATCH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // ---- tab shown again / device plugged or unplugged ----
  useEffect(() => {
    if (!enabled) return undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const t = streamRef.current?.getVideoTracks()[0];
      if (!t || t.readyState === 'ended') setNonce((n) => n + 1);
      else videoRef.current?.play().catch(() => {});
    };
    const onDevices = async () => {
      await refreshDevices();
      const t = streamRef.current?.getVideoTracks()[0];
      if (sourceRef.current === 'device' && (!t || t.readyState === 'ended')) setNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    navigator.mediaDevices?.addEventListener?.('devicechange', onDevices);
    refreshDevices();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices);
    };
  }, [enabled, refreshDevices, videoRef]);

  return {
    devices,
    deviceId,
    source,
    netUrl,
    mirror,
    status,
    hint,
    setDeviceId: (id) => {
      ls.set(LS.device, id);
      ls.set(LS.source, 'device');
      setSourceState('device');
      setDeviceIdState(id);
    },
    useNetwork: (url) => {
      ls.set(LS.url, url);
      ls.set(LS.source, 'url');
      setNetUrlState(url);
      setSourceState('url');
      setNonce((n) => n + 1);
    },
    setMirror: (m) => {
      ls.set(LS.mirror, m ? '1' : '0');
      setMirrorState(m);
    },
    reconnect: () => {
      retryRef.current.n = 0;
      setNonce((n) => n + 1);
    }
  };
}
