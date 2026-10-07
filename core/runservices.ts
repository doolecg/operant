import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HindsightStatus, McpCli, McpDown, IndexStatus, JobAgent, ProjectHealth, Run } from '../shared/types'
import { SubagentReader, realReaderFs, type AgentSource, type ReaderFs } from './agents'
import { buildBrief, type Explorer } from './brief'
import { bankFor, type HindsightService } from './hindsight'
import type { MasterMcp } from './master'
import type { RunMcp } from './mcp'
import { defaultBrief } from './runs'
import type { LearnRunInfo, Lesson } from '../shared/learn'
import type { Store } from './store'
import { diffInfo, writeBack, type Git, type WritebackResult } from './writeback'

export interface McpRunApi {
  forRun(needs: Array<{ seat: string; servers: string[] }>, cli: McpCli, folder: string | null): Promise<RunMcp>
}

export interface RunServicesDeps {
  store: Store
  hindsight: Pick<HindsightService, 'recall' | 'retain' | 'status' | 'act'>
  explorer: Explorer
  git: Git
  indexStatus: (folder: string) => IndexStatus
  reindex: (folder: string) => Promise<unknown>
  reader: SubagentReader
  // The run's agent list changed.
  onAgents?: (run: Run) => void
  cliAvailable: () => boolean
  fs?: ReaderFs
  pollMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (t: unknown) => void
  log?: (message: string, crewId: number) => void
  // The servers seats pick; launch files for a job go under mcpDir.
  mcp?: McpRunApi
  mcpDir?: string
  // Lessons for the brief, and the learn step that runs after the write-back.
  lessons?: (run: Run, symbols: string[]) => Lesson[]
  learn?: (run: Run) => Promise<LearnRunInfo | null>
}

// What every job gets around the Master: the seeded brief, the subagent reader while it works, and the
// write-back when it ends. No call here throws into the job.
export class RunServices {
  private readonly watching = new Map<number, { src: AgentSource; timer: unknown }>()
  private readonly agentSig = new Map<number, string>()
  private readonly mcpRuns = new Map<number, Promise<RunMcp | null>>()

  constructor(private readonly d: RunServicesDeps) {}

  brief = async (run: Run): Promise<string> => {
    try {
      const mcpDown = async (r: Run): Promise<McpDown[]> => (await this.mcpFor(r))?.down ?? []
      return (await buildBrief({ store: this.d.store, hindsight: this.d.hindsight, explorer: this.d.explorer, mcpDown, lessons: this.d.lessons }, run)).text
    } catch {
      return defaultBrief(run)
    }
  }

  // What the run's seats picked, checked once per run (the brief and the launch share it). Nothing here throws.
  private mcpFor(run: Run): Promise<RunMcp | null> {
    const hit = this.mcpRuns.get(run.id)
    if (hit) return hit
    const p = (async () => {
      const mcp = this.d.mcp
      const crew = this.d.store.getCrew(run.crewId)
      if (!mcp || !crew) return null
      const needs = run.seats
        .map((s) => this.d.store.getPreset(s.presetId))
        .filter((p): p is NonNullable<typeof p> => p != null && p.mcpServers.length > 0)
        .map((p) => ({ seat: p.name, servers: p.mcpServers }))
      if (!needs.length) return null
      try {
        return await mcp.forRun(needs, run.masterCli, crew.folder)
      } catch (err) {
        this.d.log?.(`JOB#${run.id} MCP check failed: ${err instanceof Error ? err.message : String(err)}`, crew.id)
        return null
      }
    })()
    this.mcpRuns.set(run.id, p)
    return p
  }

  mcpLaunch = async (run: Run): Promise<MasterMcp | undefined> => {
    const r = await this.mcpFor(run)
    if (!r) return undefined
    const out: MasterMcp = {}
    if (r.claudeConfig && this.d.mcpDir) {
      try {
        mkdirSync(this.d.mcpDir, { recursive: true })
        const file = join(this.d.mcpDir, `run-${run.id}-mcp.json`)
        writeFileSync(file, r.claudeConfig, { mode: 0o600 })
        out.claudeConfigFile = file
      } catch {
        // the job starts without the selection
      }
    }
    if (r.opencodeEnv) out.env = r.opencodeEnv
    return out.claudeConfigFile || out.env ? out : undefined
  }

