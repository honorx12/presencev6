import { Link } from 'react-router-dom';
import './Landing.css';

const STEPS = [
  {
    n: '01',
    title: 'Capture',
    body: 'A still frame comes in from a webcam snapshot or an uploaded photo — no special hardware required.'
  },
  {
    n: '02',
    title: 'Encode',
    body: 'Each face is reduced to a 128-point vector, the fingerprint a match is measured against.'
  },
  {
    n: '03',
    title: 'Match',
    body: 'The vector is compared to everyone on the roster. Closest distance under the threshold wins.'
  },
  {
    n: '04',
    title: 'Log',
    body: 'A confirmed match is timestamped straight into the access log — no manual entry.'
  }
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <div className="container hero-content">
          <span className="hero-eyebrow">Local face recognition, self-hosted</span>
          <h1>
            A face is the key.
            <br />
            Presence checks it in under a second.
          </h1>
          <p className="hero-lede">
            Enroll a roster of faces, verify anyone against it from a webcam or photo, and get an
            access log that fills itself in — running entirely on your own machine.
          </p>
          <div className="hero-actions">
            <Link to="/verify" className="btn btn-amber">
              Verify a face
            </Link>
            <Link to="/enroll" className="btn btn-outline">
              Enroll someone new
            </Link>
          </div>
        </div>
      </section>

      <section className="steps">
        <div className="container">
          <h2 className="section-title">How a match happens</h2>
          <div className="steps-grid">
            {STEPS.map((s) => (
              <div key={s.n} className="step">
                <span className="step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="cta-strip">
        <div className="container cta-inner">
          <div>
            <h2 className="section-title">Ready when your roster is.</h2>
            <p>Enroll a few faces, then hand the camera to anyone who needs checking in.</p>
          </div>
          <Link to="/roster" className="btn btn-outline">
            View roster
          </Link>
        </div>
      </section>
    </div>
  );
}
