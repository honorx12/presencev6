// Self-host the MediaPipe face engine so the site doesn't depend on a CDN that a
// school/office network might block. Runs automatically before `dev` and `build`.
// Never fails the build: the app falls back to the CDN if these files are missing.
import { cpSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'mediapipe');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

mkdirSync(out, { recursive: true });

try {
  if (existsSync(wasmSrc)) {
    cpSync(wasmSrc, join(out, 'wasm'), { recursive: true });
    console.log('[assets] copied MediaPipe wasm');
  } else {
    console.warn('[assets] wasm source missing (run npm install) - CDN fallback will be used');
  }
} catch (e) {
  console.warn('[assets] wasm copy failed:', e.message);
}

const MODELS = [
  ['face_landmarker.task', MODEL_URL],
  [
    'hand_landmarker.task',
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
  ]
];
for (const [file, url] of MODELS) {
  const modelPath = join(out, file);
  if (existsSync(modelPath) && statSync(modelPath).size > 1_000_000) {
    console.log(`[assets] ${file} already present`);
    continue;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
    console.log(`[assets] downloaded ${file}`);
  } catch (e) {
    console.warn(`[assets] ${file} download failed (${e.message}) - CDN fallback will be used`);
  }
}
