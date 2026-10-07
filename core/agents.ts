import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { JobAgent, MasterCli } from '../shared/types'
import { scrubSecrets } from './discord'
import { listChildSessions, listSessionMessages, type ChildSession } from './opencode'
import { claudeProjectsDir } from './paths'
import type { Store } from './store'
import { encodeProjectDir } from './transcripts'

export interface ReaderFs {
  list(dir: string): string[]
  read(file: string): string | null
  mtime(file: string): number | null
}

export const realReaderFs: ReaderFs = {
  list: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  read: (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  mtime: (file) => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return null
    }
  },
}

export interface AgentSource {
  cli: MasterCli
  cwd: string
  sessionId: string
}

export interface ReaderDeps {
  store: Store
  fs?: ReaderFs
  projectsDir?: () => string
  children?: (sessionId: string) => Promise<ChildSession[]>
  messages?: (sessionId: string) => Promise<unknown[]>
  now?: () => number
}

interface Seen {
  ref: string
  seat: string
  model: string
  done: boolean
  // Last write time of the transcript, when known: a quiet one is taken as finished.
  touched: number | null
}

// A subagent that wrote nothing for this long (while its job still works) is shown as done.
const QUIET_MS = 60_000

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseJsonl(text: string): Obj[] {
  const out: Obj[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(obj(JSON.parse(line)))
    } catch {
      // a half-written or foreign line is skipped
    }
  }
  return out
}

// What one subagent's transcript lines say: its model and whether it ended its turn.
function summarize(lines: Obj[]): { model: string; seat: string; done: boolean } {
  let model = ''
  let seat = ''
  let done = false
  for (const l of lines) {
    seat ||= str(l.agentType) || str(l.subagent_type) || str(l.agentName)
    const m = obj(l.message)
    if (l.type === 'assistant' || m.role === 'assistant') {
      if (str(m.model) && str(m.model) !== '<synthetic>') model = str(m.model)
      // One reply is split over several lines and only some carry the stop reason: it is never un-set by a later null.
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') done = true
    } else if (l.type === 'user' || m.role === 'user') done = false
  }
  return { model, seat, done }
}

const LOG_MAX_LINES = 200
const LOG_MAX_LINE = 600
const LOG_MAX_BYTES = 64_000

// Token-shaped text removed from a log line before it leaves core.
export function scrubLogLine(text: string): string {
  return scrubSecrets(text)
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [secret]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[secret]')
}

const clip = (s: string): string => (s.length > LOG_MAX_LINE ? `${s.slice(0, LOG_MAX_LINE)}...` : s)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// The text of a content field of unknown shape: a string, or blocks with text / content.
function textOf(v: unknown, depth = 0): string {
  if (typeof v === 'string') return v
  if (depth > 4 || !v || typeof v !== 'object') return ''
  if (Array.isArray(v)) return v.map((x) => textOf(x, depth + 1)).filter(Boolean).join(' ')
  const o = obj(v)
  return str(o.text) || textOf(o.content, depth + 1)
}

// Plain-text lines for one transcript entry (a Claude jsonl line or an OpenCode message); [] when it says nothing.
export function logLines(entry: unknown): string[] {
  const l = obj(entry)
  const m = Object.keys(obj(l.message)).length ? obj(l.message) : l
  const role = str(m.role) || str(l.type) || 'agent'
  const content = m.content ?? m.parts ?? m.text
  const out: string[] = []
  const blocks = Array.isArray(content) ? content : [content]
  for (const raw of blocks) {
    if (typeof raw === 'string') {
      if (raw.trim()) out.push(`${role}: ${oneLine(raw)}`)
      continue
    }
    const b = obj(raw)
    const type = str(b.type)
    if (type === 'tool_use' || type === 'tool') {
      const input = b.input ?? obj(b.state).input
      out.push(`tool: ${str(b.name) || str(b.tool) || 'tool'}${input && Object.keys(obj(input)).length ? ` ${oneLine(JSON.stringify(input))}` : ''}`)
    } else if (type === 'tool_result') {
      const t = oneLine(textOf(b.content))
      if (t) out.push(`result: ${t}`)
    } else if (type === 'thinking' || type === 'reasoning') {
      continue
    } else {
      const t = oneLine(textOf(b))
      if (t) out.push(`${role}: ${t}`)
    }
  }
  return out.map((s) => clip(scrubLogLine(s)))
}

// The last lines of a list, capped by count and by total size.
function capTail(lines: string[]): string[] {
  const tail = lines.slice(-LOG_MAX_LINES)
  let bytes = 0
  let start = tail.length
  while (start > 0 && bytes + tail[start - 1]!.length <= LOG_MAX_BYTES) bytes += tail[--start]!.length
  return tail.slice(start)
}

// Reads a job's subagents from the CLI's own activity into job_agents. Shapes are not documented, so every
// field is optional and an unknown shape yields no agents rather than an error. Never throws.
export class SubagentReader {
  private readonly fs: ReaderFs
  private readonly projectsDir: () => string
  private readonly children: (sessionId: string) => Promise<ChildSession[]>
  private readonly messages: (sessionId: string) => Promise<unknown[]>
  private readonly now: () => number

