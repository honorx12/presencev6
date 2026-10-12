import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import './Nav.css';

const LINKS = [
  { to: '/verify', label: 'Verify' },
  { to: '/enroll', label: 'Enroll' },
  { to: '/roster', label: 'Roster' },
  { to: '/log', label: 'Access log' },
  { to: '/history', label: 'Calendar' }
];

export default function Nav() {
  const { isTeacher, role, email, signOut } = useAuth();

  return (
    <header className="nav">
      <div className="container nav-inner">
        <NavLink to="/" className="nav-brand">
          <span className="nav-brand-mark" />
          Presence
        </NavLink>
        <nav className="nav-links">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {l.label}
            </NavLink>
          ))}
          {isTeacher && (
            <NavLink to="/dashboard" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Dashboard
            </NavLink>
          )}
          {isTeacher && (
            <NavLink to="/config" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Config
            </NavLink>
          )}
        </nav>
        <div className="nav-auth">
          {isTeacher ? (
            <>
              <span className="nav-role">
                {email} · {role}
              </span>
              <button className="btn btn-ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <NavLink to="/login" className="btn btn-outline">
              Staff sign in
            </NavLink>
          )}
        </div>
      </div>
    </header>
  );
}
