import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { listFaces, renameStudent, deleteStudent } from '../lib/api';
import { useAuth } from '../lib/auth.jsx';
import './FormPage.css';
import './Roster.css';

export default function Config() {
  const { isTeacher, isDeveloper, role, email, signOut } = useAuth();
  const [faces, setFaces] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // name currently being renamed
  const [draft, setDraft] = useState('');

  function refresh() {
    listFaces()
      .then(setFaces)
      .catch((err) => setError(err.message || 'Could not load the roster.'));
  }

  useEffect(() => {
    if (isTeacher) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher]);

  if (!isTeacher) {
    return <Navigate to="/login" replace />;
  }

  function startRename(name) {
    setEditing(name);
    setDraft(name);
    setNotice('');
    setError('');
  }

  async function commitRename(oldName) {
    if (!draft.trim() || draft.trim() === oldName) {
      setEditing(null);
      return;
    }
    try {
      await renameStudent(oldName, draft.trim());
      setNotice(`Renamed ${oldName} → ${draft.trim()}`);
      setEditing(null);
      refresh();
    } catch (err) {
      setError(err.message || 'Rename failed.');
    }
  }

  async function handleDelete(name) {
    if (!window.confirm(`Permanently remove ${name} and their photo? This can't be undone.`)) return;
    try {
      await deleteStudent(name);
      setNotice(`Removed ${name} from the roster.`);
      refresh();
    } catch (err) {
      setError(err.message || 'Delete failed.');
    }
  }

  return (
    <div className="container form-page">
      <div className="form-page-head roster-head">
        <div>
          <span className="hero-eyebrow">Configuration</span>
          <h1>Manage the roster</h1>
          <p>
            Signed in as <strong style={{ color: 'var(--amber)' }}>{email}</strong> ({role}).{' '}
            {isDeveloper
              ? 'Developer access: rename or permanently delete any student.'
              : 'Teacher access: rename students. Deleting requires a developer account.'}
          </p>
        </div>
        <button className="btn btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert">{notice}</div>}

      {faces && faces.length === 0 && (
        <div className="empty-state card">Nobody's enrolled yet. Enroll a face first.</div>
      )}

      {faces && faces.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Photo</th>
                <th>Name</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {faces.map((f) => (
                <tr key={f.name}>
                  <td style={{ width: 56 }}>
                    <img
                      src={f.image_url}
                      alt={f.name}
                      style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 2 }}
                    />
                  </td>
                  <td style={{ fontFamily: 'var(--font-body)' }}>
                    {editing === f.name ? (
                      <input
                        type="text"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(f.name);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        style={{
                          background: 'var(--bg-raised)',
                          border: '1px solid var(--line-strong)',
                          color: 'var(--ink)',
                          padding: '6px 10px',
                          fontFamily: 'var(--font-body)'
                        }}
                      />
                    ) : (
                      f.name
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      {editing === f.name ? (
                        <>
                          <button className="btn btn-amber" onClick={() => commitRename(f.name)}>
                            Save
                          </button>
                          <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-outline" onClick={() => startRename(f.name)}>
                          Rename
                        </button>
                      )}
                      {isDeveloper && (
                        <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(f.name)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
