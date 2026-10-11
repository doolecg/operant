// Things the embedded browser asks the user while a page loads or runs: JS dialogs, permission requests, basic-auth
// logins, certificate errors, and the downloads list. Types and pure helpers only; no Electron here.

export type BrowserPromptKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'permission' | 'auth' | 'certificate'

export interface BrowserPrompt {
  id: string
  crewId: number
  tabId: number
  kind: BrowserPromptKind
  // Where it comes from, for display: a URL origin ("https://example.com") or "proxy host:port".
  origin: string
  // Dialog text; for a certificate prompt, the error ("net::ERR_CERT_AUTHORITY_INVALID").
  message?: string
  // The prompt() field's starting text.
  defaultValue?: string
  // Electron's permission name ("geolocation", "media", ...) and its readable label.
  permission?: string
  permissionLabel?: string
  // The realm a basic-auth login names.
  realm?: string
}

// What the user answered. Dialogs: allow=true is OK, false is Cancel (value carries a prompt()'s text). Permissions:
// allow, plus remember. Auth: username and password; neither means Cancel. Certificates: proceed.
export interface BrowserPromptAnswer {
  allow?: boolean
  value?: string
  remember?: boolean
  username?: string
  password?: string
  proceed?: boolean
}

export type BrowserDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface BrowserDownload {
  id: string
  crewId: number
  url: string
  filename: string
  // The full path the file is saved to.
  path: string
  state: BrowserDownloadState
  received: number
  // 0 when the server did not say.
  total: number
}

// One crew's prompts and downloads, pushed whenever either changes.
export interface BrowserPromptsState {
  crewId: number
  prompts: BrowserPrompt[]
  downloads: BrowserDownload[]
}

export const EMPTY_PROMPTS_STATE = (crewId: number): BrowserPromptsState => ({ crewId, prompts: [], downloads: [] })

export const MAX_DOWNLOADS_PER_CREW = 30

export type PermissionPolicy = 'allow' | 'ask' | 'deny'

const ALLOWED = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write'])
const ASKED = new Set([
  'geolocation',
  'geolocation-approximate',
  'notifications',
  'media',
  'clipboard-read',
  'midi',
  'midiSysex',
  'idle-detection',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'local-fonts',
  'sensors',
])

// Harmless permissions are granted, the ones that reach the user's hardware or data are asked, the rest are refused.
export function permissionPolicy(permission: string): PermissionPolicy {
  if (ALLOWED.has(permission)) return 'allow'
  return ASKED.has(permission) ? 'ask' : 'deny'
}

const LABELS: Record<string, string> = {
  geolocation: 'know your location',
  'geolocation-approximate': 'know your approximate location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices with system exclusive messages',
  'idle-detection': 'know when you are idle',
  'speaker-selection': 'choose your audio output',
  'storage-access': 'use its cookies while embedded in another site',
  'top-level-storage-access': 'use its cookies on sites it is embedded in',
  'window-management': 'manage your windows and screens',
  'local-fonts': 'read the fonts installed on your computer',
  sensors: 'use your motion sensors',
}

// What the site wants to do, as a verb phrase ("use your camera and microphone"). mediaTypes comes from the request.
export function permissionLabel(permission: string, mediaTypes: readonly string[] = []): string {
  if (permission === 'media') {
    const video = mediaTypes.includes('video')
    const audio = mediaTypes.includes('audio')
    if (video && audio) return 'use your camera and microphone'
    if (video) return 'use your camera'
    if (audio) return 'use your microphone'
    return 'use your camera or microphone'
  }
  return LABELS[permission] ?? `use "${permission}"`
}

export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.origin !== 'null' ? u.origin : u.protocol
  } catch {
    return url
  }
}

// The key under which a remembered permission answer is stored.
export const permissionKey = (origin: string, permission: string, mediaTypes: readonly string[] = []): string =>
  `${origin}|${permission}${permission === 'media' ? `:${[...mediaTypes].sort().join('+')}` : ''}`

// The key of a certificate the user chose to proceed with: one host and one exact certificate.
export const certificateKey = (host: string, fingerprint: string): string => `${host.toLowerCase()}|${fingerprint}`

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g

// A file name that is safe to create in the downloads folder.
export function safeFileName(name: string): string {
  let n = name.replace(BAD_NAME_CHARS, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`
  return (n || 'download').slice(0, 150)
}

// "file.txt" -> "file (1).txt" -> "file (2).txt" until taken(name) is false.
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${String(i)})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${String(Date.now())})${ext}`
}

const RISKY_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'lnk', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'reg', 'cpl', 'msc', 'dll', 'sh', 'command', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'url', 'gadget',
])

// Files that must not be run by a click on Open: the user can still reveal them in the folder.
export function isRiskyFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && RISKY_EXT.has(name.slice(dot + 1).toLowerCase())
}

// 0..100, or null when the size is unknown.
export function downloadPercent(d: Pick<BrowserDownload, 'received' | 'total'>): number | null {
  if (d.total <= 0) return null
  return Math.max(0, Math.min(100, Math.floor((d.received / d.total) * 100)))
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${String(Math.round(n))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)} ${units[i] ?? 'TB'}`
}

export const isDownloadActive = (d: Pick<BrowserDownload, 'state'>): boolean => d.state === 'progressing'

// Adds a download, keeping the newest first and at most MAX_DOWNLOADS_PER_CREW (finished ones drop first).
export function capDownloads(list: readonly BrowserDownload[]): BrowserDownload[] {
  const out = [...list]
  while (out.length > MAX_DOWNLOADS_PER_CREW) {
    let i = out.length - 1
    while (i > 0 && isDownloadActive(out[i] as BrowserDownload)) i--
    out.splice(i, 1)
  }
  return out
}

// The heading and the prompt's own words, for the bar.
export function promptTitle(p: Pick<BrowserPrompt, 'kind' | 'origin' | 'permission' | 'permissionLabel' | 'realm'>): string {
  switch (p.kind) {
    case 'permission':
      return `${p.origin} wants to ${p.permissionLabel ?? `use "${p.permission ?? ''}"`}`
    case 'auth':
      return p.realm ? `${p.origin} asks you to sign in (${p.realm})` : `${p.origin} asks you to sign in`
    case 'certificate':
      return `The certificate of ${p.origin} cannot be trusted`
    case 'beforeunload':
      return `${p.origin} asks if you want to leave this page`
    default:
      return `${p.origin} says`
  }
}

// The oldest prompt of the tab that is showing; the next one follows its answer.
export function promptForTab(prompts: readonly BrowserPrompt[], tabId: number | null | undefined): BrowserPrompt | undefined {
  return tabId == null ? undefined : prompts.find((p) => p.tabId === tabId)
}
