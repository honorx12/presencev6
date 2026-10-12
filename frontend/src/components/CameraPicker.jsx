import { useState } from 'react';
import './CameraPicker.css';

const LABEL = {
  idle: 'idle',
  starting: 'connecting…',
  live: 'live',
  black: 'black picture',
  frozen: 'frozen',
  stalled: 'reconnecting…',
  error: 'no camera'
};

/** Source dropdown (built-in webcam, OBS Virtual Camera, USB, ...), network-stream
 *  option, mirror toggle, reconnect button and a status line that explains problems. */
export default function CameraPicker({ cam }) {
  const [url, setUrl] = useState(cam.netUrl || 'http://localhost:8090/stream');
  const value = cam.source === 'url' ? '__url__' : cam.deviceId || '';

  function onSelect(e) {
    const v = e.target.value;
    if (v === '__url__') cam.useNetwork(url);
    else cam.setDeviceId(v);
  }

  return (
    <div className="campick">
      <div className="campick-row">
        <label className="campick-label" htmlFor="cam-src">
          Camera
        </label>
        <select id="cam-src" className="campick-select" value={value} onChange={onSelect}>
          <option value="">Default camera</option>
          {cam.devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Camera ${i + 1}`}
            </option>
          ))}
          <option value="__url__">Network camera (stream URL)…</option>
        </select>
        <span className={`campick-pill ${cam.status}`}>{LABEL[cam.status] || cam.status}</span>
      </div>

      {cam.source === 'url' && (
        <div className="campick-row">
          <input
            className="campick-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8090/stream"
            spellCheck={false}
          />
          <button type="button" className="btn btn-outline campick-btn" onClick={() => cam.useNetwork(url)}>
            Connect
          </button>
        </div>
      )}

      <div className="campick-row">
        <label className="campick-check">
          <input type="checkbox" checked={cam.mirror} onChange={(e) => cam.setMirror(e.target.checked)} /> Mirror
          picture
        </label>
        <button type="button" className="btn btn-ghost campick-btn" onClick={cam.reconnect}>
          Reconnect
        </button>
      </div>

      {cam.hint && <div className={`campick-hint ${cam.status}`}>{cam.hint}</div>}
    </div>
  );
}
