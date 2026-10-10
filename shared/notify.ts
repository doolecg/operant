// Decisions and wording for the close confirmations and the Windows "Claude is done" notifications. Pure, so the main
// process and the renderer agree and the rules are unit-tested.

export type TileKind = 'claude' | 'opencode' | 'shell'

// Closing a tile asks unless the owner turned that off, or the tile's process already ended (nothing to lose).
export function shouldConfirmTileClose(askEnabled: boolean, exited: boolean): boolean {
  return askEnabled && !exited
}

export interface RunningCounts {
  claude: number
  opencode: number
  shell: number
  // A Claude tile is in the middle of a turn.
  midTurn: boolean
}

// Closing Operant asks only when something is running and the owner has not turned the ask off.
export function shouldConfirmAppClose(askEnabled: boolean, counts: RunningCounts): boolean {
  return askEnabled && counts.claude + counts.opencode + counts.shell > 0
}

export function tileCloseCopy(p: { title: string; kind: TileKind; busy: boolean }): { title: string; body: string } {
  const what = p.kind === 'shell' ? 'The shell process will end.' : p.busy ? `${p.kind === 'claude' ? 'Claude' : 'OpenCode'} is still working and will be stopped.` : 'The session is saved and can be resumed.'
  return { title: 'Close this terminal?', body: `${p.title}. ${what}` }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function appCloseLines(counts: RunningCounts): string[] {
  const lines: string[] = []
  if (counts.claude > 0) lines.push(plural(counts.claude, 'Claude tile is running', 'Claude tiles are running'))
  if (counts.opencode > 0) lines.push(plural(counts.opencode, 'OpenCode tile is running', 'OpenCode tiles are running'))
  if (counts.shell > 0) lines.push(plural(counts.shell, 'shell is running', 'shells are running'))
  if (counts.midTurn) lines.push('Claude is mid-turn: that turn will be stopped.')
  lines.push('Running processes will be stopped. Claude sessions are saved and can be resumed.')
  return lines
}

export type NotifyKind = 'finished' | 'needs'

// A notification shows when its setting is on and the owner is not looking at that tile (the window is unfocused, or
// another tile is in front).
export function shouldNotify(p: { kind: NotifyKind; enabled: { finished: boolean; needs: boolean }; windowFocused: boolean; tileVisible: boolean }): boolean {
  if (!p.enabled[p.kind]) return false
  return !p.windowFocused || !p.tileVisible
}

export const NOTIFY_TEXT_MAX = 100

// The first non-empty line of a reply, whitespace collapsed and cut to NOTIFY_TEXT_MAX characters.
export function firstLine(text: string | null | undefined): string {
  const line = (text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > NOTIFY_TEXT_MAX ? `${flat.slice(0, NOTIFY_TEXT_MAX - 1).trimEnd()}…` : flat
}

export function notifyCopy(p: { kind: NotifyKind; name: string; detail: string }): { title: string; body: string } {
  const title = p.kind === 'finished' ? 'Claude is done' : 'Claude needs you'
  const detail = firstLine(p.detail) || (p.kind === 'finished' ? 'Finished its turn' : 'Waiting for you')
  return { title, body: `${p.name} · ${detail}` }
}
