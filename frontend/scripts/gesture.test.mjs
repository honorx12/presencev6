import { classifyHand, GestureController } from '../src/lib/gesture.js';

// synthetic 21-point hand. wrist at (wx,wy); fingers point "up" in image then rotated by `deg`
function hand({ wx = 0.5, wy = 0.8, ext = {}, thumb = false, deg = 0 }) {
  const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
  const ox = { index: -0.045, middle: -0.015, ring: 0.015, pinky: 0.045 };
  const base = { index: 5, middle: 9, ring: 13, pinky: 17 };
  const P = (x, y) => ({ x, y });
  for (const f of Object.keys(ox)) {
    const b = base[f];
    lm[b] = P(wx + ox[f], wy - 0.15);
    lm[b + 1] = P(wx + ox[f], wy - 0.22);
    lm[b + 2] = P(wx + ox[f], ext[f] ? wy - 0.29 : wy - 0.19);
    lm[b + 3] = P(wx + ox[f], ext[f] ? wy - 0.35 : wy - 0.14); // tip: far if ext, curled back if folded
  }
  lm[1] = P(wx - 0.05, wy - 0.04); lm[2] = P(wx - 0.08, wy - 0.08);
  lm[3] = P(thumb ? wx - 0.12 : wx - 0.04, wy - 0.1); lm[4] = P(thumb ? wx - 0.16 : wx - 0.03, wy - 0.12);
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return lm.map((p) => ({ x: wx + (p.x - wx) * c - (p.y - wy) * s, y: wy + (p.x - wx) * s + (p.y - wy) * c }));
}
const T = { index: true, middle: false, ring: false, pinky: false };
const cases = {
  rock: hand({ ext: { index: true, pinky: true } }),
  rock_thumb: hand({ ext: { index: true, pinky: true }, thumb: true }),
  fist: hand({ ext: {} }),
  open: hand({ ext: { index: true, middle: true, ring: true, pinky: true } }),
  point_up: hand({ ext: T }),
  point_down: hand({ ext: T, deg: 180 }),
  point_side: hand({ ext: T, deg: 90 }),
  peace: hand({ ext: { index: true, middle: true } }),
};
let fail = 0;
const expect = { rock: 'rock', rock_thumb: 'rock', fist: 'fist', open: 'open', point_up: 'point_up', point_down: 'point_down', point_side: 'point_side', peace: 'other' };
for (const [k, lm] of Object.entries(cases)) {
  const got = classifyHand(lm, 1.333).pose;
  const ok = got === expect[k]; if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', k.padEnd(11), '->', got);
}

