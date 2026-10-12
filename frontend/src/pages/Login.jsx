import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login as loginApi } from '../lib/api';
import { useAuth } from '../lib/auth.jsx';
import './FormPage.css';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { setRole } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { role } = await loginApi(email.trim(), password);
      setRole(role);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container form-page login-page login-page-centered">
      <div className="login-card">
        <div className="form-page-head" style={{ marginBottom: 24 }}>
          <span className="hero-eyebrow">Staff access</span>
          <h1>Sign in</h1>
          <p>Teacher and developer accounts can override attendance and manage the roster.</p>
        </div>

        <form className="form-side" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-side-actions">
            <button className="btn btn-amber" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
