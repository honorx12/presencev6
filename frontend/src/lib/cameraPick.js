// Virtual cameras (OBS etc.) show black when their source app is not running, so on a
// fresh browser the built-in webcam is the better default. The user can still pick
// the virtual camera in the dropdown; that choice is remembered.
export const VIRTUAL_RE = /\b(obs|virtual|snap camera|manycam|xsplit|nvidia broadcast)\b/i;

export const isVirtualLabel = (label = '') => VIRTUAL_RE.test(label);

/** first real (non-virtual) camera with a readable label, or null */
export function pickRealCamera(devices) {
  return devices.find((d) => d.kind === 'videoinput' && d.label && !isVirtualLabel(d.label)) || null;
}