// ---- controller scenario (video 4:3) ----
const asp = 4 / 3;
const face = (cx, cy = 0.35) => ({ x1: cx - 0.07, y1: cy - 0.1, x2: cx + 0.07, y2: cy + 0.1 });
const run = (name, ctl, frames, mk) => {
  const out = []; let t = ctl._t || 1000;
  for (let i = 0; i < frames; i++, t += 33) { const r = ctl.update({ ...mk(i), asp, now: t }); out.push(r); }
  ctl._t = t; return out;
};
const ctl = new GestureController({ arm: 'rock' });
const A = face(0.3), B = face(0.92); // two people; A is operator
const rockNearA = hand({ wx: 0.28, wy: 0.9, ext: { index: true, pinky: true } });
let o = run('arm', ctl, 30, () => ({ faces: [A, B], hands: [rockNearA] }));
const locked = o.find((r) => r.event === 'locked');
const chk = (label, ok) => { console.log(ok ? 'PASS' : 'FAIL', label); if (!ok) fail++; };
chk('rock held ~0.7s locks', !!locked);
chk('locks on face A (not B)', Math.abs(ctl.op.x / asp - 0.3) < 0.01);
// hand to raw-right of A (x bigger), open
const openRight = hand({ wx: 0.3 + 0.28, wy: 0.6, ext: { index: true, middle: true, ring: true, pinky: true } });
o = run('pan', ctl, 40, () => ({ faces: [A, B], hands: [openRight] }));
const cmds = o.filter((r) => r.cmd).map((r) => r.cmd.dir);
chk('open hand right of face -> "right" pulses (' + cmds.join(',') + ')', cmds.length >= 2 && cmds.every((d) => d === 'right'));
const openLeft = hand({ wx: 0.3 - 0.28, wy: 0.6, ext: { index: true, middle: true, ring: true, pinky: true } });
o = run('panL', ctl, 25, () => ({ faces: [A, B], hands: [openLeft] }));
chk('hand left of face -> "left"', o.some((r) => r.cmd?.dir === 'left'));
const pUp = hand({ wx: 0.3, wy: 0.75, ext: T });
o = run('up', ctl, 25, () => ({ faces: [A, B], hands: [pUp] }));
chk('point up -> "up"', o.some((r) => r.cmd?.dir === 'up'));
const pDown = hand({ wx: 0.3, wy: 0.75, ext: T, deg: 180 });
o = run('down', ctl, 25, () => ({ faces: [A, B], hands: [pDown] }));
chk('point down -> "down"', o.some((r) => r.cmd?.dir === 'down'));
// other person's hand (near B) must be ignored while locked on A
const openNearB = hand({ wx: 0.97, wy: 0.6, ext: { index: true, middle: true, ring: true, pinky: true } });
o = run('ignoreB', ctl, 25, () => ({ faces: [A, B], hands: [openNearB] }));
chk("another person's hand is ignored", o.every((r) => !r.cmd));
// hand in deadzone beside face -> no move
const openClose = hand({ wx: 0.3 + 0.1, wy: 0.6, ext: { index: true, middle: true, ring: true, pinky: true } });
o = run('dead', ctl, 25, () => ({ faces: [A, B], hands: [openClose] }));
chk('hand close to face (deadzone) -> no move', o.every((r) => !r.cmd));
// invert
ctl.configure({ invertPan: true });
o = run('inv', ctl, 25, () => ({ faces: [A, B], hands: [openRight] }));
chk('invertPan flips right->left', o.some((r) => r.cmd?.dir === 'left') && !o.some((r) => r.cmd?.dir === 'right'));
ctl.configure({ invertPan: false });
// unlock by rock again
o = run('unlock', ctl, 40, () => ({ faces: [A, B], hands: [rockNearA] }));
chk('rock again unlocks', o.some((r) => r.event === 'unlocked-gesture') && ctl.state === 'idle');
// lost face -> unlock
const c2 = new GestureController();
run('arm2', c2, 30, () => ({ faces: [A], hands: [rockNearA] }));
o = run('lost', c2, 60, () => ({ faces: [], hands: [] }));
chk('operator face gone 1.5s -> unlock', o.some((r) => r.event === 'unlocked-lost'));
// fist as arm gesture
const c3 = new GestureController({ arm: 'fist' });
o = run('fistarm', c3, 30, () => ({ faces: [A], hands: [hand({ wx: 0.28, wy: 0.9, ext: {} })] }));
chk('arm=fist: fist locks', o.some((r) => r.event === 'locked'));
const c4 = new GestureController({ arm: 'fist' });
o = run('rock-with-fist-arm', c4, 30, () => ({ faces: [A], hands: [rockNearA] }));
chk('arm=fist: rock does NOT lock', !o.some((r) => r.event === 'locked'));
// rock far from any face never locks
const c5 = new GestureController();
o = run('far', c5, 30, () => ({ faces: [A], hands: [hand({ wx: 0.95, wy: 0.9, ext: { index: true, pinky: true } })] }));
chk('rock far from a face does not lock', !o.some((r) => r.event === 'locked'));
// roll filter: unauthorised face (allowed:false) never locks, authorised face does
const c6 = new GestureController();
o = run('notallowed', c6, 30, () => ({ faces: [{ ...A, allowed: false }], hands: [rockNearA] }));
chk('allowed:false face cannot lock', !o.some((r) => r.event === 'locked'));
const c7 = new GestureController();
o = run('allowed', c7, 30, () => ({ faces: [{ ...A, allowed: true }], hands: [rockNearA] }));
chk('allowed:true face locks', o.some((r) => r.event === 'locked'));
const c8 = new GestureController();
o = run('othersHand', c8, 30, () => ({ faces: [{ ...A, allowed: true }, { ...B, allowed: false }], hands: [hand({ wx: 0.97, wy: 0.9, ext: { index: true, pinky: true } })] }));
chk('rock near unauthorised face (B) cannot lock A', !o.some((r) => r.event === 'locked'));
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS'); process.exit(fail ? 1 : 0);
