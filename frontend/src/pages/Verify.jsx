import { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { identifyFace, markPresent } from '../lib/api';
import { FaceTracks, isKnown } from '../lib/faceTrack';
import useCamera from '../lib/useCamera';
import CameraPicker from '../components/CameraPicker';
import GesturePanel from '../components/GesturePanel';
import { GestureController } from '../lib/gesture';
import { getPtzUrl, setPtzUrl, ptzMove, ptzStatus } from '../lib/ptz';
import '../components/CaptureInput.css';
import './FormPage.css';
import './Verify.css';

// Face engine files are served from this site (/mediapipe, copied at build time by
// scripts/fetch-assets.mjs) so a locked-down network can't break them. CDN = fallback.
const LOCAL_WASM = '/mediapipe/wasm';
const LOCAL_MODEL = '/mediapipe/face_landmarker.task';
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const LOCAL_HAND = '/mediapipe/hand_landmarker.task';
const CDN_HAND =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// Only this roster entry may lock / steer the camera. Matched against the roster name
// (storage file name), so "2407190100044" and "Some Name 2407190100044" both work.
const GESTURE_ROLL = '2407190100044';
const canGesture = (t) => !!t.name && t.name.includes(GESTURE_ROLL);

const GCFG_KEY = 'presence.gesture.cfg';
const GON_KEY = 'presence.gesture.on';

function loadGcfg() {
  try {
    return { arm: 'rock', invertPan: false, invertTilt: false, ...JSON.parse(localStorage.getItem(GCFG_KEY) || '{}') };
  } catch {
    return { arm: 'rock', invertPan: false, invertTilt: false };
  }
}

async function assetOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    return r.ok && !type.includes('text/html'); // SPA fallback returns index.html for missing files
  } catch {
    return false;
  }
}
const MAX_FACES = 4;
const CROP_PAD = 0.35; // extra margin around the face crop sent for identification
const CROP_MAX = 256; // crop is downscaled to this many px before upload
const REPRINT_MS = 30000; // don't reprint the same name sooner than this

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  return new Date().toLocaleTimeString('en-GB');
}

// "2407190100044 .............. present"
function dotted(name) {
  return `${name} ${'.'.repeat(Math.max(4, 26 - name.length))} `;
}

