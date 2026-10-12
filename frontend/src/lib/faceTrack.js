// Frame-to-frame face tracking + blink detection. Pure JS (no React, no DOM),
// so it runs every video frame in the browser.
//
// Input each frame: detections [{x1,y1,x2,y2,blink}] with box in 0..1 video
// coordinates and blink = mean eyeBlink blendshape score (0 open .. 1 closed).

const BLINK_ON = 0.5; // score above this = eyes closed
const BLINK_OFF = 0.3; // score below this = eyes open again
const BLINK_VALID_MS = 8000; // a blink counts for this long
const SMOOTH = 0.6; // box smoothing, 1 = raw, lower = smoother
const LOST_MS = 600; // drop a track unseen this long
const MATCH_DIST = 0.6; // max centre jump between frames, x face size
const ID_KNOWN_MS = 4000; // re-check identity of a known face
const ID_UNKNOWN_MS = 1500; // retry identity of an unknown face
const ID_RETRY_MS = 300; // retry when server saw no face in the crop

export function isKnown(t) {
  return !!t.name && t.name !== 'Unknown';
}

export class FaceTracks {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
  }

  // Returns { seen: tracks visible this frame, verified: tracks newly verified }
  update(dets, vw, vh, now) {
    const cur = dets.map((d) => ({
      ...d,
      cx: (d.x1 + d.x2) / 2,
      cy: (d.y1 + d.y2) / 2,
      size: Math.max((d.x2 - d.x1) * vw, (d.y2 - d.y1) * vh)
    }));

    const pairs = [];
    this.tracks.forEach((t, ti) =>
      cur.forEach((d, di) => {
        const dist = Math.hypot((t.cx - d.cx) * vw, (t.cy - d.cy) * vh);
        if (dist < MATCH_DIST * Math.max(t.size, d.size)) pairs.push([dist, ti, di]);
      })
    );
    pairs.sort((a, b) => a[0] - b[0]);

    const tUsed = new Set();
    const dUsed = new Set();
    const seen = [];
    const verified = [];
    const apply = (t, d) => {
      this._apply(t, d, now);
      seen.push(t);
      if (this.tryVerify(t, now)) verified.push(t);
    };

    for (const [, ti, di] of pairs) {
      if (tUsed.has(ti) || dUsed.has(di)) continue;
      tUsed.add(ti);
      dUsed.add(di);
      apply(this.tracks[ti], cur[di]);
    }
    cur.forEach((d, di) => {
      if (dUsed.has(di)) return;
      const t = {
        id: this.nextId++,
        name: null, // null = not identified yet, 'Unknown', or a roster name
        lastId: 0,
        pending: false,
        closed: false,
        blinkAt: 0,
        blinked: false,
        verified: false,
        announced: false,
        box: null
      };
      this.tracks.push(t);
      apply(t, d);
    });

    this.tracks = this.tracks.filter((t) => now - t.seenAt < LOST_MS);
    return { seen, verified };
  }

  _apply(t, d, now) {
    t.seenAt = now;
    t.cx = d.cx;
    t.cy = d.cy;
    t.size = d.size;
    t.raw = { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
    if (!t.box) t.box = { ...t.raw };
    else for (const k of ['x1', 'y1', 'x2', 'y2']) t.box[k] += (t.raw[k] - t.box[k]) * SMOOTH;

    if (d.blink > BLINK_ON) {
      t.closed = true;
    } else if (d.blink < BLINK_OFF && t.closed) {
      t.closed = false;
      t.blinked = true;
      t.blinkAt = now;
    }
    if (t.blinked && now - t.blinkAt > BLINK_VALID_MS) t.blinked = false;
  }

  // true only the moment a track becomes verified
  tryVerify(t, now) {
    if (t.verified || !t.blinked || !isKnown(t)) return false;
    if (now - t.blinkAt > BLINK_VALID_MS) return false;
    t.verified = true;
    return true;
  }

  needsId(t, now) {
    if (t.pending || now - t.seenAt > 300) return false;
    if (t.name === null) return now - t.lastId > ID_RETRY_MS;
    if (t.name === 'Unknown') return now - t.lastId > ID_UNKNOWN_MS;
    return now - t.lastId > ID_KNOWN_MS;
  }

  // biggest face that needs an identity check
  pickForId(now) {
    return this.tracks.filter((t) => this.needsId(t, now)).sort((a, b) => b.size - a.size)[0] || null;
  }

  // name: roster name, 'Unknown', or null (no face found in crop)
  setIdentity(t, name, now) {
    t.lastId = now;
    if (!name) return false;
    if (t.name && t.name !== name) {
      // identity changed: earlier blink no longer counts
      t.closed = false;
      t.blinked = false;
      t.verified = false;
    }
    t.name = name;
    return this.tryVerify(t, now);
  }
}
