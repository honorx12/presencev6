// Hand gesture -> camera-move logic. Pure JS (no React, no DOM, no MediaPipe import),
// so it can be unit-tested and runs every frame in the browser.
//
// Input per frame : face boxes + hand landmark sets (MediaPipe 21-point hands, 0..1 video coords)
// Output per frame: { state, op, pose, key, cmd, event }
//
// Flow
//   idle   : show the ARM gesture (rock sign 🤘 or fist ✊) next to your face and hold ~0.7 s
//            -> LOCKED onto that face. The detection square follows only that face.
//   locked : hand to the LEFT / RIGHT of your face (open hand)  -> camera pans that way
//            index finger pointing UP / DOWN                      -> camera tilts that way
//            show the ARM gesture again (hold) or 30 s without a command -> unlocked
//
// Direction rule: the camera turns TOWARD where your hand appears in the picture
// (hand on the image's right side -> "right"). Mirror-independent. If your camera is
// mounted upside-down / rotated, tick "invert" in the panel.

const FINGERS = { index: [5, 6], middle: [9, 10], ring: [13, 14], pinky: [17, 18] }; // [mcp, pip]
const TIPS = { index: 8, middle: 12, ring: 16, pinky: 20 };

const ARM_HOLD_MS = 700; // hold the arm gesture this long to lock / unlock
const ARM_REACH = 3.5; // arm hand must be within this many face-sizes of a face
const OP_JUMP = 1.2; // operator face may move this many face-sizes between frames
const OP_LOST_MS = 1500; // operator face unseen this long -> unlock
const HAND_REACH = 6; // ignore hands further than this many face-sizes from the operator
const PAN_X = 1.7; // hand must be this many face-sizes left/right of face centre to pan
const STABLE_MS = 250; // pose must be steady this long before the first move
const PULSE_MS = 450; // then one move command per this interval
const PULSE_HOLD_MS = 380; // each command moves the camera this long
const LOCK_IDLE_MS = 30000; // auto-unlock after this long with no command

const d2 = (a, b, asp) => Math.hypot((a.x - b.x) * asp, a.y - b.y);

/** which of the four fingers are extended (rotation-independent: tip farther from wrist than the middle joint) */
export function fingerStates(lm, asp = 1) {
  const w = lm[0];
  const out = {};
  for (const [name, [, pip]] of Object.entries(FINGERS)) {
    out[name] = d2(lm[TIPS[name]], w, asp) > d2(lm[pip], w, asp) * 1.08;
  }
  return out;
}

/** -> { pose, ext } ; pose: rock | fist | point_up | point_down | point_side | open | other */
export function classifyHand(lm, asp = 1) {
  const ext = fingerStates(lm, asp);
  const n = Object.values(ext).filter(Boolean).length;
  let pose = 'other';
  if (ext.index && ext.pinky && !ext.middle && !ext.ring) pose = 'rock';
  else if (n === 0) pose = 'fist';
  else if (ext.index && !ext.middle && !ext.ring && !ext.pinky) {
    const dx = (lm[8].x - lm[5].x) * asp;
    const dy = lm[8].y - lm[5].y;
    if (Math.abs(dy) > Math.abs(dx) * 1.2) pose = dy < 0 ? 'point_up' : 'point_down';
    else pose = 'point_side';
  } else if (n >= 3) pose = 'open';
  return { pose, ext };
}

export function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  return { x: ids.reduce((s, i) => s + lm[i].x, 0) / ids.length, y: ids.reduce((s, i) => s + lm[i].y, 0) / ids.length };
}

export const POSE_LABEL = {
  rock: '🤘 rock',
  fist: '✊ fist',
  point_up: '☝ point up',
  point_down: '👇 point down',
  point_side: '👉 point (sideways)',
  open: '✋ open hand',
  other: 'hand'
};

export class GestureController {
  constructor(opts = {}) {
    this.opts = { arm: 'rock', invertPan: false, invertTilt: false, ...opts };
    this.reset();
  }

  configure(o) {
    Object.assign(this.opts, o);
  }

  reset() {
    this.state = 'idle';
    this.op = null; // operator face {x,y,s} in asp-scaled units
    this.opSeen = 0;
    this.armSince = 0;
    this.lockedAt = 0;
    this.coolUntil = 0;
    this.key = null;
    this.keySince = 0;
    this.lastPulse = 0;
    this.lastActivity = 0;
  }