  constructor(private readonly d: ReaderDeps) {
    this.fs = d.fs ?? realReaderFs
    this.projectsDir = d.projectsDir ?? (() => claudeProjectsDir())
    this.children = d.children ?? ((id) => listChildSessions(id))
    this.messages = d.messages ?? ((id) => listSessionMessages(id))
    this.now = d.now ?? Date.now
  }

  private claude(src: AgentSource): Seen[] {
    const dir = join(this.projectsDir(), encodeProjectDir(src.cwd), src.sessionId)
    const seen: Seen[] = []
    const sub = join(dir, 'subagents')
    const metas = new Map<string, Obj>()
    for (const f of this.fs.list(sub)) {
      if (!f.endsWith('.meta.json')) continue
      try {
        metas.set(f.slice(0, -'.meta.json'.length), obj(JSON.parse(this.fs.read(join(sub, f)) ?? '')))
      } catch {
        // unreadable meta: the transcript still names the agent
      }
    }
    for (const f of this.fs.list(sub)) {
      if (!f.endsWith('.jsonl')) continue
      const file = join(sub, f)
      const text = this.fs.read(file)
      if (text == null) continue
      const id = f.slice(0, -'.jsonl'.length)
      const s = summarize(parseJsonl(text))
      const meta = metas.get(id) ?? {}
      seen.push({ ref: `claude:${src.sessionId}:${id}`, seat: str(meta.agentType) || s.seat || id, model: str(meta.model) || s.model, done: s.done, touched: this.fs.mtime(file) })
    }
    // Older Claude versions write subagent turns into the main transcript, flagged isSidechain.
    const main = this.fs.read(`${dir}.jsonl`)
    if (main && !seen.length) {
      const groups = new Map<string, Obj[]>()
      for (const l of parseJsonl(main)) {
        if (l.isSidechain !== true) continue
        const id = str(l.agentId) || 'sidechain'
        groups.set(id, [...(groups.get(id) ?? []), l])
      }
      for (const [id, lines] of groups) {
        const s = summarize(lines)
        seen.push({ ref: `claude:${src.sessionId}:${id}`, seat: s.seat || id, model: s.model, done: s.done, touched: this.fs.mtime(`${dir}.jsonl`) })
      }
    }
    return seen
  }

  private async opencode(src: AgentSource): Promise<Seen[]> {
    const list = await this.children(src.sessionId).catch(() => [])
    return list.filter((c) => c.id).map((c) => ({ ref: `opencode:${c.id}`, seat: c.agent || c.title || c.id, model: c.model ?? '', done: c.done ?? false, touched: null }))
  }

  // The tail of one agent's transcript as plain lines. Never throws; an unreadable or unknown one gives [].
  async log(agentId: number, cwd: string): Promise<string[]> {
    try {
      const agent = this.d.store.getJobAgent(agentId)
      const ref = agent?.transcriptRef ?? ''
      const [cli, ...rest] = ref.split(':')
      if (cli === 'opencode') return capTail((await this.messages(rest.join(':'))).flatMap(logLines))
      if (cli !== 'claude' || rest.length < 2) return []
      const sessionId = rest[0]!
      const id = rest.slice(1).join(':')
      const dir = join(this.projectsDir(), encodeProjectDir(cwd), sessionId)
      const own = this.fs.read(join(dir, 'subagents', `${id}.jsonl`))
      if (own != null) return capTail(parseJsonl(own).flatMap(logLines))
      const main = this.fs.read(`${dir}.jsonl`) ?? ''
      return capTail(parseJsonl(main).filter((l) => l.isSidechain === true && (str(l.agentId) || 'sidechain') === id).flatMap(logLines))
    } catch {
      return []
    }
  }

  // One pass. `final` marks every agent done (the job ended). Returns the job's agents after the pass.
  async sync(runId: number, src: AgentSource, final = false): Promise<JobAgent[]> {
    const { store } = this.d
    try {
      const seen = src.cli === 'claude' ? this.claude(src) : await this.opencode(src)
      const known = new Map(store.listJobAgents(runId).map((a) => [a.transcriptRef, a]))
      for (const s of seen) {
        const quiet = s.touched != null && this.now() - s.touched > QUIET_MS
        const status = final || s.done || quiet ? 'done' : 'working'
        const have = known.get(s.ref)
        if (!have) store.addJobAgent(runId, { seat: s.seat, model: s.model, status, transcriptRef: s.ref })
        else {
          if (have.status !== status && have.status !== 'done') store.setJobAgentStatus(have.id, status)
          if (!have.model && s.model) store.setJobAgentModel(have.id, s.model)
        }
      }
      if (final) for (const a of store.listJobAgents(runId)) if (a.status !== 'done') store.setJobAgentStatus(a.id, 'done')
    } catch {
      // reading is best effort
    }
    return store.listJobAgents(runId)
  }
}