  onSession = (run: Run, sessionId: string): void => {
    const crew = this.d.store.getCrew(run.crewId)
    if (!crew || this.watching.has(run.id)) return
    const src: AgentSource = { cli: run.masterCli, cwd: crew.folder, sessionId }
    const tick = () => void this.d.reader.sync(run.id, src).then((a) => this.notify(run, a))
    const timer = (this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(tick, this.d.pollMs ?? 5000)
    ;(timer as { unref?: () => void } | null)?.unref?.()
    this.watching.set(run.id, { src, timer })
    tick()
  }

  private notify(run: Run, agents: JobAgent[]): void {
    const sig = agents.map((a) => `${a.id}:${a.status}:${a.model}`).join(',')
    if (this.agentSig.get(run.id) === sig || (!sig && !this.agentSig.has(run.id))) return
    this.agentSig.set(run.id, sig)
    try {
      this.d.onAgents?.(run)
    } catch {
      // a listener never breaks the job
    }
  }

  // The tail of one of the job's agents' transcripts.
  async agentLog(runId: number, agentId: number): Promise<string[]> {
    const run = this.d.store.getRun(runId)
    const crew = run ? this.d.store.getCrew(run.crewId) : null
    const agent = this.d.store.getJobAgent(agentId)
    if (!run || !crew || !agent || agent.runId !== runId) return []
    return this.d.reader.log(agentId, crew.folder)
  }

  // Launch files left by jobs that never finished (a crash or kill) hold the MCP config in plain text.
  sweepStaleLaunchFiles(): void {
    const dir = this.d.mcpDir
    if (!dir) return
    try {
      for (const f of readdirSync(dir)) if (/^run-\d+-mcp\.json$/.test(f)) rmSync(join(dir, f), { force: true })
    } catch {
      // no folder yet
    }
  }

  onFinished = async (run: Run): Promise<WritebackResult | null> => {
    this.mcpRuns.delete(run.id)
    if (this.d.mcpDir) rmSync(join(this.d.mcpDir, `run-${run.id}-mcp.json`), { force: true })
    const w = this.watching.get(run.id)
    if (w) {
      ;(this.d.clearInterval ?? ((t) => clearInterval(t as never)))(w.timer)
      this.watching.delete(run.id)
      this.notify(run, await this.d.reader.sync(run.id, w.src, true))
      this.agentSig.delete(run.id)
    }
    const crew = this.d.store.getCrew(run.crewId)
    if (!crew) return null
    const r = await writeBack({ hindsight: this.d.hindsight, git: this.d.git, reindex: this.d.reindex }, run, crew.folder)
    const skipped = [r.hindsight !== 'written' ? `Hindsight ${r.hindsight}` : '', r.codegraph !== 'synced' ? `CodeGraph ${r.codegraph}` : ''].filter(Boolean)
    this.d.log?.(`JOB#${run.id} write-back: ${skipped.length ? skipped.join('; ') : 'Hindsight written, CodeGraph synced'}`, run.crewId)
    void this.d.learn?.(run).catch(() => undefined)
    return r
  }

  hindsightStatus(): Promise<HindsightStatus> {
    return this.d.hindsight.status()
  }

  hindsightAct(action: 'start' | 'stop' | 'restart'): Promise<HindsightStatus> {
    return this.d.hindsight.act(action)
  }

  async health(crewId: number): Promise<ProjectHealth | null> {
    const crew = this.d.store.getCrew(crewId)
    if (!crew) return null
    const fs = this.d.fs ?? realReaderFs
    const [hs, ix] = [await this.d.hindsight.status(), this.d.indexStatus(crew.folder)]
    const lastIndexedAt = ix.initialized ? fs.mtime(join(crew.folder, '.codegraph', 'codegraph.db')) : null
    let stale = false
    if (lastIndexedAt != null) {
      const { files } = await diffInfo(this.d.git, crew.folder)
      stale = files.some((f) => (fs.mtime(join(crew.folder, f)) ?? 0) > lastIndexedAt)
    }
    return {
      crewId,
      hindsight: { ...hs, bank: bankFor(crew.folder) },
      codegraph: {
        cliAvailable: this.d.cliAvailable(),
        initialized: ix.initialized,
        indexing: ix.indexing,
        files: ix.files,
        symbols: ix.symbols,
        lastIndexedAt,
        stale,
        ...(ix.error ? { error: ix.error } : {}),
      },
    }
  }
}
