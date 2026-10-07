import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JobAgent, MasterCli, Run } from '../shared/types'
import { claudeProjectsDir } from './paths'
import { costUsd, isPriced } from './pricing'
import type { Store } from './store'
import { JsonlTail, encodeProjectDir, parseLine } from './transcripts'

// What Operant needs from an OpenCode message: a finished assistant turn and its token counts.
export interface OpenCodeTurn {
  id: string
  at: number
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export const openCodeDbPath = (home = homedir()): string => join(home, '.local', 'share', 'opencode', 'opencode.db')

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// One OpenCode message row (its `data` column is JSON). Reasoning tokens count as output, as they are billed.
export function parseOpenCodeMessage(id: string, createdAt: number, data: string): OpenCodeTurn | null {
  let o: Record<string, any>
  try {
    o = JSON.parse(data)
  } catch {
    return null
  }
  if (!o || o.role !== 'assistant' || !o.tokens || typeof o.modelID !== 'string') return null
  const t = o.tokens
  const turn: OpenCodeTurn = {
    id,
    at: num(o.time?.created) || createdAt,
    model: o.modelID,
    provider: typeof o.providerID === 'string' ? o.providerID : '',
    inputTokens: num(t.input),
    outputTokens: num(t.output) + num(t.reasoning),
    cacheRead: num(t.cache?.read),
    cacheWrite: num(t.cache?.write),
    costUsd: num(o.cost),
  }
  if (!turn.inputTokens && !turn.outputTokens && !turn.cacheRead && !turn.cacheWrite) return null
  return turn
}

// Reads the assistant turns of OpenCode sessions from its own database, read-only. Never throws.
export function readOpenCodeTurns(dbFile: string, sessionIds: string[]): OpenCodeTurn[] {
  if (!sessionIds.length || !existsSync(dbFile)) return []
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    const q = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created')
    const out: OpenCodeTurn[] = []
    for (const sid of sessionIds) {
      for (const r of q.all(sid) as Array<{ id: string; time_created: number; data: string }>) {
        const t = parseOpenCodeMessage(String(r.id), Number(r.time_created), String(r.data))
        if (t) out.push(t)
      }
    }
    return out
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

export interface RunSource {
  cli: MasterCli
  cwd: string
  sessionId: string
}

export interface UsageIngestDeps {
  store: Store
  projectsDir?: () => string
  // OpenCode turns of the given sessions (default: ~/.local/share/opencode/opencode.db, read-only).
  openCodeTurns?: (sessionIds: string[]) => OpenCodeTurn[]
  // Folder the front desk runs in (its transcripts are read from the matching projects folder).
  frontDeskCwd?: string
}

const realOr = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

type Obj = Record<string, unknown>

// An OpenCode cost the CLI did not report is estimated only for models with a price row; otherwise it stays 0 and the
// provider page shows the tokens.
const openCodeCost = (t: OpenCodeTurn): number =>
  t.costUsd > 0
    ? t.costUsd
    : isPriced(t.model)
      ? costUsd(t.model, { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cacheRead, cacheWrite5mTokens: t.cacheWrite, cacheWrite1hTokens: 0 })
      : 0

// Feeds the transcripts of a job (its Master and every agent the reader found) and of the Discord front desk into
// `usage`, one row per assistant message keyed by the message id, so re-reading never double counts.
export class UsageIngest {
  private readonly tails = new Map<string, JsonlTail>()
  private readonly projectsDir: () => string
  private readonly openCodeTurns: (ids: string[]) => OpenCodeTurn[]
  readonly frontDeskCwd: string

  constructor(private readonly d: UsageIngestDeps) {
    this.projectsDir = d.projectsDir ?? (() => claudeProjectsDir())
    this.openCodeTurns = d.openCodeTurns ?? ((ids) => readOpenCodeTurns(openCodeDbPath(), ids))
    this.frontDeskCwd = d.frontDeskCwd ?? join(tmpdir(), 'operant-front-desk')
  }

  private tail(file: string): JsonlTail {
    let t = this.tails.get(file)
    if (!t) this.tails.set(file, (t = new JsonlTail(file)))
    return t
  }

  // Forgets the read positions of a job once it ended and was read to the end.
  forget(src: RunSource): void {
    const prefixes = this.sessionDirs(src.cwd, src.sessionId)
    for (const key of [...this.tails.keys()]) if (prefixes.some((p) => key.startsWith(p))) this.tails.delete(key)
  }

  // `<projects>/<encoded cwd>/<session>` for the cwd as given and as resolved (Claude encodes the real path).
  private sessionDirs(cwd: string, sessionId: string): string[] {
    const base = this.projectsDir()
    return [...new Set([cwd, realOr(cwd)])].map((c) => join(base, encodeProjectDir(c), sessionId))
  }

  // Returns how many rows were added or updated.
  syncRun(run: Run, src: RunSource): number {
    return src.cli === 'claude' ? this.syncClaude(run, src) : this.syncOpenCode(run, src)
  }

  private syncClaude(run: Run, src: RunSource): number {
    const { store } = this.d
    const agents = store.listJobAgents(run.id)
    const byRef = new Map(agents.map((a) => [a.transcriptRef, a]))
    const base = { runId: run.id, crewId: run.crewId, cli: 'claude', provider: 'anthropic', sessionId: src.sessionId }
    let n = 0
    const put = (line: string, seat: string, source: string, agent: JobAgent | null): void => {
      const u = parseLine(line)
      if (!u) return
      const r = store.upsertKeyedUsage(
        {
          ...base,
          extKey: `run:${run.id}:${u.messageId}`,
          messageId: u.messageId,
          model: u.model,
          at: u.at,
          jobAgentId: agent?.id ?? null,
          source,
          seat,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheRead: u.cacheReadTokens,
          cacheW5m: u.cacheWrite5mTokens,
          cacheW1h: u.cacheWrite1hTokens,
          costUsd: u.costUsd,
          contextTokens: u.contextTokens,
          toolUse: u.toolUse,
        },
        true,
      )
      if (r !== 'unchanged') n++
    }
    for (const dir of this.sessionDirs(src.cwd, src.sessionId)) {
      // The Master's own transcript; older Claude versions also write subagent turns into it, flagged isSidechain.
      for (const line of this.tail(`${dir}.jsonl`).read()) {
        let o: Obj
        try {
          o = JSON.parse(line) as Obj
        } catch {
          continue
        }
        if (o.isSidechain === true) {
          const id = typeof o.agentId === 'string' && o.agentId ? o.agentId : 'sidechain'
          const agent = byRef.get(`claude:${src.sessionId}:${id}`) ?? null
          put(line, agent?.seat ?? (typeof o.agentType === 'string' && o.agentType ? o.agentType : id), 'agent', agent)
        } else put(line, 'master', 'master', null)
      }
      const sub = join(dir, 'subagents')
      let files: string[] = []
      try {
        files = readdirSync(sub).filter((f) => f.endsWith('.jsonl'))
      } catch {
        /* no subagents folder */
      }
      for (const f of files) {
        const id = f.slice(0, -'.jsonl'.length)
        const agent = byRef.get(`claude:${src.sessionId}:${id}`) ?? null
        for (const line of this.tail(join(sub, f)).read()) put(line, agent?.seat ?? id, 'agent', agent)
      }
    }
    return n
  }

  private syncOpenCode(run: Run, src: RunSource): number {
    const { store } = this.d
    const agents = store.listJobAgents(run.id).filter((a) => a.transcriptRef.startsWith('opencode:'))
    const bySession = new Map<string, JobAgent | null>([[src.sessionId, null]])
    for (const a of agents) bySession.set(a.transcriptRef.slice('opencode:'.length), a)
    let n = 0
    // One query per session keeps each turn tied to its agent.
    for (const [sid, agent] of bySession) {
      for (const t of this.openCodeTurns([sid])) {
        const r = store.upsertKeyedUsage(
          {
            extKey: `run:${run.id}:${t.id}`,
            messageId: t.id,
            sessionId: sid,
            runId: run.id,
            crewId: run.crewId,
            jobAgentId: agent?.id ?? null,
            cli: 'opencode',
            provider: t.provider,
            source: agent ? 'agent' : 'master',
            seat: agent ? agent.seat : 'master',
            model: t.model,
            at: t.at,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            cacheRead: t.cacheRead,
            cacheW5m: t.cacheWrite,
            cacheW1h: 0,
            costUsd: openCodeCost(t),
            contextTokens: t.inputTokens + t.cacheRead + t.cacheWrite,
          },
          true,
        )
        if (r !== 'unchanged') n++
      }
    }
    return n
  }

  // Discord front-desk calls: one Haiku run per message in an empty folder, so every transcript in that folder's
  // projects entry is front-desk spend. Labeled, never attributed to a project or job.
  syncFrontDesk(): number {
    const { store } = this.d
    const seen = new Set<string>()
    let n = 0
    for (const cwd of new Set([this.frontDeskCwd, realOr(this.frontDeskCwd)])) {
      const dir = join(this.projectsDir(), encodeProjectDir(cwd))
      let files: string[] = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) {
        if (seen.has(f)) continue
        seen.add(f)
        const sessionId = f.slice(0, -'.jsonl'.length)
        for (const line of this.tail(join(dir, f)).read()) {
          const u = parseLine(line)
          if (!u) continue
          const r = store.upsertKeyedUsage(
            {
              extKey: `frontdesk:${u.messageId}`,
              messageId: u.messageId,
              sessionId,
              cli: 'claude',
              provider: 'anthropic',
              source: 'frontdesk',
              seat: 'Discord front desk',
              model: u.model,
              at: u.at,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheRead: u.cacheReadTokens,
              cacheW5m: u.cacheWrite5mTokens,
              cacheW1h: u.cacheWrite1hTokens,
              costUsd: u.costUsd,
              contextTokens: u.contextTokens,
            },
            true,
          )
          if (r !== 'unchanged') n++
        }
      }
    }
    return n
  }
}