  /**
   * faces: [{ x1,y1,x2,y2 }]  hands: [landmarks[]]  asp: videoWidth/videoHeight  now: ms
   * returns { state, op:{cx,cy}|null, pose, key, cmd:{dir,ms}|null, event:'locked'|'unlocked-*'|null }
   */
  update({ faces, hands, asp, now }) {
    const F = faces.map((f) => ({
      x: ((f.x1 + f.x2) / 2) * asp,
      y: (f.y1 + f.y2) / 2,
      s: Math.max((f.x2 - f.x1) * asp, f.y2 - f.y1),
      allowed: f.allowed
    }));
    const H = hands.map((lm) => {
      const c = palmCenter(lm);
      return { ...classifyHand(lm, asp), c: { x: c.x * asp, y: c.y } };
    });
    const armPose = this.opts.arm === 'fist' ? 'fist' : 'rock';
    let event = null;
    let cmd = null;
    let pose = null;
    let activeKey = null;

    if (this.state === 'idle') {
      // look for an arm gesture held next to a face
      // face.allowed === false (not the authorised person) can never be locked onto, and a hand
      // closest to such a face is theirs, so it cannot lock either.
      let best = null;
      for (const h of H) {
        if (h.pose !== armPose) continue;
        let nearest = null;
        for (const f of F) {
          const dist = Math.hypot(h.c.x - f.x, h.c.y - f.y);
          if (!nearest || dist < nearest.dist) nearest = { dist, f };
        }
        if (!nearest || nearest.f.allowed === false) continue;
        if (nearest.dist < ARM_REACH * nearest.f.s && (!best || nearest.dist < best.dist)) best = nearest;
      }
      if (best) {
        pose = armPose;
        this.armSince ||= now;
        if (now - this.armSince >= ARM_HOLD_MS) {
          this.state = 'locked';
          this.op = { ...best.f };
          this.opSeen = now;
          this.lockedAt = now;
          this.coolUntil = now + 1500; // don't instantly unlock with the same gesture
          this.lastActivity = now;
          this.armSince = 0;
          this.key = null;
          event = 'locked';
        }
      } else {
        this.armSince = 0;
        pose = H[0]?.pose || null;
      }
    } else {
      // locked: follow the operator face
      let near = null;
      for (const f of F) {
        const dist = Math.hypot(f.x - this.op.x, f.y - this.op.y);
        if (dist < OP_JUMP * this.op.s && (!near || dist < near.dist)) near = { dist, f };
      }
      if (near) {
        this.op = { ...near.f };
        this.opSeen = now;
      } else if (now - this.opSeen > OP_LOST_MS) {
        this._unlock();
        return { state: this.state, op: null, pose: null, key: null, cmd: null, event: 'unlocked-lost' };
      }

      // a hand belongs to the face nearest to it. Only hands owned by the operator count,
      // so someone standing next to you cannot steer the camera.
      let hand = null;
      for (const h of H) {
        let owner = null;
        for (const f of F) {
          const dist = Math.hypot(h.c.x - f.x, h.c.y - f.y);
          if (!owner || dist < owner.dist) owner = { dist, f };
        }
        if (owner && near && owner.f !== near.f) continue; // belongs to somebody else
        const dist = Math.hypot(h.c.x - this.op.x, h.c.y - this.op.y);
        if (dist < HAND_REACH * this.op.s && (!hand || dist < hand.dist)) hand = { dist, h };
      }
      const h = hand?.h || null;
      pose = h?.pose || null;

      if (h && h.pose === armPose) {
        // arm gesture again = unlock
        this.armSince ||= now;
        if (now >= this.coolUntil && now - this.armSince >= ARM_HOLD_MS) {
          this._unlock();
          return { state: 'idle', op: null, pose, key: null, cmd: null, event: 'unlocked-gesture' };
        }
      } else {
        this.armSince = 0;
      }

      // movement key from the hand
      if (h) {
        const { invertPan, invertTilt } = this.opts;
        if (h.pose === 'point_up') activeKey = invertTilt ? 'down' : 'up';
        else if (h.pose === 'point_down') activeKey = invertTilt ? 'up' : 'down';
        else if (h.pose !== armPose && h.pose !== 'point_side') {
          const dx = (h.c.x - this.op.x) / this.op.s;
          if (Math.abs(dx) > PAN_X) activeKey = dx > 0 ? (invertPan ? 'left' : 'right') : invertPan ? 'right' : 'left';
        }
      }
      if (activeKey !== this.key) {
        this.key = activeKey;
        this.keySince = now;
      } else if (activeKey && now - this.keySince >= STABLE_MS && now - this.lastPulse >= PULSE_MS) {
        cmd = { dir: activeKey, ms: PULSE_HOLD_MS };
        this.lastPulse = now;
        this.lastActivity = now;
      }

      if (now - this.lastActivity > LOCK_IDLE_MS) {
        this._unlock();
        return { state: 'idle', op: null, pose, key: null, cmd: null, event: 'unlocked-idle' };
      }
    }

    return {
      state: this.state,
      op: this.op ? { cx: this.op.x / asp, cy: this.op.y } : null,
      pose,
      key: this.state === 'locked' ? activeKey : null,
      cmd,
      event
    };
  }

  _unlock() {
    this.state = 'idle';
    this.op = null;
    this.key = null;
    this.armSince = 0;
  }
}
