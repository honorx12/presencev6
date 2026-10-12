import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import CaptureInput from '../components/CaptureInput';
import { registerFace } from '../lib/api';
import { useAuth } from '../lib/auth.jsx';
import './FormPage.css';

export default function Enroll() {
  const { isTeacher } = useAuth();
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | saving | done | error
  const [message, setMessage] = useState('');

  function handleCapture(f, url) {
    setFile(f);
    setPreview(url);
    setStatus('idle');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !file) {
      setStatus('error');
      setMessage('Add a name and a clear, front-facing photo first.');
      return;
    }
    setStatus('saving');
    try {
      const res = await registerFace(name.trim(), file);
      setStatus('done');
      setMessage(`${res.registered} is on the roster now (${res.known_faces} total).`);
      setName('');
      setFile(null);
      setPreview(null);
    } catch (err) {
      setStatus('error');
      setMessage(err.message || 'Could not read a face in that photo — try a clearer, front-on shot.');
    }
  }

  if (!isTeacher) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="container form-page">
      <div className="form-page-head">
        <span className="hero-eyebrow">Enroll</span>
        <h1>Add someone to the roster</h1>
        <p>One clear, forward-facing photo is enough. Presence checks it can find a face before saving it.</p>
      </div>

      <div className="form-grid">
        <div className="card">
          <CaptureInput onCapture={handleCapture} previewUrl={preview} />
        </div>

        <form className="card form-side" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="name">Full name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              autoComplete="off"
            />
          </div>

          {status === 'error' && <div className="alert alert-error">{message}</div>}
          {status === 'done' && <div className="alert alert-success">{message}</div>}

          <div className="form-side-actions">
            <button type="submit" className="btn btn-amber" disabled={status === 'saving'}>
              {status === 'saving' ? <span className="spinner" /> : null}
              {status === 'saving' ? 'Saving…' : 'Add to roster'}
            </button>
            <Link to="/roster" className="btn btn-ghost">
              View roster
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
