import { Link } from 'react-router-dom';
import './Footer.css';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container site-footer-inner">
        <span>© {new Date().getFullYear()} Presence — local face recognition.</span>
        <Link to="/terms">Terms &amp; Conditions</Link>
      </div>
    </footer>
  );
}
