import { POSE_LABEL } from '../lib/gesture';
import './GesturePanel.css';

const ARROW = { up: '↑', down: '↓', left: '←', right: '→' };

/** Gesture-control card: on/off, arm gesture, invert toggles, helper link, test pad, live status. */
export default function GesturePanel({ on, setOn, cfg, setCfg, g, ptz, url, setUrl, onTest, handEngine }) {
  const locked = g.state === 'locked';
  const helper = ptz.connected ? (ptz.ready ? 'ok' : 'warn') : 'bad';
  const helperText = !ptz.connected ? 'helper offline' : ptz.ready ? `camera: ${ptz.backend}` : 'camera not ready';

  return (
    <div className="gp">
      <div className="gp-head">
        <label className="gp-switch">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span>Gesture camera control</span>
        </label>
        <span className={`gp-pill ${helper}`}>{helperText}</span>
      </div>

      {on && (
        <>
          <div className={`gp-status ${locked ? 'locked' : ''}`}>
            {(handEngine === 'loading' || handEngine === 'off') && 'loading hand engine… (needs the face engine first)'}
            {handEngine === 'error' && 'hand engine failed to load (internet needed on first load)'}
            {handEngine === 'ready' &&
              (locked ? (
                <>
                  <b>LOCKED</b> on your face
                  {g.pose ? ` · ${POSE_LABEL[g.pose] || g.pose}` : ''}
                  {g.key ? ` → camera ${ARROW[g.key]} ${g.key}` : ''}
                </>
              ) : (
                <>
                  Show {cfg.arm === 'fist' ? '✊ a fist' : '🤘 the rock sign'} next to your face for a second to lock
                  {g.pose ? ` · seeing ${POSE_LABEL[g.pose] || g.pose}` : ''}
                </>
              ))}
          </div>

          <ul className="gp-help">
            <li>
              <b>Lock / unlock</b>: hold {cfg.arm === 'fist' ? '✊ fist' : '🤘 rock'} beside your face
            </li>
            <li>
              <b>Pan</b>: open hand clearly to the left / right of your face
            </li>
            <li>
              <b>Tilt</b>: one finger pointing ☝ up or 👇 down
            </li>
          </ul>

          <div className="gp-row">
            <label className="gp-label" htmlFor="gp-arm">
              Lock gesture
            </label>
            <select id="gp-arm" className="gp-select" value={cfg.arm} onChange={(e) => setCfg({ ...cfg, arm: e.target.value })}>
              <option value="rock">🤘 rock sign</option>
              <option value="fist">✊ fist</option>
            </select>
            <label className="gp-check">
              <input type="checkbox" checked={cfg.invertPan} onChange={(e) => setCfg({ ...cfg, invertPan: e.target.checked })} /> invert
              left/right
            </label>
            <label className="gp-check">
              <input type="checkbox" checked={cfg.invertTilt} onChange={(e) => setCfg({ ...cfg, invertTilt: e.target.checked })} /> invert
              up/down
            </label>
          </div>

          <div className="gp-row">
            <label className="gp-label" htmlFor="gp-url">
              Helper
            </label>
            <input id="gp-url" className="gp-input" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            <div className="gp-pad" role="group" aria-label="Test camera movement">
              <button type="button" className="gp-up" onClick={() => onTest('up')} aria-label="Test up">
                ↑
              </button>
              <button type="button" className="gp-left" onClick={() => onTest('left')} aria-label="Test left">
                ←
              </button>
              <button type="button" className="gp-right" onClick={() => onTest('right')} aria-label="Test right">
                →
              </button>
              <button type="button" className="gp-down" onClick={() => onTest('down')} aria-label="Test down">
                ↓
              </button>
            </div>
          </div>

          {ptz.err && <div className="gp-err">{ptz.err}</div>}
          {!ptz.connected && (
            <div className="gp-note">
              Start the helper on the camera PC: <code>bridge\start_ptz.bat</code>. Detection works without it, the camera just won&apos;t move.
            </div>
          )}
        </>
      )}
    </div>
  );
}