export default function Verify() {
  const videoRef = useRef(null);
  const frameRef = useRef(null);
  const termRef = useRef(null);
  const landmarkerRef = useRef(null);
  const tracksRef = useRef(new FaceTracks());
  const cropRef = useRef(null);
  const printedRef = useRef({}); // name -> last print time
  const lastUnknownRef = useRef(0);
  const lastErrorRef = useRef(0);

  const handRef = useRef(null);
  const gctlRef = useRef(new GestureController(loadGcfg()));
  const gOnRef = useRef(false);
  const gTickRef = useRef(0);
  const gLastRef = useRef({ state: 'idle', pose: null, key: null, focus: null });
  const ptzUrlRef = useRef(getPtzUrl());
  const ptzBusyRef = useRef(false);
  const camRef = useRef(null);

  const [gOn, setGOn] = useState(() => localStorage.getItem(GON_KEY) === '1');
  const [gCfg, setGCfg] = useState(loadGcfg);
  const [handEngine, setHandEngine] = useState('off'); // off | loading | ready | error
  const [g, setG] = useState({ state: 'idle', pose: null, key: null });
  const [ptzUrl, setPtzUrlState] = useState(getPtzUrl);
  const [ptz, setPtz] = useState({ connected: false, ready: false, backend: '', err: '' });
  const [boxes, setBoxes] = useState([]);
  const [engine, setEngine] = useState('loading'); // loading | ready | error
  const [running, setRunning] = useState(true);
  const [lines, setLines] = useState([{ t: stamp(), kind: 'dim', text: 'loading face engine...' }]);

  function addLine(kind, text) {
    setLines((prev) => [...prev, { t: stamp(), kind, text }].slice(-200));
  }

  function reportError(err) {
    if (Date.now() - lastErrorRef.current > 10000) {
      lastErrorRef.current = Date.now();
      addLine('err', `error: ${err?.message || 'backend not reachable'}`);
    }
  }

  const cam = useCamera({ videoRef, enabled: true });
  camRef.current = cam; // the per-frame loop reads this, so Mirror toggles apply immediately

  // load the in-browser face engine (landmarks + blink scores, runs every frame)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const useLocal = (await assetOk(LOCAL_MODEL)) && (await assetOk(`${LOCAL_WASM}/vision_wasm_internal.js`));
        const fileset = await FilesetResolver.forVisionTasks(useLocal ? LOCAL_WASM : CDN_WASM);
        const make = (delegate) =>
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: useLocal ? LOCAL_MODEL : CDN_MODEL, delegate },
            runningMode: 'VIDEO',
            numFaces: MAX_FACES,
            outputFaceBlendshapes: true
          });
        let lm;
        try {
          lm = await make('GPU');
        } catch {
          lm = await make('CPU');
        }
        if (cancelled) {
          lm.close();
          return;
        }
        landmarkerRef.current = lm;
        setEngine('ready');
        addLine('dim', 'scanner ready. waiting for faces...');
      } catch (err) {
        if (!cancelled) {
          setEngine('error');
          addLine('err', `face engine failed to load: ${err?.message || err} (internet needed on first load)`);
        }
      }
    })();
    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    gOnRef.current = gOn;
    try {
      localStorage.setItem(GON_KEY, gOn ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (!gOn) {
      gctlRef.current.reset();
      gLastRef.current = { state: 'idle', pose: null, key: null, focus: null };
      setG({ state: 'idle', pose: null, key: null });
    }
  }, [gOn]);

  useEffect(() => {
    gctlRef.current.configure(gCfg);
    try {
      localStorage.setItem(GCFG_KEY, JSON.stringify(gCfg));
    } catch {
      /* private mode */
    }
  }, [gCfg]);

  // hand engine loads only when gesture control is switched on
  useEffect(() => {
    if (!gOn || engine !== 'ready') return undefined;
    let cancelled = false;
    setHandEngine('loading');
    (async () => {
      try {
        const useLocal = (await assetOk(LOCAL_HAND)) && (await assetOk(`${LOCAL_WASM}/vision_wasm_internal.js`));
        const fileset = await FilesetResolver.forVisionTasks(useLocal ? LOCAL_WASM : CDN_WASM);
        const make = (delegate) =>
          HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: useLocal ? LOCAL_HAND : CDN_HAND, delegate },
            runningMode: 'VIDEO',
            numHands: 2
          });
        let hl;
        try {
          hl = await make('GPU');
        } catch {
          hl = await make('CPU');
        }
        if (cancelled) {
          hl.close();
          return;
        }
        handRef.current = hl;
        setHandEngine('ready');
        addLine('dim', `gesture control ready. only roll ${GESTURE_ROLL} can lock. show a rock sign next to your face.`);
      } catch (err) {
        if (!cancelled) {
          setHandEngine('error');
          addLine('err', `hand engine failed to load: ${err?.message || err}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      handRef.current?.close();
      handRef.current = null;
      setHandEngine('off');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gOn, engine]);

  // is the PTZ helper reachable?
  useEffect(() => {
    if (!gOn) return undefined;
    ptzUrlRef.current = ptzUrl;
    let stop = false;
    const poll = async () => {
      try {
        const s = await ptzStatus(ptzUrl);
        if (!stop) setPtz((p) => ({ ...p, connected: true, ready: !!s.ready, backend: s.backend, err: s.ready ? '' : s.detail }));
      } catch {
        if (!stop) setPtz((p) => ({ ...p, connected: false, ready: false, backend: '' }));
      }
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [gOn, ptzUrl]);

  // per-frame loop: detect, track, blink, draw boxes
  useEffect(() => {
    if (!running || engine !== 'ready') {
      tracksRef.current.reset();
      setBoxes([]);
      return undefined;
    }
    let raf = 0;
    let stop = false;
    let lastTime = -1;
    const loop = () => {
      if (stop) return;
      const video = videoRef.current;
      const lm = landmarkerRef.current;
      const fr = frameRef.current;
      if (video && lm && fr && video.readyState >= 2 && video.videoWidth && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        try {
          step(video, lm, fr);
        } catch {
          /* skip a bad frame */
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      tracksRef.current.reset();
      setBoxes([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, engine]);

  // identity loop: one face crop at a time to the backend (only identity, not tracking)
  useEffect(() => {
    if (!running || engine !== 'ready') return undefined;
    let stop = false;
    (async () => {
      while (!stop) {
        const t = tracksRef.current.pickForId(performance.now());
        if (!t) {
          await sleep(60);
          continue;
        }
        t.pending = true;
        try {
          await identifyTrack(t);
        } catch (err) {
          reportError(err);
          t.lastId = performance.now();
          await sleep(1000);
        } finally {
          t.pending = false;
        }
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, engine]);

  // keep the newest line in view
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [lines]);

  function step(video, lm, fr) {
    const now = performance.now();
    const res = lm.detectForVideo(video, now);
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const dets = (res.faceLandmarks || []).map((pts, i) => {
      let x1 = 1;
      let y1 = 1;
      let x2 = 0;
      let y2 = 0;
      for (const p of pts) {
        if (p.x < x1) x1 = p.x;
        if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.y > y2) y2 = p.y;
      }
      let l = 0;
      let r = 0;
      for (const c of res.faceBlendshapes?.[i]?.categories || []) {
        if (c.categoryName === 'eyeBlinkLeft') l = c.score;
        else if (c.categoryName === 'eyeBlinkRight') r = c.score;
      }
      return { x1, y1, x2, y2, blink: (l + r) / 2 };
    });

    const { seen, verified } = tracksRef.current.update(dets, vw, vh, now);
    verified.forEach(onVerified);

    // gesture control: hands -> lock on one face -> camera moves
    if (gOnRef.current && handRef.current) {
      gTickRef.current += 1;
      if (gTickRef.current % 2 === 0) {
        let hr = null;
        try {
          hr = handRef.current.detectForVideo(video, performance.now());
        } catch (e) {
          reportError(new Error(`hand detection failed: ${e?.message || e}`)); // was swallowed silently
        }
        const gfaces = seen.map((t) => ({ ...t.raw, allowed: canGesture(t) }));
        const out = gctlRef.current.update({ faces: gfaces, hands: hr?.landmarks || [], asp: vw / vh, now });
        if (out.cmd) sendMove(out.cmd);
        if (out.event) onGestureEvent(out.event);
        const prev = gLastRef.current;
        gLastRef.current = { state: out.state, pose: out.pose, key: out.key, focus: out.op };
        if (prev.state !== out.state || prev.pose !== out.pose || prev.key !== out.key) {
          setG({ state: out.state, pose: out.pose, key: out.key });
        }
      }
    }
    const lock = gLastRef.current;
    let focusId = null;
    if (gOnRef.current && lock.state === 'locked' && lock.focus) {
      let bestD = Infinity;
      for (const t of seen) {
        const dd = Math.hypot(t.cx - lock.focus.cx, t.cy - lock.focus.cy);
        if (dd < bestD) {
          bestD = dd;
          focusId = t.id;
        }
      }
    }
    const locked = gOnRef.current && lock.state === 'locked';
    const mirror = camRef.current.mirror;

    // map video coords onto the displayed video (mirrored, object-fit: cover)
    const fw = fr.clientWidth;
    const fh = fr.clientHeight;
    const k = Math.max(fw / vw, fh / vh);
    const ox = (fw - vw * k) / 2;
    const oy = (fh - vh * k) / 2;
    setBoxes(
      seen
        .filter((t) => !locked || t.id === focusId) // locked: only the operator's face stays boxed
        .map((t) => {
        const b = t.box;
        const left = mirror ? fw - (ox + b.x2 * vw * k) : ox + b.x1 * vw * k;
        const right = mirror ? fw - (ox + b.x1 * vw * k) : ox + b.x2 * vw * k;
        const status = locked ? 'operator' : t.verified ? 'verified' : isKnown(t) ? 'matched' : 'unknown';
        const base = t.verified ? t.name : isKnown(t) ? `${t.name} · blink to verify` : '';
        const label = locked ? (base ? `${base} · locked` : 'locked') : base;
        return {
          id: t.id,
          status,
          label,
          style: { left, top: oy + b.y1 * vh * k, width: right - left, height: (b.y2 - b.y1) * vh * k }
        };
      })
    );
  }

  function sendMove(cmd) {
    if (ptzBusyRef.current) return; // one move at a time
    ptzBusyRef.current = true;
    ptzMove(ptzUrlRef.current, cmd.dir, cmd.ms)
      .then(() => setPtz((p) => ({ ...p, connected: true, ready: true, err: '' })))
      .catch((e) => setPtz((p) => ({ ...p, err: e?.message === 'Failed to fetch' ? 'cannot reach the PTZ helper' : e?.message })))
      .finally(() => {
        ptzBusyRef.current = false;
      });
  }

  function onGestureEvent(ev) {
    if (ev === 'locked') addLine('ok', 'gesture: locked on your face. pan = hand left/right, tilt = finger up/down');
    else if (ev === 'unlocked-gesture') addLine('dim', 'gesture: unlocked');
    else if (ev === 'unlocked-idle') addLine('dim', 'gesture: unlocked (30 s without a command)');
    else if (ev === 'unlocked-lost') addLine('dim', 'gesture: unlocked (face left the picture)');
  }

  async function identifyTrack(t) {
    const video = videoRef.current;
    if (!video || !t.raw) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const b = t.raw;
    const w = (b.x2 - b.x1) * vw;
    const h = (b.y2 - b.y1) * vh;
    const sx = Math.max(0, b.x1 * vw - w * CROP_PAD);
    const sy = Math.max(0, b.y1 * vh - h * CROP_PAD);
    const sw = Math.min(vw, b.x2 * vw + w * CROP_PAD) - sx;
    const sh = Math.min(vh, b.y2 * vh + h * CROP_PAD) - sy;
    if (sw < 20 || sh < 20) {
      t.lastId = performance.now();
      return;
    }
    const scale = Math.min(1, CROP_MAX / Math.max(sw, sh));
    if (!cropRef.current) cropRef.current = document.createElement('canvas');
    const c = cropRef.current;
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) return;

    const res = await identifyFace(new File([blob], 'face.jpg', { type: 'image/jpeg' }));
    const now = performance.now();
    if (tracksRef.current.setIdentity(t, res.name, now)) onVerified(t);

    if (res.name === 'Unknown' && !t.announced) {
      t.announced = true;
      if (Date.now() - lastUnknownRef.current > 5000) {
        lastUnknownRef.current = Date.now();
        addLine('dim', 'unknown face ... not in roster');
      }
    }
  }

  async function onVerified(t) {
    try {
      const { kind } = await markPresent(t.name);
      const last = printedRef.current[t.name] || 0;
      if (kind !== 'out' && Date.now() - last < REPRINT_MS) return;
      printedRef.current[t.name] = Date.now();
      if (kind === 'out') addLine('ok', `${dotted(t.name)}out`);
      else addLine('ok', `${dotted(t.name)}present${kind === 'in' ? '' : ' (already logged today)'}`);
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <div className="container form-page">
      <div className="form-grid">
        <div className="card">
          <div className="capture">
            <div className="capture-frame" ref={frameRef}>
              <video ref={videoRef} className={`capture-video${cam.mirror ? '' : ' no-mirror'}`} muted playsInline />
              {gOn && g.state === 'locked' && <div className="gesture-hud">LOCKED{g.key ? ` · ${g.key}` : ''}</div>}
              {boxes.map((b, i) => (
                <div key={b.id} className={`face-box ${b.status}`} style={b.style}>
                  {b.label && <span className="face-box-label">{b.label}</span>}
                </div>
              ))}
              <div className="capture-corner tl" />
              <div className="capture-corner tr" />
              <div className="capture-corner bl" />
              <div className="capture-corner br" />
            </div>
            <div className="capture-controls">
              <button type="button" className="btn btn-outline" onClick={() => setRunning((r) => !r)}>
                {running ? 'Pause scanning' : 'Resume scanning'}
              </button>
            </div>
            <CameraPicker cam={cam} />
            <GesturePanel
              on={gOn}
              setOn={setGOn}
              cfg={gCfg}
              setCfg={setGCfg}
              g={g}
              ptz={ptz}
              url={ptzUrl}
              setUrl={(u) => {
                setPtzUrlState(u);
                setPtzUrl(u);
              }}
              onTest={(dir) => sendMove({ dir, ms: 350 })}
              handEngine={handEngine}
            />
          </div>
        </div>

        <div className="card term-card">
          <div className="term-head">
            <span className={`term-dot ${running ? 'on' : ''}`} />
            attendance — {running ? 'live' : 'paused'}
          </div>
          <div className="term" ref={termRef}>
            {lines.map((l, i) => (
              <div key={i} className={`term-line ${l.kind}`}>
                <span className="term-t">[{l.t}]</span> {l.kind === 'ok' ? '> ' : ''}
                {l.text}
              </div>
            ))}
            <span className="term-cursor">▌</span>
          </div>
        </div>
      </div>
    </div>
  );
}
