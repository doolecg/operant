// Which way a terminal key press goes: to the app (a bound shortcut), a copy, a paste, or on to the PTY.
export type TermKeyAction = 'app' | 'copy' | 'paste' | 'terminal'

export interface TermKeyInput {
  mac: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  code: string
  hasSelection: boolean
  // The session is running, so a paste has somewhere to go.
  live: boolean
  // The press matches a rebindable app shortcut.
  bound: boolean
}

// Windows-style clipboard: Ctrl+C copies when there is a selection, Ctrl+V pastes. On macOS it is Cmd+C and Cmd+V,
// and Ctrl+C (interrupt) and Ctrl+V go through to the terminal.
export function decideTermKey(k: TermKeyInput): TermKeyAction {
  if (k.bound) return 'app'
  const clip = k.mac ? k.metaKey && !k.ctrlKey && !k.altKey : k.ctrlKey && !k.altKey
  if (clip && k.code === 'KeyC' && k.hasSelection) return 'copy'
  if (clip && k.code === 'KeyV' && k.live) return 'paste'
  return 'terminal'
}

// What an image on the clipboard types into the PTY so the agent CLI reads it itself.
// Claude Code reads Alt+V on Windows and Linux (Ctrl+V is its raw paste); elsewhere Ctrl+V.
export function imagePasteBytes(mac: boolean, claude: boolean): string {
  return !mac && claude ? '\x1bv' : '\x16'
}

// Absolute file paths (Windows drive or UNC, or Unix), ./ or ../ relative ones, and plain relative ones with a file
// extension (src/a.ts) in terminal output. A trailing :line or :line:col is part of the link text but not the path.
// Whether a path is really a file in the project is checked when it is opened, not here.
const FILE_LINKS: RegExp[] = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s"'<>|*?]+/g,
  /(?<![\w./~:@-])\/(?:[\w.@+-]+\/)+[\w.@+-]+(?::\d+){0,2}/g,
  /(?<![\w.:/\\])\.{1,2}[\\/][^\s"'<>|*?]+/g,
  /(?<![\w./\\~:@-])(?:[\w@+-][\w.@+-]*[\\/])+[\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}/g,
]

export interface FileLink {
  text: string
  // The path alone, without a :line[:col] suffix.
  path: string
  start: number
  end: number
}

export function findFileLinks(line: string): FileLink[] {
  const out: FileLink[] = []
  for (const re of FILE_LINKS) {
    for (const m of line.matchAll(re)) {
      const text = m[0].replace(/[.,;:)\]]+$/, '')
      const path = text.replace(/(?::\d+){1,2}$/, '')
      const start = m.index
      const end = start + text.length
      if (path.length < 3 || /^[a-z][a-z0-9+.-]+:\/\//i.test(path) || out.some((o) => start < o.end && end > o.start)) continue
      out.push({ text, path, start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// Dropped file paths typed into a prompt: quoted when they hold a space, joined by spaces.
export function dropText(paths: string[]): string {
  return paths
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ')
}
