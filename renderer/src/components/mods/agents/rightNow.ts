import { baseName, toolTarget, type ChatItem, type DiffFile, type ToolItem, type TurnStatus } from '@shared/claude-chat'

// The "Right now" card: what Claude is doing and which files this session touched. Everything comes from the chat stream
// (tool items, turn items) and from git's changed-file list; nothing is guessed.

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

// The file a tool works on: the file path of a read or an edit, the search root of a search ('' when none).
export function fileOfTool(name: string, input: unknown): string {
  const i = rec(input)
  if (EDIT_TOOLS.has(name) || READ_TOOLS.has(name)) return text(i.file_path) || text(i.notebook_path)
  if (SEARCH_TOOLS.has(name)) return text(i.path)
  return ''
}

// The folder a path sits in, by its last segment ('' when the path has none).
export function folderOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 1 ? (parts[parts.length - 2] ?? '') : ''
}

export interface RightNow {
  headline: string
  subline: string
  // Lines added and removed by the last edit, when the tool diff is known.
  diff: { added: number; removed: number } | null
}

export interface TouchedFile {
  path: string
  name: string
  // Edited wins over read: the file's colour is orange once Claude edited it.
  kind: 'read' | 'edited'
  // The file has uncommitted changes in git.
  uncommitted: boolean
}

const isRunning = (t: ToolItem) => t.status === 'running' || t.status === 'preparing'
const tools = (items: ChatItem[]): ToolItem[] => items.filter((i): i is ToolItem => i.kind === 'tool')

// Whether the session has ever read or edited a file (the subline falls back to "no files touched yet" otherwise).
function hasFileCalls(items: ChatItem[]): boolean {
  return tools(items).some((t) => READ_TOOLS.has(t.name) || EDIT_TOOLS.has(t.name))
}

// The file named by the most recent file tool call, for "last: <file>".
function lastFileName(items: ChatItem[]): string {
  const list = tools(items).filter((t) => READ_TOOLS.has(t.name) || EDIT_TOOLS.has(t.name))
  const last = list[list.length - 1]
  return last ? baseName(fileOfTool(last.name, last.input)) : ''
}

// Edit items after the last finished model turn (the turn that just ended).
function editsOfLastTurn(items: ChatItem[]): ToolItem[] {
  let start = 0
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'turn') {
      start = i + 1
      break
    }
  }
  return items.slice(start).filter((i): i is ToolItem => i.kind === 'tool' && EDIT_TOOLS.has(i.name) && !!fileOfTool(i.name, i.input))
}

// The headline and subline of the card. `turn` is the chat state's turn status.
export function rightNowHeadline(items: ChatItem[], turn: Pick<TurnStatus, 'phase' | 'pendingCount' | 'pendingLabel'>): RightNow {
  const none = hasFileCalls(items) ? `last: ${lastFileName(items)}` : 'no files touched yet'
  if (turn.pendingCount > 0) return { headline: 'Waiting for you', subline: turn.pendingLabel ?? 'Claude needs your answer', diff: null }

  const running = tools(items).filter((t) => t.parent === null && isRunning(t)).pop()
  if (running) {
    const path = fileOfTool(running.name, running.input)
    const folder = folderOf(path)
    if (READ_TOOLS.has(running.name) || SEARCH_TOOLS.has(running.name)) {
      const target = path ? baseName(path) : toolTarget(running.name, running.input)
      return { headline: `Claude is reading ${target || 'files'}`, subline: folder ? `in ${folder}` : none, diff: null }
    }
    if (EDIT_TOOLS.has(running.name)) return { headline: `Claude is editing ${baseName(path) || 'a file'}`, subline: folder ? `in ${folder}` : none, diff: null }
    if (COMMAND_TOOLS.has(running.name)) return { headline: 'Claude is running a command', subline: toolTarget(running.name, running.input) || none, diff: null }
    return { headline: 'Claude is working', subline: toolTarget(running.name, running.input) || none, diff: null }
  }

  if (turn.phase === 'working') return { headline: 'Claude is thinking', subline: none, diff: null }

  const edits = editsOfLastTurn(items)
  if (edits.length > 0) {
    const paths = new Set(edits.map((e) => fileOfTool(e.name, e.input)))
    const last = edits[edits.length - 1]!
    const lastPath = fileOfTool(last.name, last.input)
    const diff: DiffFile | null = last.diff ?? null
    return {
      headline: `Claude edited ${paths.size} ${paths.size === 1 ? 'file' : 'files'}`,
      subline: baseName(lastPath),
      diff: diff ? { added: diff.added, removed: diff.removed } : null,
    }
  }
  return { headline: 'Claude is idle', subline: none, diff: null }
}

// Whether a file path is one of git's uncommitted paths (git paths are relative to the repository root).
export function isUncommitted(path: string, gitPaths: readonly string[]): boolean {
  const p = path.replace(/\\/g, '/')
  return gitPaths.some((g) => {
    const q = g.replace(/\\/g, '/')
    return p === q || p.endsWith(`/${q}`)
  })
}

// Every file the session read or edited, most recent first. Search tools are not files and are left out.
export function touchedFiles(items: ChatItem[], gitPaths: readonly string[] = []): TouchedFile[] {
  const seen = new Map<string, 'read' | 'edited'>()
  for (const t of tools(items)) {
    if (!READ_TOOLS.has(t.name) && !EDIT_TOOLS.has(t.name)) continue
    const path = fileOfTool(t.name, t.input)
    if (!path) continue
    const kind = EDIT_TOOLS.has(t.name) || seen.get(path) === 'edited' ? 'edited' : 'read'
    seen.delete(path)
    seen.set(path, kind)
  }
  return [...seen.entries()]
    .reverse()
    .map(([path, kind]) => ({ path, name: baseName(path), kind, uncommitted: isUncommitted(path, gitPaths) }))
}

// The legend list: at most `max` files, and how many more there are.
export function legendFiles(files: TouchedFile[], max = 5): { shown: TouchedFile[]; more: number } {
  return { shown: files.slice(0, max), more: Math.max(0, files.length - max) }
}
