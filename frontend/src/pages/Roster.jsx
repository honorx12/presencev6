import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listFaces } from '../lib/api';
import './Roster.css';

export default function Roster() {
  const [faces, setFaces] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listFaces()
      .then((f) => {
        setFaces(f);
        setError('');
      })
      .catch((err) => setError(err.message || 'Could not load the roster.'));
  }, []);

  // photos added/replaced directly in the Supabase dashboard show up without a manual page reload
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  return (
    <div className="container form-page">
      <div className="form-page-head roster-head">
        <div>
          <span className="hero-eyebrow">Roster</span>
          <h1>Everyone Presence can recognize</h1>
          <p>{faces ? `${faces.length} enrolled` : 'Loading…'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={load}>
            Refresh
          </button>
          <Link to="/enroll" className="btn btn-outline">
            Enroll someone
          </Link>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {faces && faces.length === 0 && (
        <div className="empty-state card">Nobody's enrolled yet. Add the first face to get started.</div>
      )}

      {faces && faces.length > 0 && (
        <div className="roster-grid">
          {faces.map((f) => (
            <div className="roster-card" key={f.name}>
              <div className="roster-photo">
                <img src={f.image_url} alt={f.name} />
              </div>
              <div className="roster-name">{f.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
