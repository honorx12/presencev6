import { useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  getAttendanceRoster,
  setRosterStatus,
  exportAttendance,
  emailAttendance,
  sendAttendanceWhatsApp
} from '../lib/api';
import { useAuth } from '../lib/auth.jsx';
import './FormPage.css';
import './Log.css';
import './Dashboard.css';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

const LIVE_POLL_MS = 4000;

export default function Dashboard() {
  const { isTeacher, email } = useAuth();
  const date = today();

  const [rows, setRows] = useState(null);
  const [pending, setPending] = useState(new Map());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [live, setLive] = useState(true);
  const [waPhone, setWaPhone] = useState('');
  const [waOpen, setWaOpen] = useState(false);
  const pendingRef = useRef(pending);
  const busyRef = useRef(busy);
  pendingRef.current = pending;
  busyRef.current = busy;

  useEffect(() => {
    if (!isTeacher) return;
    getAttendanceRoster(date)
      .then(setRows)
      .catch((err) => setError(err.message || 'Could not load attendance.'));
  }, [isTeacher, date]);

  // Live refresh — as /verify recognizes faces, pull them in without a manual
  // reload, but never stomp a row the teacher is mid-edit on.
  useEffect(() => {
    if (!isTeacher || !live) return undefined;
    const id = setInterval(() => {
      if (busyRef.current !== '') return;
      getAttendanceRoster(date)
        .then((fresh) => {
          setRows((prev) => {
            if (!prev) return fresh;
            return fresh.map((row) => {
              if (pendingRef.current.has(row.name)) {
                const old = prev.find((r) => r.name === row.name);
                return old ? { ...row, status: old.status } : row;
              }
              return row;
            });
          });
        })
        .catch(() => {});
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [isTeacher, date, live]);

  if (!isTeacher) {
    return <Navigate to="/login" replace />;
  }

  function effectiveStatus(row) {
    return pending.has(row.name) ? pending.get(row.name) : row.status;
  }
  function setStatus(name, status) {
    setPending((prev) => new Map(prev).set(name, status));
  }

  const total = rows?.length || 0;
  const present = rows ? rows.filter((r) => effectiveStatus(r) === 'present').length : 0;
  const absent = total - present;
  const pct = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;

  async function handleSaveRow(name, status) {
    setBusy('saving');
    setError('');
    try {
      const updated = await setRosterStatus(name, date, status);
      setRows((prev) => prev.map((r) => (r.name === name ? { ...r, status: updated.status, id: updated.id, time: updated.time } : r)));
      setPending((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      setNotice(`${name} marked ${status}.`);
    } catch (err) {
      setError(err.message || 'Could not save that change.');
    } finally {
      setBusy('');
    }
  }

  async function handleExport() {
    setBusy('exporting');
    setError('');
    try {
      await exportAttendance(date);
      setNotice('Excel downloaded.');
    } catch (err) {
      setError(err.message || 'Could not export the sheet.');
    } finally {
      setBusy('');
    }
  }

  async function handleEmailOnly() {
    setBusy('emailing');
    setError('');
    try {
      const res = await emailAttendance(date);
      setNotice(`Emailed to ${res.sent_to}.`);
    } catch (err) {
      setError(err.message || 'Could not send the email.');
    } finally {
      setBusy('');
    }
  }

  function handleWhatsAppSend() {
    if (!waPhone.trim()) return;
    const summary = `Attendance — ${date}\nTotal: ${total}  Present: ${present}  Absent: ${absent} (${pct}%)\n\nExport the sheet on the dashboard and attach it here if needed.`;
    sendAttendanceWhatsApp(waPhone.trim(), date, summary);
    setWaOpen(false);
    setNotice('WhatsApp opened.');
  }

  return (
    <div className="container form-page dashboard-page">
      <div className="dashboard-head">
        <div>
          <span className="hero-eyebrow">Dashboard</span>
          <h1>
            {greeting()}, {email ? email.split('@')[0] : 'Teacher'}
          </h1>
          <p>
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            })}
          </p>
        </div>
        <label className="log-live-toggle" title="Auto-refresh as students are recognized">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <span className={`log-live-dot ${live ? 'log-live-dot-on' : ''}`} />
          Live
        </label>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: 20 }}>{notice}</div>}

      <div className="dashboard-cards">
        <div className="dashboard-card">
          <span className="dashboard-card-value">{present}</span>
          <span className="dashboard-card-label">Present today</span>
        </div>
        <div className="dashboard-card">
          <span className="dashboard-card-value">{total}</span>
          <span className="dashboard-card-label">Total students</span>
        </div>
        <div className="dashboard-card dashboard-card-absent">
          <span className="dashboard-card-value">{absent}</span>
          <span className="dashboard-card-label">Absent today</span>
        </div>
        <div className="dashboard-card">
          <span className="dashboard-card-value">{pct}%</span>
          <span className="dashboard-card-label">Attendance</span>
        </div>
        <Link to="/enroll" className="dashboard-card dashboard-card-action">
          <span className="dashboard-card-plus">+</span>
          <span className="dashboard-card-label">New student</span>
        </Link>
      </div>

      {rows && rows.length === 0 && (
        <div className="empty-state card">Nobody's enrolled yet — add students on the Roster page first.</div>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="dashboard-table-head">
            <h2>Today's attendance</h2>
            <Link to="/log" className="btn btn-outline btn-sm">
              Open calendar
            </Link>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <table className="table log-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>In time</th>
                  <th>Out time</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status = effectiveStatus(r);
                  const dirty = pending.has(r.name);
                  return (
                    <tr key={r.name} className={dirty ? 'log-row-dirty' : ''}>
                      <td style={{ fontFamily: 'var(--font-body)' }}>{r.name}</td>
                      <td>{r.time || '—'}</td>
                      <td>{r.out_time || '—'}</td>
                      <td>
                        <span className={`status-pill ${status === 'present' ? 'status-present' : 'status-absent'}`}>
                          {status}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== ''}
                          onClick={() => handleSaveRow(r.name, status === 'present' ? 'absent' : 'present')}
                        >
                          Mark {status === 'present' ? 'absent' : 'present'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="log-actions">
            <Link to="/enroll" className="btn btn-amber">
              + Register student
            </Link>
            <button type="button" className="btn btn-outline" onClick={() => setWaOpen((v) => !v)} disabled={busy !== ''}>
              Send attendance
            </button>
            <button type="button" className="btn btn-outline" onClick={handleExport} disabled={busy !== ''}>
              {busy === 'exporting' ? <span className="spinner" /> : null}
              Download Excel
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleEmailOnly} disabled={busy !== ''}>
              {busy === 'emailing' ? <span className="spinner" /> : null}
              Email only
            </button>
          </div>

          {waOpen && (
            <div className="card wa-panel">
              <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-dim)' }}>
                Choose how to send today's ({date}) attendance summary.
              </p>
              <label htmlFor="dash-wa-phone">WhatsApp number (with country code)</label>
              <div className="wa-panel-row">
                <input
                  id="dash-wa-phone"
                  type="tel"
                  placeholder="e.g. 919876543210"
                  value={waPhone}
                  onChange={(e) => setWaPhone(e.target.value)}
                />
                <button type="button" className="btn btn-amber" onClick={handleWhatsAppSend} disabled={!waPhone.trim()}>
                  Open WhatsApp
                </button>
              </div>
              <p className="wa-panel-note">
                WhatsApp will open with the attendance summary. Download the Excel file separately if you need to
                attach it — browsers can't silently attach files to a WhatsApp chat.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
