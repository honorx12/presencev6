import { useEffect, useState } from 'react';
import { listFaces, getAttendanceHistory, sendAttendanceWhatsApp } from '../lib/api';
import { useAuth } from '../lib/auth.jsx';
import './FormPage.css';
import './Log.css';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function History() {
  const { isTeacher } = useAuth();
  const [faces, setFaces] = useState(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState(daysAgo(13)); // last 14 days by default
  const [end, setEnd] = useState(today());
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [waPhone, setWaPhone] = useState('');
  const [waOpen, setWaOpen] = useState(false);

  useEffect(() => {
    listFaces()
      .then((list) => {
        setFaces(list);
        if (list.length > 0) setName(list[0].name);
      })
      .catch((err) => setError(err.message || 'Could not load the roster.'));
  }, []);

  useEffect(() => {
    if (!isTeacher || !name) return;
    setRows(null);
    setError('');
    getAttendanceHistory(name, start, end)
      .then(setRows)
      .catch((err) => setError(err.message || 'Could not load attendance history.'));
  }, [isTeacher, name, start, end]);

  const presentDays = rows ? rows.filter((r) => r.status === 'present').length : 0;
  const totalDays = rows ? rows.length : 0;

  function handleWhatsAppSend() {
    if (!waPhone.trim() || !rows) return;
    const lines = rows
      .slice(0, 15)
      .map((r) => `${r.date}: ${r.time || '—'} → ${r.out_time || '—'} (${r.status})`)
      .join('\n');
    const summary = `Attendance history for ${name}\n${start} to ${end}\nPresent: ${presentDays}/${totalDays}\n\n${lines}`;
    sendAttendanceWhatsApp(waPhone.trim(), `${start} to ${end}`, summary);
    setWaOpen(false);
  }

  if (!isTeacher) {
    return (
      <div className="container form-page">
        <div className="form-page-head">
          <span className="hero-eyebrow">Calendar</span>
          <h1>Attendance history</h1>
        </div>
        <div className="alert">
          Staff only. <a href="/login">Sign in as teacher or developer</a> to look up a student's history.
        </div>
      </div>
    );
  }

  return (
    <div className="container form-page">
      <div className="form-page-head roster-head">
        <div>
          <span className="hero-eyebrow">Calendar</span>
          <h1>Attendance history</h1>
          <p>Pick a student and a date range to see when they checked in and out.</p>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="card history-filters">
        <div className="field">
          <label htmlFor="hist-student">Student</label>
          <select id="hist-student" value={name} onChange={(e) => setName(e.target.value)}>
            {(faces || []).map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="hist-start">From</label>
          <input id="hist-start" type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="hist-end">To</label>
          <input id="hist-end" type="date" value={end} max={today()} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>

      {faces && faces.length === 0 && (
        <div className="empty-state card">Nobody's enrolled yet — add students on the Roster page first.</div>
      )}

      {rows && (
        <>
          <div className="log-stats">
            <div className="log-stat">
              <span className="log-stat-value">{totalDays}</span>
              <span className="log-stat-label">Days with a record</span>
            </div>
            <div className="log-stat log-stat-present">
              <span className="log-stat-value">{presentDays}</span>
              <span className="log-stat-label">Present</span>
            </div>
            <div className="log-stat log-stat-absent">
              <span className="log-stat-value">{totalDays - presentDays}</span>
              <span className="log-stat-label">Absent</span>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <table className="table log-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>In time</th>
                  <th>Out time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--ink-faint)', padding: '24px 0' }}>
                      No records in this range.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.date}>
                    <td style={{ fontFamily: 'var(--font-body)' }}>{r.date}</td>
                    <td>{r.time || '—'}</td>
                    <td>{r.out_time || '—'}</td>
                    <td>
                      <span className={`status-pill ${r.status === 'present' ? 'status-present' : 'status-absent'}`}>
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="log-actions">
            <button type="button" className="btn btn-outline" onClick={() => setWaOpen((v) => !v)}>
              Send via WhatsApp
            </button>
          </div>

          {waOpen && (
            <div className="card wa-panel">
              <label htmlFor="hist-wa-phone">WhatsApp number (with country code)</label>
              <div className="wa-panel-row">
                <input
                  id="hist-wa-phone"
                  type="tel"
                  placeholder="e.g. 919876543210"
                  value={waPhone}
                  onChange={(e) => setWaPhone(e.target.value)}
                />
                <button type="button" className="btn btn-amber" onClick={handleWhatsAppSend} disabled={!waPhone.trim()}>
                  Open WhatsApp
                </button>
              </div>
              <p className="wa-panel-note">Sends a text summary of the table above (first 15 rows).</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
