// Keybinds are stored as accelerators like "Mod+Shift+P". Mod is Ctrl, or Cmd on macOS.

const isMac = () => window.operant?.platform === 'darwin'

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

function keyName(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  // e.code keeps digits and letters stable when Shift or Alt change e.key.
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5)
  if (e.key === ' ') return 'Space'
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}

export function eventToAccel(e: KeyboardEvent): string | null {
  const key = keyName(e)
  if (!key) return null
  const mod = isMac() ? e.metaKey : e.ctrlKey
  const parts = [mod && 'Mod', isMac() && e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
  return parts.filter(Boolean).join('+')
}

export const matches = (e: KeyboardEvent, accel: string) => !!accel && eventToAccel(e) === accel

export function formatAccel(accel: string): string {
  if (!accel) return 'Unbound'
  return accel
    .split('+')
    .map((p) => (p === 'Mod' ? (isMac() ? '⌘' : 'Ctrl') : p === 'Alt' && isMac() ? '⌥' : p === 'Shift' && isMac() ? '⇧' : p))
    .join(isMac() ? '' : '+')
}
