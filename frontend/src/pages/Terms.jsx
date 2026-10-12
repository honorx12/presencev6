import './FormPage.css';

export default function Terms() {
  return (
    <div className="container form-page" style={{ maxWidth: 760 }}>
      <div className="form-page-head">
        <span className="hero-eyebrow">Legal</span>
        <h1>Terms &amp; Conditions</h1>
        <p>Please read before enrolling faces or using Presence to record attendance.</p>
      </div>

      <div className="form-side" style={{ gap: 24, fontFamily: 'var(--font-body)', color: 'var(--ink-dim)', lineHeight: 1.7 }}>
        <section>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>1. Purpose</h3>
          <p>
            Presence is an internal attendance tool. It captures a facial image, converts it to a numeric
            encoding, and compares it against an enrolled roster to mark students present. It is intended
            for use by authorized teachers and staff within this institution only.
          </p>
        </section>

        <section>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>2. Consent &amp; data use</h3>
          <p>
            Enrolling a student's photo requires appropriate consent under your institution's policy.
            Photos and derived face encodings are stored locally and used solely to compute attendance.
            They are not sent to any third party.
          </p>
        </section>

        <section>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>3. Manual overrides</h3>
          <p>
            Automated recognition can misfire — lighting, angle, or camera quality all affect accuracy.
            Teacher and developer accounts may manually toggle a record between Present and Absent; this
            action is final unless changed again by an authorized account.
          </p>
        </section>

        <section>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>4. Roles</h3>
          <p>
            <strong style={{ color: 'var(--ink)' }}>Teacher</strong> accounts may view logs, override
            attendance, and rename roster entries. <strong style={{ color: 'var(--ink)' }}>Developer</strong>{' '}
            accounts additionally have full access to add, rename, and permanently delete roster entries
            and attendance records.
          </p>
        </section>

        <section>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>5. No warranty</h3>
          <p>
            Presence is provided as-is for internal use. It is not a certified biometric security product and
            should not be relied on as the sole means of identity verification for safety-critical
            decisions.
          </p>
        </section>
      </div>
    </div>
  );
}
