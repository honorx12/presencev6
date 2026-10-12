import './Toggle.css';

/**
 * Reusable toggle switch. Controlled component:
 * checked=true  -> "present" (right/on, amber)
 * checked=false -> "absent"  (left/off)
 */
export default function Toggle({ checked, onChange, disabled = false, labelOn = 'Present', labelOff = 'Absent' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`toggle${checked ? ' toggle-on' : ''}${disabled ? ' toggle-disabled' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      title={disabled ? 'Sign in to change attendance' : checked ? labelOn : labelOff}
    >
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{checked ? labelOn : labelOff}</span>
    </button>
  );
}
