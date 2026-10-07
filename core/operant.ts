import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { CoreChannel, IpcApi, IpcEvents } from '../shared/ipc'
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings, type Settings } from '../shared/settings'
import type {
  AgentKind,
  BudgetConfig,
  BudgetStatus,
  CapProgress,
  CapStatus,
  ChangePlan,
  Crew,
  CrewCounts,
  CrewPatch,
  IpcErrorCode,
  LaunchSettings,
  Operator,
  OperatorChange,
  OperatorContext,
  OperatorPatch,
  OperatorStatus,
  Preset,
  PresetPatch,
  ExportText,
  ImportSource,
  Run,
  SeatFields,
  UsageQuery,
  UsageView,
  TeamLimits,
  TeamPatch,
  ScratchStatus,
  ScratchTerminal,
} from '../shared/types'
import type { IndexStatus, CrewIndexes } from './codegraph'
import { Collab } from './collab'
import { graphData, usageBreakdown } from './dashboard'
import { JobEngine, JobError, type JobActor, type JobNotice, type JobSettings } from './jobs'
import {
  ROLE_FILE_BY_PRESET,
  SOCKET_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
  buildAgentLaunch,
  buildMasterLaunch,
  buildScratchLaunch,
  LaunchError,
  commandLine,
  planChange,
  shellOf,
  validateLaunchSettings,
  writeLaunchFiles,
  type LaunchContext,
  type LaunchResult,
  type LaunchWriter,
  type ShellKind,
} from './launch'
import { ClaudeAdapter, MasterRegistry } from './master'
import { createOpenCodeAdapter } from './opencode'
import { MessageBus, MessageError, type MessageNotice } from './messages'
import { NudgeScheduler, type NudgeAction, type NudgeOperatorState } from './nudge'
import { consoleLog } from './console'
import { DiscordError, DiscordManager, scrubSecrets, tokenRef } from './discord'
import { discordAiModel, discordLocalModels } from './discord-ai'
import { claudeFrontDeskModel, type FrontDeskModel } from './discord-frontdesk'
import { createDiscordJsGateway, type GatewayFactory } from './discord-gateway'
import { MemorySecretStore, type SecretStore } from './discord-secrets'
import { RunError, RunManager, cleanLimits, cleanSeats } from './runs'
import { exportTeams, parseTeamFile } from './team-presets'
import { SubagentReader } from './agents'
import { cliExplorer } from './brief'
import { HindsightService, setSharedBanks } from './hindsight'
import { generateApiKey, listAdapters } from './hindsight-net'
import { McpError, McpService } from './mcp'
import { RunServices } from './runservices'
import { LearnError, LearnService, claudeLearnModel, type LearnModel } from './learn'
import { LessonsDb } from './lessons-store'
import { realGit } from './writeback'
import { filesFromTags, refreshTrackerJob } from './tracker'
import { Purger, type PurgeEvent } from './purge'
import type { SessionKey, SessionManager } from './sessions'
import type { Store } from './store'
import { JsonlTail, parseLine, transcriptPath } from './transcripts'
import { learnModelList, resolveLearnAi } from './learn-ai'
import type { LocalLlmDeps } from './localllm'
import { listModels } from './models'
import { RunTransitionError } from './store'
import { UsageTracker, isColdTurn, type CapDecision } from './usage'
import { BUDGETS_KEY, BudgetMonitor, mergeBudgets, sanitizeBudgets, type BudgetDecision } from './usage-budgets'
import { exportView } from './usage-export'
import { UsageIngest, type RunSource } from './usage-ingest'
import { cleanFilter, jobUsage, queryUsage, querySeries } from './usage-query'
import { applyRead, exportBundle, previewRead, readSource, type ImportDeps } from './import'
import { ProviderMonitor } from './providers'
import { ProjectGroups } from './groups'
import { gitChanges, gitInfo, listIdes, openInIde } from './projecttools'
import * as repoGit from './git'
import { killAllOwn } from './proc'

type Handlers = { [C in CoreChannel]: (...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<Awaited<ReturnType<IpcApi[C]>>> }

type PushEvents = { [E in keyof IpcEvents]: [IpcEvents[E]] }

type Group<P extends string> = Pick<Handlers, Extract<CoreChannel, `${P}:${string}`>>

// Collaboration notices the dashboard channel (step 10b) turns into pushes.
interface NoticeEvents {
  job: [JobNotice]
  message: [MessageNotice]
  cap: [CapDecision]
  purge: [PurgeEvent]
}

// What Operant needs from the CLI server (CliServer satisfies it).
export interface CliAccess {
  readonly address: string
  listen(): Promise<string>
  issueToken(operatorId: number): string
  revokeToken(operatorId: number): void
  close(): Promise<void>
}

export interface Scheduler {
  every(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

const realScheduler: Scheduler = {
  every: (fn, ms) => {
    const h = setInterval(fn, ms)
    h.unref?.()
    return h
  },
  cancel: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

export interface LaunchOptions {
  platform?: NodeJS.Platform
  // <userData>/launch (settings and MCP files) and <userData>/roles.
  launchDir?: string
  rolesDir?: string
  // plugin/roles (default: next to pluginDir's SKILL files).
  shippedRolesDir?: string
  readRole?: (file: string) => string
  writer?: LaunchWriter
  // Folder holding the `operant` wrapper; put on an operator's PATH when it has a CLI token.
  cliDir?: string
  // The binary the wrapper runs the CLI with (OPERANT_NODE).
  operantNode?: string
  // Ruling R11: the CodeGraph MCP server is offered only when the `codegraph` CLI is on PATH.
  codegraphOnPath?: () => boolean
  baseEnv?: NodeJS.ProcessEnv
  supported?: ReadonlySet<string>
}

export interface OperantOptions {
  store: Store
  sessions: SessionManager
  indexes: CrewIndexes
  pluginDir: string
  now?: () => number
  transcriptFile?: (cwd: string, sessionId: string) => string
  launch?: LaunchOptions
  // Each is built from the store when not given; an injected one must route its notices to the
  // matching `on*` method itself.
  jobs?: JobEngine
  messages?: MessageBus
  usage?: UsageTracker
  purger?: Purger
  nudge?: NudgeScheduler
  cliServer?: (collab: Collab) => CliAccess
  scheduler?: Scheduler
  // Master adapters by CLI; the Claude adapter is registered when none is given.
  masters?: MasterRegistry
  runs?: RunManager
  // Discord: where bot tokens are kept (the OS keychain in the app), the connection and the front desk model.
  discord?: { secrets?: SecretStore; gateway?: GatewayFactory; frontDesk?: FrontDeskModel }
  // The seeded brief, subagent reader and write-back around jobs; real services when not given.
  runServices?: RunServices
  // The learning loop (lessons from finished jobs); the real one when not given.
  learn?: LearnService
  // The cheap model the learn step asks; Claude Haiku when not given.
  learnModel?: LearnModel
  mcp?: McpService
  // Reads job transcripts into usage and follows the Discord front desk; real ones when not given.
  ingest?: UsageIngest
  // Plan limits and provider usage; real pollers when not given.
  providers?: ProviderMonitor
  // File pickers (the app supplies Electron's); without them `usage:export` and `data:exportFile` refuse.
  fileDialogs?: FileDialogs
  // Where Operant 2.8.2 kept its data and the clock/files import reads with (tests).
  importDeps?: ImportDeps
}

export interface FileDialogs {
  save(suggestedName: string, filter: { name: string; extensions: string[] }): Promise<string | null>
  open(filter: { name: string; extensions: string[] }): Promise<string | null>
}

const HOUR = 60 * 60 * 1000
// Transcripts are polled rather than watched: fs.watch is unreliable across platforms for appends.
const USAGE_POLL_MS = 2_000
// Job and front-desk transcripts are read at a slower pace: their agents write in bursts and many files are open.
const RUN_USAGE_POLL_MS = 10_000
const PROVIDER_TICK_MS = 30_000
const NUDGE_TICK_MS = 1_000
const JOB_SWEEP_MS = 30_000
const EXIT_WAIT_MS = 15_000

// A running Claude scratch terminal's transcript, followed so its spend counts (shown separately).
interface ScratchFeed {
  tail: JsonlTail
  sessionId: string
  prevContext: number | null
  current: { messageId: string; toolUse: boolean } | null
  currentContext: number
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function shellKind(file: string, platform: NodeJS.Platform): ShellKind {
  if (!file) return platform === 'win32' ? 'powershell' : 'sh'
  const base = (file.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  if (base === 'cmd') return 'cmd'
  return base === 'pwsh' || base === 'powershell' ? 'powershell' : 'sh'
}

function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  const dirs = (key ? (env[key] ?? '') : '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return dirs.some((d) => exts.some((e) => existsSync(join(d, name + e))))
}

// A refusal the dashboard can show: a code to branch on and a message fit for the user.
export class OperantError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OperantError'
  }
}

// Where the Hindsight API keys live in the secret store; the settings never hold them.
const LOCAL_LLM_KEY = 'learn-local-key'
const HINDSIGHT_KEY = { shared: 'hindsight-shared-key', remote: 'hindsight-remote-key' } as const
const slotOf = (slot: unknown): keyof typeof HINDSIGHT_KEY => {
  if (slot === 'shared' || slot === 'remote') return slot
  throw new OperantError('BAD_ARGS', 'Key slot must be shared or remote')
}

const bad = (message: string) => new OperantError('BAD_ARGS', message)
const notFound = (message: string) => new OperantError('NOT_FOUND', message)
const conflict = (message: string) => new OperantError('CONFLICT', message)

// Every error a handler can throw, as a code and a message. Programming errors stay INTERNAL.
export function ipcErrorOf(err: unknown): { code: IpcErrorCode; message: string } {
  if (err instanceof OperantError) return { code: err.code, message: err.message }
  if (err instanceof JobError || err instanceof MessageError) return { code: err.code, message: err.message }
  if (err instanceof LaunchError) return { code: 'BAD_ARGS', message: err.message }
  if (err instanceof DiscordError) return { code: err.code, message: err.message }
  if (err instanceof LearnError) return { code: err.code, message: err.message }
  if (err instanceof RunError) return { code: err.code === 'LIMIT' ? 'CONFLICT' : err.code, message: err.message }
  if (err instanceof RunTransitionError) return { code: 'CONFLICT', message: err.message }
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) return { code: 'INTERNAL', message }
  if (/UNIQUE constraint failed/i.test(message)) return { code: 'CONFLICT', message: 'That name is already in use' }
  if (/not found/i.test(message)) return { code: 'NOT_FOUND', message }
  if (/already|cycle|busy/i.test(message)) return { code: 'CONFLICT', message }
  return { code: 'BAD_ARGS', message }
}

const toOperantError = (err: unknown): OperantError => {
  if (err instanceof OperantError) return err
  const { code, message } = ipcErrorOf(err)
  return new OperantError(code, message)
}

const USER: JobActor = { kind: 'user' }
const NAME_MAX = 80
const ROLE_TEXT_MAX = 20_000
const TILE_LAYOUT_MAX = 100_000
const LAUNCH_KEYS = ['agent', 'model', 'effort', 'permissionMode', 'tools', 'allow', 'deny', 'cacheTtl', 'contextCap', 'clearBetweenJobs', 'mcp'] as const
const OPERATOR_KEYS = new Set<string>([...LAUNCH_KEYS, 'role', 'squadId', 'dailyCapUsd', 'roleText'])
const PERIODS = new Set<string>(['24h', '7d', '30d'])
const WINDOWS = new Set<string>(['1h', '24h', 'all'])
const VIEWS = new Set<string>(['cards', 'list', 'graph', 'tiles'])
const AGENTS = new Set<string>(['claude', 'codex', 'shell'])
const NODE_KEY_RE = /^[a-z]+(:\d+)?$/

function cleanName(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${what} cannot be empty`)
  const t = v.trim()
  if (t.length > NAME_MAX) throw bad(`${what} is longer than ${NAME_MAX} characters`)
  return t
}

// Roles are used in addresses (`role@crew`) and message targets, so they cannot hold spaces, `@` or `:`.
function cleanRole(v: unknown): string {
  const role = cleanName(v, 'The role')
  if (/[\s@:]/.test(role) || role.length > 40) throw bad('A role is up to 40 characters with no spaces, "@" or ":"')
  if (role === 'user' || role === 'pm') throw bad(`"${role}" is reserved for message targets`)
  return role
}

function cleanRoleText(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string') throw bad('Role text must be text')
  if (v.length > ROLE_TEXT_MAX) throw bad(`Role text is longer than ${ROLE_TEXT_MAX} characters`)
  return v
}

function cleanCap(v: unknown): number | null {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw bad('The daily cap must be a number from 0 to 100000, or empty')
  return v
}

function launchFields(patch: Record<string, unknown>): Partial<LaunchSettings> {
  const out: Record<string, unknown> = {}
  for (const k of LAUNCH_KEYS) if (patch[k] !== undefined) out[k] = patch[k]
  return out as Partial<LaunchSettings>
}

// Everything the dashboard can ask for or be told about, independent of Electron.
export class Operant extends EventEmitter<PushEvents> {
  readonly handlers: Handlers
  readonly notices = new EventEmitter<NoticeEvents>()
  readonly jobs: JobEngine
  readonly messages: MessageBus
  readonly usage: UsageTracker
  readonly purger: Purger
  readonly nudge: NudgeScheduler
  readonly collab: Collab
  readonly runs: RunManager
  readonly discord: DiscordManager
  private readonly secrets: SecretStore
  private readonly hindsight: HindsightService
  readonly runServices: RunServices
  readonly learn: LearnService
  readonly mcp: McpService
  readonly masters: MasterRegistry
  readonly ingest: UsageIngest
  readonly providers: ProviderMonitor
  readonly budgets: BudgetMonitor
  private readonly store: Store
  private readonly sessions: SessionManager
  private readonly indexes: CrewIndexes
  private readonly groups: ProjectGroups
  private readonly pluginDir: string
  private readonly now: () => number
  private readonly transcriptFile: (cwd: string, sessionId: string) => string
  private readonly launch: LaunchOptions
  private readonly cli: CliAccess | null
  private readonly scheduler: Scheduler
  private readonly timers: unknown[] = []
  // The longest a quit waits on any one step (Discord, the CLI socket, killing processes).
  shutdownStepMs = 3000
  // Operators whose session Operant started and has not seen exit.
  private readonly live = new Set<number>()
  private readonly contexts = new Map<number, OperatorContext>()
  // When each operator last finished a job (for the /clear between jobs).
  private readonly finished = new Map<number, number>()
  // Operators being relaunched: their exit keeps their jobs.
  private readonly restarting = new Set<number>()
  private readonly exitWaiters = new Map<number, () => void>()
  // Transcript followers of running Claude scratch terminals.
  private readonly scratchFeeds = new Map<number, ScratchFeed>()
  private settings: Settings
  private budgetConfig: BudgetConfig
  private readonly fileDialogs: FileDialogs | undefined
  private pendingTeamImport: string | null = null
  private readonly importDeps: ImportDeps

  constructor(opts: OperantOptions) {
    super()
    const { store, sessions, indexes } = opts
    this.store = store
    this.sessions = sessions
    this.indexes = indexes
    this.groups = new ProjectGroups(store.db)
    this.pluginDir = opts.pluginDir
    this.now = opts.now ?? Date.now
    this.transcriptFile = opts.transcriptFile ?? ((cwd, id) => transcriptPath(cwd, id))
    this.launch = opts.launch ?? {}
    this.scheduler = opts.scheduler ?? realScheduler
    this.settings = sanitizeSettings(store.getJson('settings'))
    this.budgetConfig = sanitizeBudgets(store.getJson(BUDGETS_KEY))
    this.fileDialogs = opts.fileDialogs
    this.importDeps = opts.importDeps ?? {}

    this.jobs = opts.jobs ?? new JobEngine(store, this.now, () => this.jobSettings(), (n) => this.onJobNotice(n))
    this.messages = opts.messages ?? new MessageBus({ store, now: this.now, emit: (n) => this.onMessageNotice(n) })
    this.usage =
      opts.usage ??
      new UsageTracker({ store, now: this.now, config: this.usageConfig(), currentJob: (id) => this.doingJob(id) })
    this.ingest = opts.ingest ?? new UsageIngest({ store })
    this.providers =
      opts.providers ??
      new ProviderMonitor({
        store,
        now: this.now,
        onAlert: (a) => this.log('provider', `${a.providerId === 'claude' ? 'Claude plan' : a.providerId}: ${a.windowId} is at ${Math.floor(a.usedPct)}% (alert at ${a.thresholdPct}%)`),
      })
    this.budgets = new BudgetMonitor({
      now: this.now,
      config: () => this.budgetConfig,
      warnPct: () => this.settings.tokens.capWarnPct,
      crewIds: () => store.listCrews().map((c) => c.id),
      projectSpend: (crewId, since) => store.spendSince(since, crewId),
      liveRuns: () => store.listRuns().filter((r) => r.status === 'working' || r.status === 'needs-you').map((r) => ({ id: r.id, crewId: r.crewId })),
      jobSpend: (runId) => Number((store.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS t FROM usage WHERE run_id = ?').get(runId) as { t: number }).t),
    })
    this.purger =
      opts.purger ??
      new Purger({
        store,
        now: this.now,
        settings: () => ({ purgeRetentionDays: this.settings.collab.purgeRetentionDays, purgeEnabled: this.settings.collab.purgeEnabled }),
        emit: (e) => this.onPurge(e),
      })
    this.nudge = opts.nudge ?? new NudgeScheduler()
    this.collab = new Collab({
      store,
      jobs: this.jobs,
      messages: this.messages,
      now: this.now,
      capPaused: (id) => this.usage.caps.isPaused(id),
      onError: (err) => this.log('error', `CLI request failed: ${err instanceof Error ? err.message : 'unexpected error'}`),
    })
    this.masters = opts.masters ?? new MasterRegistry()
        .register('claude', new ClaudeAdapter({ supported: opts.launch?.supported, userHooks: () => this.settings.runs.useClaudeHooks }))
        .register('opencode', createOpenCodeAdapter())
    this.mcp =
      opts.mcp ??
      new McpService({
        log: (message) => this.log('mcp', message),
        builtin: async (name) => {
          if (name === 'codegraph') {
            const ok = onPath('codegraph', this.launch.baseEnv ?? process.env, process.platform)
            return { ok, error: ok ? undefined : 'the codegraph CLI is not on PATH' }
          }
          const h = await this.runServices.hindsightStatus()
          return { ok: h.state === 'running', error: h.detail }
        },
      })
    const secrets = opts.discord?.secrets ?? new MemorySecretStore()
    this.secrets = secrets
    // Shared mode sends and requires the shared key; remote sends the remote key; local sends none.
    const hindsight = new HindsightService({
      url: () => (this.settings.hindsight.mode === 'remote' ? this.settings.hindsight.url : ''),
      lan: () => {
        const h = this.settings.hindsight
        return h.mode === 'lan' ? { host: h.bindHost, port: h.port, openBind: h.openBind } : null
      },
      key: () => (this.settings.hindsight.mode === 'local' ? null : secrets.get(HINDSIGHT_KEY[this.settings.hindsight.mode === 'lan' ? 'shared' : 'remote'])),
      llmEnv: () => ({ HINDSIGHT_API_LLM_PROVIDER: 'claude-code' }),
    })
    this.hindsight = hindsight
    this.learn =
      opts.learn ??
      new LearnService({
        store,
        db: new LessonsDb(store.db, this.now),
        hindsight,
        git: realGit,
        model: opts.learnModel ?? claudeLearnModel(opts.launch?.supported, { settings: () => this.settings.learn, local: this.localLlm() }),
        settings: () => this.settings.learn,
        log: (message, crewId) => this.log('learn', message, null, crewId || null),
      })
    this.runServices =
      opts.runServices ??
      new RunServices({
        store,
        hindsight,
        lessons: (run, symbols) => this.learn.forBrief(run.crewId, run.task, symbols),
        learn: (run) => this.learn.onRunFinished(run),
        explorer: cliExplorer(),
        git: realGit,
        indexStatus: (folder) => indexes.status(folder),
        reindex: (folder) =>
          indexes.status(folder).initialized ? indexes.index(folder) : Promise.reject(new Error('this project has no CodeGraph index yet')),
        reader: new SubagentReader({ store, now: this.now }),
        onAgents: (run) => this.emit('run:agents', { crewId: run.crewId, runId: run.id }),
        cliAvailable: () => onPath('codegraph', this.launch.baseEnv ?? process.env, process.platform),
        log: (message, crewId) => this.log('job', message, null, crewId),
        mcp: this.mcp,
        mcpDir: join(this.launch.launchDir ?? join(tmpdir(), 'operant2', 'launch'), 'mcp'),
      })
    this.runs =
      opts.runs ??
      new RunManager({
        store,
        adapters: this.masters,
        now: this.now,
        brief: this.runServices.brief,
        mcp: this.runServices.mcpLaunch,
        onSession: (run, sessionId) => {
          this.noteRunSession(run, sessionId)
          this.runServices.onSession(run, sessionId)
        },
        onFinished: async (run) => {
          const r = await this.runServices.onFinished(run)
          this.finishRunUsage(run)
          this.trackerJob(run.crewId, run, filesFromTags(r?.tags))
          return r
        },
        hold: (run) => this.runHold(run.crewId),
        runTokens: (run) => this.runTokens(run.id),
        onChange: (n) => this.emit('run', n),
        onError: (err) => this.log('error', `Job runner: ${err instanceof Error ? err.message : String(err)}`),
      })
    this.discord = new DiscordManager({
      store,
      runs: this.runs,
      secrets,
      gateway: opts.discord?.gateway ?? createDiscordJsGateway,
      frontDesk: opts.discord?.frontDesk ?? claudeFrontDeskModel(opts.launch?.supported),
      frontDeskFor: (ai) => discordAiModel(ai, { supported: opts.launch?.supported, opencode: () => this.masters.has('opencode') ? this.masters.get('opencode') : undefined }),
      localModels: (url) => discordLocalModels(url),
      now: this.now,
      log: (message, crewId) => {
        const text = scrubSecrets(message)
        this.log('discord', text, null, crewId ?? null)
        consoleLog.add('discord', 'info', text, { error: /could not|failed|error|disconnected|refused|not valid|is off|timed out/i.test(text) })
      },
      onHealth: (h) => this.emit('discord:status', h),
      onPairing: (botId) => this.emit('discord:pairing', { botId }),
    })
    this.on('run', (n) => this.discord.onRunChange(n))
    this.cli = opts.cliServer?.(this.collab) ?? null
    this.applySettings()

    this.usage.on('usage', (p) => {
      this.contexts.set(p.operatorId, p.context)
      this.emit('usage', p)
    })
    this.usage.on('cap', (d) => this.onCap(d))
    sessions.on('data', (operatorId, data) => this.emit('operator:data', { operatorId, data }))
    sessions.on('exit', (operatorId, exitCode) => this.onExit(operatorId, exitCode))
    sessions.on('sessionData', (key, data) => {
      const id = this.scratchId(key)
      if (id != null) this.emit('scratch:data', { scratchId: id, data })
    })
    sessions.on('sessionExit', (key, exitCode) => {
      const id = this.scratchId(key)
      if (id != null) this.onScratchExit(id, exitCode)
    })

    const all: Handlers = {
      ...this.crewHandlers(),
      ...this.groupHandlers(),
      ...this.squadHandlers(),
      ...this.operatorHandlers(),
      ...this.masterHandlers(),
      ...this.presetHandlers(),
      ...this.teamHandlers(),
      ...this.modelHandlers(),
      ...this.runHandlers(),
      ...this.discordHandlers(),
      ...this.jobHandlers(),
      ...this.linkHandlers(),
      ...this.messageHandlers(),
      ...this.viewHandlers(),
      ...this.scratchHandlers(),
      ...this.usageHandlers(),
      ...this.moveHandlers(),
      ...this.graphHandlers(),
      ...this.miscHandlers(),
      ...this.mcpHandlers(),
    }
    // Every refusal leaves core as an OperantError with a code.
    const wrapped: Record<string, (...args: unknown[]) => unknown> = {}
    for (const [channel, fn] of Object.entries(all) as Array<[string, (...args: unknown[]) => unknown]>) {
      wrapped[channel] = (...args) => {
        try {
          const result = fn(...args)
          return result instanceof Promise ? result.catch((err: unknown) => Promise.reject(toOperantError(err))) : result
        } catch (err) {
          throw toOperantError(err)
        }
      }
    }
    this.handlers = wrapped as unknown as Handlers
  }

  // Handler groups

  private requireRun(runId: number): Run {
    const run = typeof runId === 'number' ? this.store.getRun(runId) : null
    if (!run) throw notFound(`Job ${String(runId)} not found`)
    return run
  }

  private requireCrew(crewId: number): Crew {
    const crew = typeof crewId === 'number' ? this.store.getCrew(crewId) : null
    if (!crew) throw notFound(`Project ${String(crewId)} not found`)
    return crew
  }

  private requireOperator(operatorId: number): Operator {
    const operator = typeof operatorId === 'number' ? this.store.getOperator(operatorId) : null
    if (!operator) throw notFound(`Operator ${String(operatorId)} not found`)
    return operator
  }

  private requireScratch(scratchId: number): ScratchTerminal {
    const scratch = typeof scratchId === 'number' ? this.store.getScratch(scratchId) : null
    if (!scratch) throw notFound(`Scratch terminal ${String(scratchId)} not found`)
    return scratch
  }

  private requirePreset(presetId: number): Preset {
    const preset = typeof presetId === 'number' ? this.store.getPreset(presetId) : null
    if (!preset) throw notFound(`Preset ${String(presetId)} not found`)
    return preset
  }

  private userActor(crewId: number) {
    return { kind: 'user' as const, crewId: this.requireCrew(crewId).id }
  }

  private crewHandlers(): Group<'crews'> {
    const store = this.store
    return {
      'crews:list': () => store.listCrews(),
      'crews:topology': (crewId) => store.topology(crewId),
      'crews:create': ({ name, folder }) => {
        if (typeof folder !== 'string' || !folder.trim()) throw bad('The folder cannot be empty')
        const crew = store.createCrew(cleanName(name, 'The project name'), folder.trim())
        this.log('crew', `Project ${crew.name} created`, null, crew.id)
        return crew
      },
      'crews:update': (crewId, patch) => {
        const crew = this.requireCrew(crewId)
        const next: CrewPatch = {}
        if (patch.name !== undefined) next.name = cleanName(patch.name, 'The project name')
        if (patch.folder !== undefined) {
          if (typeof patch.folder !== 'string' || !patch.folder.trim()) throw bad('The folder cannot be empty')
          if (patch.folder.trim() !== crew.folder && this.crewRunning(crewId) > 0) {
            throw conflict('Stop the project’s operators and tiles before changing its folder')
          }
          next.folder = patch.folder.trim()
        }
        if (patch.pmId !== undefined) next.pmId = patch.pmId
        if (patch.discordChannels !== undefined) {
          if (!Array.isArray(patch.discordChannels) || patch.discordChannels.some((c) => typeof c !== 'string' || !/^\d{5,25}$/.test(c.trim()))) {
            throw bad('Discord channel ids are numbers of 5 to 25 digits')
          }
          next.discordChannels = [...new Set(patch.discordChannels.map((c) => c.trim()))]
        }
        if (patch.trackerFile !== undefined) {
          const f = typeof patch.trackerFile === 'string' ? patch.trackerFile.trim().replace(/\\/g, '/') : null
          if (f == null || f.length > 300 || isAbsolute(f) || /^[a-z]:/i.test(f) || f.split('/').includes('..')) {
            throw bad('The tracker file is a path inside the project folder')
          }
          next.trackerFile = f
        }
        if (patch.trackerJobs !== undefined) next.trackerJobs = patch.trackerJobs === true
        const updated = store.updateCrew(crewId, next)
        this.log('crew', `Project ${updated.name} updated`, null, crewId)
        return updated
      },
      'crews:trackerNow': (crewId) => {
        const crew = this.requireCrew(crewId)
        if (!crew.trackerFile) throw bad('Set a tracker file for this project first')
        return refreshTrackerJob(this.jobs, crew, null, [])
      },
      'crews:reorder': (crewIds) => {
        if (!Array.isArray(crewIds) || crewIds.some((id) => typeof id !== 'number')) throw bad('The order must be a list of project ids')
        return store.reorderCrews(crewIds)
      },
      'crews:counts': (crewId) => this.crewCounts(this.requireCrew(crewId).id),
      'crews:delete': async (crewId) => {
        const crew = this.requireCrew(crewId)
        const counts = this.crewCounts(crewId)
        const ids = (store.topology(crewId)?.squads ?? []).flatMap((squad) => squad.operators.map((s) => s.id))
        const master = store.getMaster(crewId)
        if (master) ids.push(master.id)
        // SQLite reuses ids once the project's rows are gone, so every session must be gone first.
        for (const id of ids) await this.stopAndWait(id)
        for (const id of ids) this.dropOperatorState(id)
        for (const scratch of store.listScratch(crewId)) {
          this.sessions.stop(this.scratchKey(scratch.id))
          this.detachScratch(scratch.id)
        }
        store.deleteCrew(crewId)
        this.log('crew', `Project ${crew.name} deleted`)
        return counts
      },
    }
  }

  private groupHandlers(): Group<'groups'> & Group<'ide'> & Group<'git'> {
    const store = this.store
    const groups = this.groups
    const ids = (v: unknown, what: string): number[] => {
      if (!Array.isArray(v) || v.some((id) => typeof id !== 'number')) throw bad(`${what} must be a list of ids`)
      return v
    }
    return {
      'groups:list': () => groups.list(),
      'groups:create': (name) => {
        const group = groups.create(name)
        this.log('crew', `Group ${group.name} created`)
        return group
      },
      'groups:rename': (groupId, name) => groups.rename(groupId, name),
      'groups:delete': (groupId) => {
        const group = groups.get(groupId)
        groups.delete(groupId)
        this.log('crew', `Group ${group.name} removed; its projects are back in the list`)
      },
      'groups:collapse': (groupId, collapsed) => groups.setCollapsed(groupId, collapsed === true),
      'groups:reorder': (groupIds) => groups.reorder(ids(groupIds, 'The order')),
      'groups:move': (crewId, groupId, beforeCrewId) => {
        this.requireCrew(crewId)
        if (groupId !== null && typeof groupId !== 'number') throw bad('The group must be an id or null')
        store.transaction(() => groups.move(crewId, groupId, typeof beforeCrewId === 'number' ? beforeCrewId : undefined))
        return store.listCrews()
      },
      'ide:list': () => listIdes(this.settings.ide.custom),
      'ide:open': (crewId, ide) => openInIde(this.requireCrew(crewId).folder, ide ?? this.settings.ide.default, this.settings.ide.custom),
      'git:changes': (crewId) => gitChanges(this.requireCrew(crewId).folder),
      'git:info': (crewId) => gitInfo(this.requireCrew(crewId).folder),
      'git:status': (id) => repoGit.gitStatus(this.requireCrew(id).folder),
      'git:diff': (id, req) => repoGit.gitDiff(this.requireCrew(id).folder, req),
      'git:stage': (id, paths) => repoGit.gitStage(this.requireCrew(id).folder, paths),
      'git:unstage': (id, paths) => repoGit.gitUnstage(this.requireCrew(id).folder, paths),
      'git:discard': (id, paths) => repoGit.gitDiscard(this.requireCrew(id).folder, paths),
      'git:stageHunk': (id, ref, stage) => repoGit.gitStageHunk(this.requireCrew(id).folder, ref, stage === true),
      'git:commit': (id, message, amend) => repoGit.gitCommit(this.requireCrew(id).folder, message, amend === true),
      'git:lastMessage': (id) => repoGit.gitLastMessage(this.requireCrew(id).folder),
      'git:log': (id, limit, skip) => repoGit.gitLog(this.requireCrew(id).folder, limit, skip),
      'git:commitDetails': (id, hash) => repoGit.gitCommitDetails(this.requireCrew(id).folder, hash),
      'git:branches': (id) => repoGit.gitBranches(this.requireCrew(id).folder),
      'git:checkout': (id, branch) => repoGit.gitCheckout(this.requireCrew(id).folder, branch),
      'git:createBranch': (id, name) => repoGit.gitCreateBranch(this.requireCrew(id).folder, name),
      'git:fetch': (id) => repoGit.gitFetch(this.requireCrew(id).folder),
      'git:pull': (id) => repoGit.gitPull(this.requireCrew(id).folder),
      'git:push': (id) => repoGit.gitPush(this.requireCrew(id).folder),
    }
  }

  private squadHandlers(): Group<'squads'> {
    const store = this.store
    return {
      'squads:create': ({ crewId, name }) => {
        this.requireCrew(crewId)
        const squad = store.createSquad(crewId, cleanName(name, 'The squad name'))
        this.log('squad', `Squad ${squad.name} added`, null, crewId)
        return squad
      },
      'squads:update': (squadId, patch) => {
        const squad = store.getSquad(squadId)
        if (!squad) throw notFound(`Squad ${String(squadId)} not found`)
        const updated = store.renameSquad(squadId, cleanName(patch.name, 'The squad name'))
        this.log('squad', `Squad ${squad.name} renamed to ${updated.name}`, null, squad.crewId)
        return updated
      },
      'squads:delete': async (squadId) => {
        const squad = store.getSquad(squadId)
        if (!squad) throw notFound(`Squad ${String(squadId)} not found`)
        if (squad.system) throw bad('The system squad cannot be deleted')
        const members = store.topology(squad.crewId)?.squads.find((s) => s.id === squadId)?.operators ?? []
        for (const op of members) await this.deleteOperator(op.id)
        store.deleteSquad(squadId)
        this.log('squad', `Squad ${squad.name} deleted`, null, squad.crewId)
        return { operators: members.length }
      },
    }
  }

  private operatorHandlers(): Group<'operators'> {
    const store = this.store
    return {
      'operators:create': ({ squadId, role, agent, model }) => {
        const cleanRoleName = cleanRole(role)
        const m = typeof model === 'string' ? model.trim() : ''
        validateLaunchSettings({ agent, model: m })
        const operator = store.createOperator(squadId, cleanRoleName, agent, m)
        // Operators need an explicit permission mode to launch; the table default is not a launchable one.
        if (agent === 'claude') store.setOperatorLaunch(operator.id, { permissionMode: 'acceptEdits' })
        this.log('operator', `Operator ${store.operatorAddress(operator.id)} added`, operator.id)
        this.configChanged(operator.id)
        return store.getOperator(operator.id)!
      },
      'operators:createFromPreset': ({ squadId, role, presetId, agent, model }) => {
        const cleanRoleName = cleanRole(role)
        this.requirePreset(presetId)
        validateLaunchSettings({ ...(agent ? { agent } : {}), ...(model ? { model } : {}) })
        const operator = store.createOperatorFromPreset(squadId, cleanRoleName, presetId, { agent, model: model?.trim() || undefined })
        this.log('operator', `Operator ${store.operatorAddress(operator.id)} added from preset`, operator.id)
        this.configChanged(operator.id)
        return operator
      },
      'operators:update': (operatorId, patch) => {
        const operator = this.requireOperator(operatorId)
        const next: { role?: string; squadId?: number } = {}
        if (patch.role !== undefined) next.role = cleanRole(patch.role)
        if (patch.squadId !== undefined) next.squadId = patch.squadId
        const cap = patch.dailyCapUsd === undefined ? undefined : cleanCap(patch.dailyCapUsd)
        if (next.role !== undefined || next.squadId !== undefined) store.updateOperator(operatorId, next)
        if (cap !== undefined) store.setOperatorLaunch(operatorId, { dailyCapUsd: cap })
        if (cap !== undefined) this.usage.checkCaps(operatorId)
        this.log('operator', `Operator ${store.operatorAddress(operatorId)} updated`, operatorId)
        this.configChanged(operatorId)
        return store.getOperator(operatorId) ?? operator
      },
      'operators:previewChange': (operatorId, patch) => this.previewChange(operatorId, patch),
      'operators:applyChange': (operatorId, patch) => this.applyChange(operatorId, patch),
      'operators:start': (operatorId) => this.startOperator(operatorId),
      'operators:stop': (operatorId) => this.sessions.stop(operatorId),
      'operators:restart': async (operatorId) => {
        this.requireOperator(operatorId)
        await this.restartOperator(operatorId)
        this.configChanged(operatorId)
      },
      'operators:delete': (operatorId) => this.deleteOperator(operatorId),
      'operators:write': (operatorId, data) => this.sessions.write(operatorId, data),
      'operators:resize': (operatorId, cols, rows) => this.sessions.resize(operatorId, cols, rows),
      'operators:buffer': (operatorId) => this.sessions.buffer(operatorId),
      'operators:context': () => Object.fromEntries(this.contexts),
    }
  }

  private masterHandlers(): Group<'master'> {
    return {
      'master:get': (crewId) => this.store.getMaster(this.requireCrew(crewId).id),
      'master:start': (crewId) => this.startMaster(this.requireCrew(crewId).id),
      'master:stop': (crewId) => {
        const master = this.store.getMaster(this.requireCrew(crewId).id)
        if (master) this.sessions.stop(master.id)
      },
    }
  }

  private presetHandlers(): Group<'presets'> {
    const store = this.store
    const checkPreset = (p: Partial<LaunchSettings> & { name?: unknown; roleText?: unknown }): void => {
      validateLaunchSettings(launchFields(p as Record<string, unknown>))
      if (p.roleText !== undefined) cleanRoleText(p.roleText)
      const seat = p as Partial<SeatFields>
      if (seat.skills !== undefined && (!Array.isArray(seat.skills) || seat.skills.length > 100 || seat.skills.some((s) => typeof s !== 'string' || !s.trim() || s.length > NAME_MAX))) {
        throw bad('Skills must be a list of names')
      }
      for (const k of ['hindsight', 'codegraph'] as const) if (seat[k] !== undefined && typeof seat[k] !== 'boolean') throw bad(`${k} must be on or off`)
      if (seat.mcpServers !== undefined && (!Array.isArray(seat.mcpServers) || seat.mcpServers.length > 100 || seat.mcpServers.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_. :-]{1,100}$/.test(n)))) {
        throw bad('MCP servers must be a list of server names')
      }
    }
    return {
      'presets:list': () => store.listPresets(),
      'presets:create': (input) => {
        checkPreset(input)
        if (!input.permissionMode) throw bad('A preset needs a permission mode')
        const preset = store.createPreset({ ...input, name: cleanName(input.name, 'The preset name') })
        this.log('preset', `Preset ${preset.name} created`)
        return preset
      },
      'presets:update': (presetId, patch, apply = false) => {
        const before = this.requirePreset(presetId)
        checkPreset({ ...patch, agent: patch.agent ?? before.agent })
        const next: PresetPatch = { ...patch }
        if (patch.name !== undefined) next.name = cleanName(patch.name, 'The preset name')
        // "Unmodified" is judged before the edit: afterwards every operator differs from the preset.
        const untouched = apply ? store.operatorsOfPreset(presetId).filter((o) => !o.modified) : []
        const preset = store.updatePreset(presetId, next)
        for (const o of untouched) {
          store.applyPresetToOperator(o.id)
          this.configChanged(o.id)
        }
        this.log('preset', `Preset ${preset.name} updated${untouched.length ? `, applied to ${untouched.length} operator${untouched.length === 1 ? '' : 's'}` : ''}`)
        return preset
      },
      'presets:duplicate': (presetId, name) => {
        const src = this.requirePreset(presetId)
        const shipped = this.shippedRole(src)
        const copy = store.duplicatePreset(presetId, name === undefined ? undefined : cleanName(name, 'The preset name'), shipped)
        this.log('preset', `Preset ${src.name} duplicated as ${copy.name}`)
        return copy
      },
      'presets:delete': (presetId) => {
        const preset = this.requirePreset(presetId)
        const users = store.operatorsOfPreset(presetId)
        store.deletePreset(presetId)
        for (const o of users) this.configChanged(o.id)
        this.log('preset', `Preset ${preset.name} deleted; ${users.length} operator${users.length === 1 ? '' : 's'} kept their settings`)
      },
      'presets:reset': (presetId) => {
        const before = this.requirePreset(presetId)
        if (before.builtin == null) throw bad('Only built-in presets can be reset')
        const preset = store.resetPreset(presetId)
        for (const o of store.operatorsOfPreset(presetId)) this.configChanged(o.id)
        this.log('preset', `Preset ${preset.name} reset to its shipped values`)
        return preset
      },
      'presets:restoreBuiltins': () => {
        const added = store.restoreBuiltins()
        if (added.length) this.log('preset', `Restored built-in presets: ${added.map((p) => p.name).join(', ')}`)
        return added
      },
      'presets:shippedRole': (presetId) => this.shippedRole(this.requirePreset(presetId)),
      'presets:applyToOperators': (presetId, operatorIds) => {
        const preset = this.requirePreset(presetId)
        const targets = operatorIds ?? store.operatorsOfPreset(presetId).map((o) => o.id)
        const updated: Operator[] = []
        for (const id of targets) {
          if (this.requireOperator(id).kind === 'master') throw bad('The Master Terminal has no preset')
          updated.push(store.applyPresetToOperator(id, presetId))
          this.configChanged(id)
        }
        this.log('preset', `Preset ${preset.name} applied to ${updated.length} operator${updated.length === 1 ? '' : 's'}`)
        return updated
      },
      'presets:saveFromOperator': (operatorId, name) => {
        this.requireOperator(operatorId)
        const preset = store.presetFromOperator(operatorId, cleanName(name, 'The preset name'))
        this.log('preset', `Preset ${preset.name} saved from ${store.operatorAddress(operatorId)}`, operatorId)
        this.configChanged(operatorId)
        return preset
      },
      'presets:revertOperator': async (operatorId) => {
        const operator = this.requireOperator(operatorId)
        const preset = operator.presetId == null ? null : store.getPreset(operator.presetId)
        if (!preset) throw bad('This operator has no preset to revert to')
        const { id: _i, builtin: _b, name: _n, roleText: _r, updatedAt: _u, skills: _s, hindsight: _h, codegraph: _c, mcpServers: _m, ...launch } = preset
        // Through applyChange, so a running operator restarts when the plan says so.
        const { operator: after } = await this.applyChange(operatorId, { ...launch, roleText: null })
        this.log('operator', `${store.operatorAddress(operatorId)} reverted to preset ${preset.name}`, operatorId)
        return after
      },
    }
  }

  private teamHandlers(): Group<'teams'> {
    const store = this.store
    const requireTeam = (teamId: number) => {
      const team = typeof teamId === 'number' ? store.getTeam(teamId) : null
      if (!team) throw notFound(`Team ${String(teamId)} not found`)
      return team
    }
    const rules = (v: unknown): string => {
      if (typeof v !== 'string') throw bad('Rules must be text')
      if (v.length > ROLE_TEXT_MAX) throw bad(`Rules are longer than ${ROLE_TEXT_MAX} characters`)
      return v
    }
    const description = (v: unknown): string => {
      if (typeof v !== 'string') throw bad('The description must be text')
      if (v.length > 500) throw bad('The description is longer than 500 characters')
      return v
    }
    return {
      'teams:list': () => store.listTeams(),
      'teams:create': (input) => {
        const team = store.createTeam({
          name: cleanName(input.name, 'The team name'),
          seats: input.seats === undefined ? [] : cleanSeats(store, input.seats),
          limits: cleanLimits(input.limits) as TeamLimits,
          rules: input.rules === undefined ? '' : rules(input.rules),
          description: input.description === undefined ? '' : description(input.description),
        })
        this.log('team', `Team ${team.name} created`)
        return team
      },
      'teams:update': (teamId, patch) => {
        requireTeam(teamId)
        const next: TeamPatch = {}
        if (patch.name !== undefined) next.name = cleanName(patch.name, 'The team name')
        if (patch.seats !== undefined) next.seats = cleanSeats(store, patch.seats)
        if (patch.limits !== undefined) next.limits = cleanLimits(patch.limits) as TeamLimits
        if (patch.rules !== undefined) next.rules = rules(patch.rules)
        if (patch.description !== undefined) next.description = description(patch.description)
        const team = store.updateTeam(teamId, next)
        this.log('team', `Team ${team.name} updated`)
        return team
      },
      'teams:delete': (teamId) => {
        const team = requireTeam(teamId)
        if (team.builtin != null) throw bad(`${team.name} is a built-in team and cannot be deleted. Hide it instead.`)
        store.deleteTeam(teamId)
        this.log('team', `Team ${team.name} deleted`)
      },
      'teams:duplicate': (teamId, name) => {
        const src = requireTeam(teamId)
        const copy = store.duplicateTeam(teamId, name === undefined ? undefined : cleanName(name, 'The team name'))
        this.log('team', `Team ${src.name} duplicated as ${copy.name}`)
        return copy
      },
      'teams:reset': (teamId) => {
        if (requireTeam(teamId).builtin == null) throw bad('Only built-in teams can be reset')
        try {
          const team = store.resetTeam(teamId)
          this.log('team', `Team ${team.name} reset to its shipped values`)
          return team
        } catch (e) {
          throw bad(e instanceof Error ? e.message : String(e))
        }
      },
      'teams:setHidden': (teamId, hidden) => {
        const team = requireTeam(teamId)
        if (team.builtin == null) throw bad('Only built-in teams can be hidden. Delete a team of your own instead.')
        return store.setTeamHidden(teamId, hidden === true)
      },
      'teams:export': async (teamId) => {
        const teams = teamId === undefined ? store.listTeams() : [requireTeam(teamId)]
        return { saved: await this.saveExport(exportTeams(store, teams)) }
      },
      'teams:importPreview': async () => {
        const path = await this.fileDialogs?.open({ name: 'Operant teams', extensions: ['json'] })
        if (!path) return null
        const items = parseTeamFile(store, readFileSync(path, 'utf8'))
        this.pendingTeamImport = path
        return { path, entries: items.map((i) => i.entry) }
      },
      'teams:import': (path) => {
        if (path !== this.pendingTeamImport) throw bad('Choose the file again before importing')
        const added = parseTeamFile(store, readFileSync(path, 'utf8')).flatMap((i) => (i.input ? [store.createTeam({ ...i.input, name: store.teamNameFree(i.input.name, null) })] : []))
        this.pendingTeamImport = null
        this.log('team', `Imported ${added.length} team${added.length === 1 ? '' : 's'}`)
        return added
      },
    }
  }

  private modelHandlers(): Group<'models'> {
    return {
      'models:list': (agent, refresh) => {
        if (agent !== 'claude' && agent !== 'opencode') throw bad('agent must be claude or opencode')
        return listModels(agent, { refresh: refresh === true })
      },
    }
  }

  private discordHandlers(): Group<'discord'> {
    const d = this.discord
    return {
      'discord:list': () => d.list(),
      'discord:create': (input) => d.create(input),
      'discord:update': (botId, patch) => d.update(botId, patch),
      'discord:delete': (botId) => d.delete(botId),
      'discord:setToken': (botId, token) => d.setToken(botId, token),
      'discord:clearToken': (botId) => d.clearToken(botId),
      'discord:connect': (botId) => d.connect(botId),
      'discord:disconnect': (botId) => d.disconnect(botId),
      'discord:health': () => d.health(),
      'discord:test': (botId) => d.test(botId),
      'discord:testAi': (botId, ai) => d.testAi(botId, ai),
      'discord:localModels': (url) => d.localModels(url),
      'discord:pairings': (botId) => d.pairingsOf(botId),
      'discord:approvePairing': (botId, code) => d.approvePairing(botId, code),
      'discord:denyPairing': (botId, code) => d.denyPairing(botId, code),
    }
  }

  private runHandlers(): Group<'runs'> {
    const store = this.store
    const requireRun = (runId: number) => {
      const run = typeof runId === 'number' ? store.getRun(runId) : null
      if (!run) throw notFound(`Job ${String(runId)} not found`)
      return run
    }
    return {
      'runs:list': (crewId) => store.listRuns(this.requireCrew(crewId).id),
      'runs:get': (runId) => requireRun(runId),
      'runs:create': (input) => {
        const run = this.runs.submit(input)
        this.log('job', `JOB#${run.id} ${run.status}: ${run.task.slice(0, 80)}`, null, run.crewId)
        return run
      },
      'runs:stop': async (runId) => {
        requireRun(runId)
        const run = await this.runs.stop(runId)
        this.log('job', `JOB#${run.id} stopped`, null, run.crewId)
        return run
      },
      'runs:agents': (runId) => store.listJobAgents(requireRun(runId).id),
      'runs:update': (runId, patch) => {
        requireRun(runId)
        return this.runs.update(runId, patch)
      },
      'runs:delete': (runId) => {
        const run = requireRun(runId)
        this.runs.remove(runId)
        this.log('job', `JOB#${run.id} deleted`, null, run.crewId)
      },
      'runs:agentLog': (runId, agentId) => this.runServices.agentLog(requireRun(runId).id, agentId),
      'runs:getLimit': () => this.runs.concurrency,
      'runs:setLimit': (limit) => this.runs.setConcurrency(limit),
    }
  }

  private jobHandlers(): Group<'jobs'> & Group<'tasks'> {
    const store = this.store
    const db = store.db
    return {
      'jobs:list': (crewId, open) => this.jobs.list(USER, this.requireCrew(crewId).id, { open: open === true }),
      'jobs:get': (jobId) => this.jobs.get(USER, jobId),
      'jobs:create': (input) => this.jobs.create(USER, input),
      'jobs:update': (jobId, patch) => {
        const { state, assigneeId, deps, ...edit } = patch
        // One transaction: the engine joins it with a savepoint, so a refused part leaves the job as it was.
        db.exec('BEGIN IMMEDIATE')
        try {
          let job = this.jobs.get(USER, jobId)
          if (Object.keys(edit).length > 0) job = this.jobs.edit(USER, jobId, edit)
          if (deps !== undefined) {
            const want = new Set(deps)
            for (const d of job.deps) if (!want.has(d)) this.jobs.removeDep(USER, jobId, d)
            for (const d of want) if (!job.deps.includes(d)) this.jobs.addDep(USER, jobId, d)
          }
          if (state !== undefined) this.jobs.override(USER, jobId, { state, assigneeId })
          else if (assigneeId !== undefined) this.jobs.reassign(USER, jobId, assigneeId)
          db.exec('COMMIT')
        } catch (err) {
          if (db.isTransaction) db.exec('ROLLBACK')
          throw err
        }
        return this.jobs.get(USER, jobId)
      },
      'jobs:delete': (jobId) => this.jobs.delete(USER, jobId),
      'jobs:approve': (jobId, note) => this.jobs.approve(USER, jobId, note),
      'jobs:reject': (jobId, reason) => this.jobs.reject(USER, jobId, reason),
      'jobs:approveStart': (jobId) => this.jobs.approveStart(USER, jobId),
      'jobs:escalate': (jobId, reason) => this.jobs.escalate(USER, jobId, reason),
      'jobs:move': (jobId, patch) => this.jobs.override(USER, jobId, patch),
    }
  }

  private linkHandlers(): Group<'links'> {
    const store = this.store
    return {
      'links:list': (crewId) => store.listLinks(this.requireCrew(crewId).id),
      'links:create': ({ crewId, fromId, toId, label }) => {
        this.requireCrew(crewId)
        const link = store.createLink(crewId, fromId, toId, this.linkLabel(label))
        this.log('link', `Link ${store.operatorAddress(fromId)} to ${store.operatorAddress(toId)} added`, null, crewId)
        return link
      },
      'links:update': (linkId, patch) => {
        const cur = store.getLink(linkId)
        if (!cur) throw notFound(`Link ${String(linkId)} not found`)
        const link = store.updateLink(linkId, { ...patch, ...(patch.label !== undefined ? { label: this.linkLabel(patch.label) } : {}) })
        this.log('link', `Link ${store.operatorAddress(link.fromId)} to ${store.operatorAddress(link.toId)} updated`, null, cur.crewId)
        return link
      },
      'links:delete': (linkId) => {
        const cur = store.getLink(linkId)
        if (!cur) throw notFound(`Link ${String(linkId)} not found`)
        store.deleteLink(linkId)
        this.log('link', `Link ${store.operatorAddress(cur.fromId, true)} to ${store.operatorAddress(cur.toId, true)} removed`, null, cur.crewId)
      },
    }
  }

  private linkLabel(label: unknown): string {
    if (label === undefined) return ''
    if (typeof label !== 'string' || label.length > NAME_MAX) throw bad(`A link label is up to ${NAME_MAX} characters`)
    return label.trim()
  }

  private messageHandlers(): Group<'messages'> {
    const store = this.store
    const crewOfMessage = (id: number): number => {
      const m = typeof id === 'number' ? store.getMessage(id) : null
      if (!m) throw notFound(`Message ${String(id)} not found`)
      return m.crewId
    }
    return {
      'messages:list': (crewId, filter = {}) => this.messages.list(this.requireCrew(crewId).id, filter),
      'messages:send': ({ crewId, to, body, jobId }) => {
        const user = this.userActor(crewId)
        let target = to
        if (typeof to === 'number') {
          const op = this.requireOperator(to)
          if (store.crewIdOfOperator(op.id) !== crewId) throw notFound(`Operator ${to} not found`)
          target = op.kind === 'master' ? 'master' : op.role
        }
        return this.messages.send(user, String(target), body, { jobId }).messages
      },
      'messages:edit': (messageId, body) => this.messages.edit({ kind: 'user', crewId: crewOfMessage(messageId) }, messageId, body),
      'messages:delete': (messageId) => this.messages.delete({ kind: 'user', crewId: crewOfMessage(messageId) }, messageId),
      'messages:markRead': (crewId, ids) => this.messages.markRead(this.userActor(crewId), ids),
      'messages:unread': (crewId) => this.messages.unreadCounts(this.requireCrew(crewId).id),
      'messages:answer': (askId, approved, note) =>
        this.messages.answer({ kind: 'user', crewId: crewOfMessage(askId) }, askId, approved === true, note).messages,
    }
  }

  private viewHandlers(): Group<'views'> & Group<'tiles'> {
    const store = this.store
    return {
      'views:get': (crewId) => store.getCrewView(this.requireCrew(crewId).id),
      'views:set': (crewId, view) => {
        this.requireCrew(crewId)
        if (!VIEWS.has(view)) throw bad('The view must be cards, list, graph or tiles')
        const crew = store.setCrewView(crewId, view)
        this.log('view', `Project ${crew.name} shows the ${view} view`, null, crewId)
        return crew
      },
      'tiles:getLayout': (crewId) => store.getTileLayout(this.requireCrew(crewId).id),
      'tiles:saveLayout': (crewId, layout) => {
        this.requireCrew(crewId)
        const text = JSON.stringify(layout ?? {})
        if (text === undefined || text.length > TILE_LAYOUT_MAX) throw bad('The tile layout is too large')
        store.setTileLayout(crewId, layout)
      },
    }
  }

  private scratchHandlers(): Group<'scratch'> {
    const store = this.store
    const check = (p: { title?: unknown; agent?: AgentKind; model?: string; effort?: string; presetId?: number | null }, agent: AgentKind) => {
      if (p.agent !== undefined && !AGENTS.has(p.agent)) throw bad('The agent must be claude, codex or shell')
      validateLaunchSettings({ agent, ...(p.model !== undefined ? { model: p.model.trim() } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}) })
      if (p.presetId != null) this.requirePreset(p.presetId)
    }
    const cwd = (v: unknown): string => {
      if (typeof v !== 'string' || !v.trim() || /[\0-\x1f\x7f]/.test(v)) throw bad('The folder is not valid')
      return v.trim()
    }
    return {
      'scratch:list': (crewId) => store.listScratch(this.requireCrew(crewId).id),
      'scratch:create': (input) => {
        const crew = this.requireCrew(input.crewId)
        check(input, input.agent)
        const scratch = store.createScratch({
          crewId: crew.id,
          title: cleanName(input.title, 'The title'),
          agent: input.agent,
          model: input.model?.trim() ?? '',
          effort: input.effort ?? '',
          presetId: input.presetId ?? null,
          cwd: input.cwd === undefined ? crew.folder : cwd(input.cwd),
        })
        this.log('scratch', `Tile ${scratch.title} created`, null, crew.id)
        return scratch
      },
      'scratch:update': (scratchId, patch) => {
        const cur = this.requireScratch(scratchId)
        check(patch, patch.agent ?? cur.agent)
        const scratch = store.updateScratch(scratchId, {
          ...(patch.title !== undefined ? { title: cleanName(patch.title, 'The title') } : {}),
          ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
          ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.presetId !== undefined ? { presetId: patch.presetId } : {}),
          ...(patch.cwd !== undefined ? { cwd: cwd(patch.cwd) } : {}),
        })
        this.log('scratch', `Tile ${scratch.title} updated`, null, scratch.crewId)
        return scratch
      },
      'scratch:delete': (scratchId) => {
        const scratch = this.requireScratch(scratchId)
        this.sessions.stop(this.scratchKey(scratchId))
        this.detachScratch(scratchId)
        store.deleteScratch(scratchId)
        this.log('scratch', `Tile ${scratch.title} deleted`, null, scratch.crewId)
      },
      'scratch:start': (scratchId, resume) => {
        this.requireScratch(scratchId)
        return this.startScratch(scratchId, { resume: resume === true })
      },
      'scratch:status': (scratchId) => {
        this.requireScratch(scratchId)
        return this.scratchStatus(scratchId)
      },
      'scratch:spend': (crewId) => store.scratchSpend(this.requireCrew(crewId).id, this.now() - 24 * 60 * 60 * 1000),
      'scratch:stop': (scratchId) => {
        this.requireScratch(scratchId)
        this.stopScratch(scratchId)
      },
      'scratch:write': (scratchId, data) => this.sessions.write(this.scratchKey(scratchId), data),
      'scratch:resize': (scratchId, cols, rows) => this.sessions.resize(this.scratchKey(scratchId), cols, rows),
      'scratch:buffer': (scratchId) => this.sessions.buffer(this.scratchKey(scratchId)),
    }
  }

  private usageHandlers(): Group<'usage'> & Group<'caps'> & Group<'purge'> {
    const store = this.store
    return {
      ...this.reportHandlers(),
      'usage:series': (crewId) => {
        // Last 24 hours in hourly buckets, oldest first.
        const since = Math.floor(this.now() / HOUR) * HOUR - 23 * HOUR
        return store.spendSeries(crewId, since, HOUR, 24)
      },
      'usage:breakdown': (crewId, period) => {
        this.requireCrew(crewId)
        if (!PERIODS.has(period)) throw bad('The period must be 24h, 7d or 30d')
        return usageBreakdown({ store, usage: this.usage, now: this.now, settings: () => this.settings }, crewId, period)
      },
      'caps:status': () => this.capStatus(),
      'caps:reset': (target) => {
        if (target !== 'daily') this.requireOperator(target)
        this.resetCap(target)
        return this.capStatus()
      },
      'purge:status': () => ({
        enabled: this.settings.collab.purgeEnabled,
        retentionDays: this.settings.collab.purgeRetentionDays,
        candidates: (store.db.prepare('SELECT id, deleted_at FROM operators WHERE deleted_at IS NOT NULL ORDER BY id').all() as Array<{ id: number; deleted_at: number }>).map((r) => {
          const id = Number(r.id)
          const check = this.purger.eligible(id)
          return {
            operatorId: id,
            label: store.operatorAddress(id, true) ?? `operator ${id}`,
            crewId: store.crewIdOfOperator(id, true),
            deletedAt: Number(r.deleted_at),
            eligible: check.ok,
            blockers: check.blockers,
          }
        }),
      }),
      'purge:now': (target) => {
        const results = this.purger.purgeNow(target)
        return results.map((r) => ({ operatorId: r.operatorId, label: r.label, purged: r.purged, blockers: r.blockers }))
      },
    }
  }

  private graphHandlers(): Group<'graph'> {
    const store = this.store
    return {
      'graph:get': (crewId, window = '24h') => {
        this.requireCrew(crewId)
        if (!WINDOWS.has(window)) throw bad('The window must be 1h, 24h or all')
        return graphData(store, this.now, crewId, window)
      },
      'graph:savePositions': (crewId, positions) => {
        this.requireCrew(crewId)
        if (!Array.isArray(positions) || positions.length > 500) throw bad('Too many positions')
        for (const p of positions) {
          if (!p || typeof p.nodeKey !== 'string' || !NODE_KEY_RE.test(p.nodeKey) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            throw bad('A node position is not valid')
          }
        }
        store.saveNodePositions(crewId, positions)
      },
      'graph:clear': (crewId) => store.clearNodePositions(this.requireCrew(crewId).id),
    }
  }

  private mcpHandlers(): Group<'mcp'> {
    const folderOf = (crewId: number | null): string | null => (crewId == null ? null : this.requireCrew(crewId).folder)
    // Refusals from the CLIs and config files reach the page as plain messages.
    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn()
      } catch (err) {
        throw err instanceof McpError ? bad(err.message) : err
      }
    }
    return {
      'mcp:list': (crewId, refresh) => guard(() => (refresh ? this.mcp.list(folderOf(crewId)) : this.mcp.cached(folderOf(crewId)))),
      'mcp:add': (crewId, input) => guard(() => this.mcp.add(folderOf(crewId), input)),
      'mcp:update': (crewId, id, input) => guard(() => this.mcp.update(folderOf(crewId), id, input)),
      'mcp:setEnabled': (crewId, id, enabled) => guard(() => this.mcp.setEnabled(folderOf(crewId), id, enabled === true)),
      'mcp:remove': (crewId, id) => guard(() => this.mcp.remove(folderOf(crewId), id)),
      'mcp:health': async () => {
        const presets = new Map(this.store.listPresets().map((p) => [p.id, p]))
        const needs = this.store.listTeams().flatMap((t) =>
          t.seats.flatMap((s) => {
            const p = presets.get(s.presetId)
            return p && p.mcpServers.length ? [{ seat: p.name, servers: p.mcpServers }] : []
          }),
        )
        return needs.length ? guard(() => this.mcp.down(needs, null)) : []
      },
    }
  }

  // The local model server client's key, read per call from the encrypted store.
  private localLlm(): LocalLlmDeps {
    return { apiKey: () => this.secrets.get(LOCAL_LLM_KEY) }
  }

  private miscHandlers(): Group<'health'> & Group<'hindsight'> & Group<'learn'> & Group<'index'> & Group<'events'> & Group<'dashboard'> & Group<'settings'> {
    const store = this.store
    const indexes = this.indexes
    return {
      'index:status': (crewId) => {
        const crew = store.getCrew(crewId)
        return crew ? indexes.status(crew.folder) : null
      },
      'index:run': (crewId) => this.runIndex(crewId),
      'health:project': async (crewId) => {
        const health = await this.runServices.health(this.requireCrew(crewId).id)
        return health!
      },
      'hindsight:status': () => this.runServices.hindsightStatus(),
      'learn:status': (crewId) => this.learn.status(crewId),
      'learn:run': (runId) => this.learn.learnRun(runId),
      'learn:ai': () => resolveLearnAi(this.settings.learn, learnModelList(() => this.settings.learn, this.localLlm())),
      'learn:localModels': async () => {
        const r = await learnModelList(() => this.settings.learn, this.localLlm())('local')
        return { models: r.models, ...(r.error ? { error: r.error } : {}) }
      },
      'learn:localKey': () => this.secrets.get(LOCAL_LLM_KEY) !== null,
      'learn:setLocalKey': (key) => {
        const k = String(key ?? '').trim()
        if (k) this.secrets.set(LOCAL_LLM_KEY, k)
        else this.secrets.delete(LOCAL_LLM_KEY)
        return this.secrets.get(LOCAL_LLM_KEY) !== null
      },
      'learn:test': () => this.learn.testAi(),
      'learn:lessons': (filter) => this.learn.lessons(filter),
      'learn:editLesson': (id, patch) => this.learn.editLesson(id, patch),
      'learn:mergeLessons': (keepId, mergeIds) => this.learn.mergeLessons(keepId, mergeIds),
      'learn:setLessonStatus': (id, status) => this.learn.setLessonStatus(id, status),
      'learn:moveLesson': (id, from, to) => this.learn.moveLesson(id, from, to),
      'learn:hindsightEntries': (crewId, query) => this.learn.hindsightEntries(crewId, query),
      'learn:memoryFiles': (crewId) => this.learn.memoryFiles(crewId),
      'learn:drafts': (crewId, status) => this.learn.drafts(crewId).filter((d) => !status || d.status === status),
      'learn:editDraft': (id, patch) => this.learn.editDraft(id, patch),
      'learn:approveDraft': (id) => this.learn.approveDraft(id),
      'learn:rejectDraft': (id) => this.learn.rejectDraft(id),
      'learn:deleteDraft': (id) => this.learn.deleteDraft(id),
      'hindsight:act': (action) => {
        if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new OperantError('BAD_ARGS', 'Action must be start, stop or restart')
        return this.runServices.hindsightAct(action)
      },
      'hindsight:adapters': () => listAdapters(),
      'hindsight:test': () => this.hindsight.test(),
      'hindsight:keyState': () => ({ shared: this.secrets.get(HINDSIGHT_KEY.shared) !== null, remote: this.secrets.get(HINDSIGHT_KEY.remote) !== null }),
      'hindsight:setKey': (slot, key) => {
        const k = typeof key === 'string' ? key.trim() : ''
        if (k.length < 8 || /\s/.test(k)) throw bad('An API key is at least 8 characters with no spaces')
        this.secrets.set(HINDSIGHT_KEY[slotOf(slot)], k)
        return { shared: this.secrets.get(HINDSIGHT_KEY.shared) !== null, remote: this.secrets.get(HINDSIGHT_KEY.remote) !== null }
      },
      'hindsight:clearKey': (slot) => {
        this.secrets.delete(HINDSIGHT_KEY[slotOf(slot)])
        return { shared: this.secrets.get(HINDSIGHT_KEY.shared) !== null, remote: this.secrets.get(HINDSIGHT_KEY.remote) !== null }
      },
      // The one time a key is shown: right after it is made, so it can be copied to the other machines.
      'hindsight:generateKey': () => {
        const key = generateApiKey()
        this.secrets.set(HINDSIGHT_KEY.shared, key)
        return key
      },
      'events:recent': (limit) => store.recentEvents(limit),
      'dashboard:summary': () => {
        const crews = store.listCrews()
        const operators = crews.flatMap((r) => store.topology(r.id)?.squads.flatMap((p) => p.operators) ?? [])
        const tasks = crews.flatMap((r) => store.listJobs(r.id))
        return {
          operatorsRunning: operators.filter((s) => s.status === 'running').length,
          operatorsTotal: operators.length,
          tasksOpen: tasks.filter((t) => t.state !== 'done').length,
          spendToday: store.spendSince(startOfDay(this.now())),
          dailyBudgetUsd: this.settings.dailyBudgetUsd,
        }
      },
      'settings:get': () => this.settings,
      'settings:set': (patch) => this.saveSettings(mergeSettings(this.settings, patch)),
      'settings:reset': (section) => {
        if (!(section in DEFAULT_SETTINGS)) throw bad(`Unknown settings section "${String(section)}"`)
        return this.saveSettings(sanitizeSettings({ ...this.settings, [section]: DEFAULT_SETTINGS[section] }))
      },
    }
  }

  private saveSettings(next: Settings): Settings {
    this.settings = next
    this.store.setJson('settings', this.settings)
    this.applySettings()
    this.emit('settings', this.settings)
    return this.settings
  }

  private crewRunning(crewId: number): number {
    let n = 0
    for (const id of this.live) if (this.store.crewIdOfOperator(id) === crewId) n++
    for (const s of this.store.listScratch(crewId)) if (this.sessions.isRunning(this.scratchKey(s.id))) n++
    return n
  }

  private crewCounts(crewId: number): CrewCounts {
    const count = (sql: string) => Number((this.store.db.prepare(sql).get(crewId) as { n: number }).n)
    const topology = this.store.topology(crewId)
    return {
      squads: topology?.squads.length ?? 0,
      operators: topology?.squads.reduce((n, s) => n + s.operators.length, 0) ?? 0,
      running: this.crewRunning(crewId),
      jobs: count('SELECT COUNT(*) AS n FROM jobs WHERE crew_id = ?'),
      openJobs: count("SELECT COUNT(*) AS n FROM jobs WHERE crew_id = ? AND state <> 'done'"),
      messages: count('SELECT COUNT(*) AS n FROM messages WHERE crew_id = ?'),
      scratch: this.store.listScratch(crewId).length,
      lessons: count('SELECT COUNT(*) AS n FROM lessons WHERE crew_id = ?'),
      spendUsd: this.store.spendSince(0, crewId),
    }
  }

  private reportHandlers(): Pick<Handlers, 'usage:report' | 'usage:timeseries' | 'usage:job' | 'usage:exportText' | 'usage:export'> {
    const deps = () => ({ store: this.store, now: this.now })
    const checkView = (view: UsageView): UsageView => {
      if (!view || typeof view !== 'object') throw bad('Unknown view')
      if (view.kind === 'job') this.requireRun(view.runId)
      if (view.kind === 'report') return { kind: 'report', query: { ...view.query, filter: cleanFilter(view.query?.filter) } }
      if (view.kind === 'series') return { kind: 'series', query: { ...view.query, filter: cleanFilter(view.query?.filter) } }
      return view
    }
    const query = (q: UsageQuery): UsageQuery => ({ ...q, filter: cleanFilter(q?.filter) })
    return {
      'usage:report': (q) => queryUsage(deps(), query(q)),
      'usage:timeseries': (q) => querySeries(deps(), { ...q, filter: cleanFilter(q?.filter) }),
      'usage:job': (runId) => jobUsage(deps(), this.requireRun(runId).id),
      'usage:exportText': (view, format) => exportView(deps(), checkView(view), format),
      'usage:export': async (view, format) => ({ saved: await this.saveExport(exportView(deps(), checkView(view), format)) }),
    }
  }

  private moveHandlers(): Group<'budgets'> & Group<'import'> & Group<'data'> & Group<'providers'> {
    const bundleText = (): ExportText => ({
      filename: `operant-export-${new Date(this.now()).toISOString().slice(0, 10)}.json`,
      mime: 'application/json',
      text: JSON.stringify(exportBundle(this.store, this.now()), null, 2),
    })
    return {
      'budgets:get': () => this.budgetStatus(),
      'budgets:set': (patch) => {
        this.budgetConfig = mergeBudgets(this.budgetConfig, patch)
        this.store.setJson(BUDGETS_KEY, this.budgetConfig)
        this.checkBudgets()
        this.runs.pumpAll()
        return this.budgetStatus()
      },
      'budgets:resume': (target) => {
        if (target?.scope === 'day') this.resetCap('daily')
        else if (target?.scope === 'project') this.budgets.resume({ scope: 'project', crewId: this.requireCrew(target.crewId).id })
        else if (target?.scope === 'job') this.budgets.resume({ scope: 'job', runId: this.requireRun(target.runId).id })
        else throw bad('The target must be the day, a project or a job')
        this.checkBudgets()
        this.runs.pumpAll()
        return this.budgetStatus()
      },
      'import:preview': (source) => previewRead(this.store, readSource(this.importSource(source), this.importDeps)),
      'import:apply': (source) => {
        const result = applyRead(this.store, readSource(this.importSource(source), this.importDeps))
        if (result.applied) this.log('import', `Imported ${result.projects.add} projects, ${result.presets.add} presets and ${result.usage.add} usage rows from ${result.location}`)
        return result
      },
      'import:pickFile': () => this.pickFile(),
      'data:export': () => bundleText(),
      'data:exportFile': async () => ({ saved: await this.saveExport(bundleText()) }),
      'providers:status': () => this.providers.status(),
      'providers:refresh': () => this.providers.refresh(true),
    }
  }

  private importSource(source: ImportSource): ImportSource {
    if (source?.kind === 'legacy') {
      const dir = typeof source.dir === 'string' && source.dir.trim() ? { dir: source.dir.trim() } : {}
      const rolesDir = typeof source.rolesDir === 'string' && source.rolesDir.trim() ? { rolesDir: source.rolesDir.trim() } : {}
      return { kind: 'legacy', ...dir, ...rolesDir }
    }
    if (source?.kind === 'file' && typeof source.path === 'string' && source.path.trim()) return { kind: 'file', path: source.path.trim() }
    throw bad('Choose Operant 2.8.2 data or an export file to import')
  }

  private async pickFile(): Promise<string | null> {
    return (await this.fileDialogs?.open({ name: 'Operant export', extensions: ['json'] })) ?? null
  }

  // Writes export text to the path the user picked; null when they cancelled.
  private async saveExport(out: ExportText): Promise<string | null> {
    if (!this.fileDialogs) throw bad('This build cannot ask where to save: use the copy or download option')
    const ext = out.filename.split('.').pop() ?? 'txt'
    const path = await this.fileDialogs.save(out.filename, { name: ext.toUpperCase(), extensions: [ext] })
    if (!path) return null
    writeFileSync(path, out.text, 'utf8')
    return path
  }

  // Run usage: sessions, ingest, budgets

  private noteRunSession(run: Run, sessionId: string): void {
    const crew = this.store.getCrew(run.crewId)
    if (crew) this.store.setJson(`run.session.${run.id}`, { cli: run.masterCli, cwd: crew.folder, sessionId })
  }

  private runSource(runId: number): RunSource | null {
    const v = this.store.getJson(`run.session.${runId}`) as Partial<RunSource> | undefined
    return v && typeof v.sessionId === 'string' && typeof v.cwd === 'string' && (v.cli === 'claude' || v.cli === 'opencode') ? (v as RunSource) : null
  }

  // Reads the new transcript lines of every working job and of the front desk; re-checks the caps when spend came in.
  pollRunUsage(): void {
    let rows = 0
    try {
      for (const run of this.store.listRuns()) {
        if (run.status !== 'working' && run.status !== 'needs-you') continue
        const src = this.runSource(run.id)
        if (src) rows += this.ingest.syncRun(run, src)
      }
      rows += this.ingest.syncFrontDesk()
    } catch (err) {
      this.log('error', `Job usage could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (rows > 0) this.usage.checkCaps()
    this.checkBudgets()
    this.runs.enforceTokenBudgets()
    if (this.store.listRuns().some((r) => r.status === 'queued')) this.runs.pumpAll()
  }

  // Every token (input, output, cache) of the usage attributed to the run, as the job's usage view counts them.
  private runTokens(runId: number): number {
    const row = this.store.db
      .prepare('SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_w5m + cache_w1h), 0) AS t FROM usage WHERE run_id = ?')
      .get(runId) as { t: number }
    return Number(row.t)
  }

  // The last read of a finished job, once its agent list is final.
  // A finished run on a project with a tracker file opens (or extends) the project manager's "Update tracker" job.
  private trackerJob(crewId: number, run: Run, files: string[]): void {
    try {
      const crew = this.store.getCrew(crewId)
      if (!crew?.trackerFile || !crew.trackerJobs || !this.settings.collab.trackerJobs) return
      refreshTrackerJob(this.jobs, crew, run, files)
    } catch (err) {
      this.log('error', `Tracker job: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private finishRunUsage(run: Run): void {
    const src = this.runSource(run.id)
    if (!src || this.store.getJson(`run.usage.done.${run.id}`)) return
    try {
      this.ingest.syncRun(run, src)
      this.ingest.forget(src)
      this.store.setJson(`run.usage.done.${run.id}`, true)
    } catch (err) {
      this.log('error', `JOB#${run.id} usage could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.usage.checkCaps()
    this.checkBudgets()
  }

  // Jobs that ended while Operant was closed (or before this version recorded their usage) are read once.
  private backfillRunUsage(): void {
    for (const run of this.store.listRuns()) if (run.status === 'done' || run.status === 'failed') this.finishRunUsage(run)
  }

  // Why a queued job of the project must wait: the daily budget or the project's / a job's cap (empty = it may start).
  private runHold(crewId: number): string {
    if (this.budgetConfig.pauseQueue && this.usage.caps.dailyPaused()) return 'The daily budget is reached'
    return this.budgets.projectHeld(crewId)
  }

  private checkBudgets(): BudgetDecision[] {
    const decisions = this.budgets.check()
    for (const d of decisions) this.onBudget(d)
    return decisions
  }

  private onBudget(d: BudgetDecision): void {
    const crew = this.store.getCrew(d.crewId)
    const label = d.scope === 'job' ? `JOB#${d.runId}` : `Project ${crew?.name ?? d.crewId}`
    const money = `$${d.spentUsd.toFixed(2)} of $${d.capUsd.toFixed(2)}`
    const stops = d.scope === 'job' && this.budgetConfig.stopJobAtCap
    if (d.action === 'warn') this.log('budget', `${label} is at ${Math.floor(d.pct)}% of its budget (${money})`, null, d.crewId)
    else this.log('budget', `${label} reached its budget (${money}); ${stops ? 'the job is stopped and ' : ''}queued jobs wait until it is raised or resumed`, null, d.crewId)
    this.emit('caps', { action: d.action, scope: d.scope, operatorId: null, crewId: d.crewId, ...(d.runId !== undefined ? { runId: d.runId } : {}), spentUsd: d.spentUsd, capUsd: d.capUsd, pct: d.pct })
    if (stops && d.runId !== undefined && d.action === 'pause') void this.runs.stop(d.runId, 'Stopped: the job reached its budget').catch(() => undefined)
  }

  private budgetStatus(): BudgetStatus {
    const held = this.budgets.heldProjects().map((h) => ({ crewId: h.crewId as number | null, reason: h.reason }))
    if (this.budgetConfig.pauseQueue && this.usage.caps.dailyPaused()) held.unshift({ crewId: null, reason: 'The daily budget is reached' })
    return { config: this.budgetConfig, day: this.capStatus().daily, ...this.budgets.progress(), held }
  }

  private capStatus(): CapStatus {
    const spent = this.store.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS t FROM usage WHERE operator_id = ? AND at >= ?')
    const operators: Record<number, CapProgress> = {}
    for (const crew of this.store.listCrews()) {
      const list = [...(this.store.topology(crew.id)?.squads.flatMap((s) => s.operators) ?? [])]
      const master = this.store.getMaster(crew.id)
      if (master) list.push(master)
      for (const op of list) {
        const cap = op.dailyCapUsd ?? this.settings.tokens.operatorDailyCapUsd
        if (cap <= 0) continue
        const used = Number((spent.get(op.id, this.usage.caps.windowStart(op.id)) as { t: number }).t)
        operators[op.id] = { capUsd: cap, spentUsd: used, pct: (used / cap) * 100, paused: this.usage.caps.isPaused(op.id) }
      }
    }
    const budget = this.settings.dailyBudgetUsd
    const used = this.store.spendSince(this.usage.caps.windowStart('daily'))
    return { daily: budget > 0 ? { capUsd: budget, spentUsd: used, pct: (used / budget) * 100, paused: this.usage.caps.dailyPaused() } : null, operators }
  }

  private shippedRole(preset: Preset): string {
    const file = preset.builtin ? ROLE_FILE_BY_PRESET[preset.builtin] : undefined
    return file ? (this.launch.readRole ?? ((f: string) => this.readShippedRole(f)))(file) : ''
  }

  get currentSettings(): Settings {
    return this.settings
  }

  // Startup seeds from .env (loaded by main): a Discord token goes into the encrypted store for the one bot that has
  // none, and the Hindsight URL and key fill settings that are still unset. Nothing already stored is overwritten.
  seedFromEnv(env: NodeJS.ProcessEnv): void {
    const token = (env.DISCORD_BOT_TOKEN ?? '').trim()
    const bare = token ? this.store.listDiscordBots().filter((b) => !b.tokenRef || this.secrets.get(b.tokenRef) === null) : []
    const bot = bare.length === 1 ? bare[0] : undefined
    if (token && !bot) this.logDiscord(bare.length === 0 ? 'DISCORD_BOT_TOKEN is set but there is no bot without a token to give it to, so it was not used (add a bot in Settings > Discord without a token, then restart Operant)' : 'DISCORD_BOT_TOKEN is set but more than one bot has no token, so it was not used (add a token to the right bot in Settings > Discord)')
    if (bot) {
      try {
        this.secrets.set(tokenRef(bot.id), token)
        this.store.updateDiscordBot(bot.id, { tokenRef: tokenRef(bot.id) })
        this.logDiscord(`Discord token from .env imported into the encrypted store for bot ${bot.name}; you can delete it from .env`)
      } catch {
        this.logDiscord('Discord token from .env could not be imported: the encrypted store is unavailable')
      }
    }
    const url = (env.HINDSIGHT_URL ?? '').trim()
    if (url && !this.settings.hindsight.url) {
      const next = sanitizeSettings({ ...this.settings, hindsight: { ...this.settings.hindsight, mode: 'remote', url } })
      if (next.hindsight.url) this.saveSettings(next)
    }
    const key = (env.HINDSIGHT_API_KEY ?? '').trim()
    if (key && this.settings.hindsight.mode === 'remote' && this.secrets.get(HINDSIGHT_KEY.remote) === null) {
      try {
        this.secrets.set(HINDSIGHT_KEY.remote, key)
      } catch {
        this.log('hindsight', 'Hindsight key from .env could not be stored: the encrypted store is unavailable')
      }
    }
  }

  // Lifecycle

  // Opens the CLI socket (a failure is logged, the timers start anyway), rebuilds the cap state from stored spend, sweeps once and starts the timers.
  async start(): Promise<void> {
    if (this.timers.length > 0) return
    if (this.cli) {
      try {
        await this.cli.listen()
      } catch (err) {
        // Without the socket operators started from now on get no CLI environment (`operant` exits 7).
        this.log('error', `The operant CLI socket could not be opened (${err instanceof Error ? err.name : 'unexpected error'}). Operators run without the operant CLI`)
      }
    }
    void this.discord.start()
    this.usage.checkCaps()
    this.purgeSweep()
    const every = (fn: () => void, ms: number) => this.timers.push(this.scheduler.every(fn, ms))
    this.runs.recover()
    this.runServices.sweepStaleLaunchFiles()
    this.backfillRunUsage()
    every(() => this.pollUsage(), USAGE_POLL_MS)
    every(() => this.nudgeTick(), NUDGE_TICK_MS)
    every(() => this.sweepJobs(), JOB_SWEEP_MS)
    every(() => this.purgeSweep(), HOUR)
    every(() => this.pollRunUsage(), RUN_USAGE_POLL_MS)
    // The monitor itself only asks a provider when its own interval (10 minutes) is due.
    every(() => void this.providers.refresh().catch(() => undefined), PROVIDER_TICK_MS)
  }

  stopTimers(): void {
    for (const h of this.timers.splice(0)) this.scheduler.cancel(h)
  }

  // Quit path: no more timers, jobs marked interrupted, every process Operant started killed by pid, every token
  // revoked, the socket closed. No step can hold the quit for more than shutdownStepMs. Sessions are the caller's.
  async shutdown(): Promise<void> {
    const bounded = async (work: () => Promise<unknown> | unknown): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.shutdownStepMs)))
      try {
        await Promise.race([Promise.resolve().then(work).catch(() => undefined), limit])
      } finally {
        clearTimeout(timer)
      }
    }
    this.stopTimers()
    await bounded(() => this.runs.interruptAll())
    await bounded(() => killAllOwn(this.shutdownStepMs))
    await bounded(() => this.discord.stop())
    if (this.cli) for (const id of this.live) this.cli.revokeToken(id)
    this.messages.close()
    await bounded(() => this.cli?.close())
  }

  // Timers

  // Reads new transcript lines for every running Claude operator.
  pollUsage(): void {
    this.usage.poll()
    let scratchRows = 0
    for (const id of [...this.scratchFeeds.keys()]) scratchRows += this.pollScratch(id)
    // Scratch spend counts toward the daily budget, so the global cap is re-evaluated.
    if (scratchRows > 0) this.usage.checkCaps()
  }

  // Types the nudge or /clear lines the scheduler decides on. Returns what it typed.
  nudgeTick(): NudgeAction[] {
    const now = this.now()
    const states: NudgeOperatorState[] = []
    for (const id of this.live) {
      const operator = this.store.getOperator(id)
      // The Master Terminal is the user's own session: it is never typed into on a timer.
      if (!operator || operator.kind === 'master') continue
      const unread = this.messages.unreadInfo(id)
      states.push({
        key: id,
        agent: operator.agent,
        idleMs: this.sessions.idleMs(id),
        unread: unread.count,
        newestUnreadAt: unread.newestAt ?? 0,
        urgent: unread.priority,
        paused: this.usage.caps.isPaused(id),
        clearBetweenJobs: operator.clearBetweenJobs,
        hasDoingJob: this.doingJob(id) != null,
        jobFinishedAt: this.finished.get(id),
      })
    }
    const typed: NudgeAction[] = []
    for (const action of this.nudge.tick(now, states)) {
      try {
        if (this.sessions.typeFixed(action.key, action.line)) typed.push(action)
      } catch (err) {
        this.log('error', `Could not type a ${action.kind} line: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return typed
  }

  sweepJobs(): void {
    try {
      this.jobs.sweep()
    } catch (err) {
      this.log('error', `Job sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  purgeSweep(): void {
    try {
      this.purger.sweep()
    } catch (err) {
      this.log('error', `Purge sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Notices from the engines

  onJobNotice(n: JobNotice): void {
    this.log('job', n.text, n.actorId, n.crewId)
    if ((n.kind === 'done' || n.kind === 'review') && n.actorId != null) this.finished.set(n.actorId, this.now())
    for (const to of n.to) {
      const target = to.kind === 'operator' ? to.id : to.kind === 'master' ? this.store.getMaster(n.crewId)?.id : 'user'
      if (target === undefined) continue
      try {
        this.messages.sendSystem(n.crewId, target, n.text, { jobId: n.jobId })
      } catch (err) {
        this.log('error', `Could not deliver a job notice: ${err instanceof Error ? err.message : String(err)}`, null, n.crewId)
      }
    }
    this.notices.emit('job', n)
    this.emit('job', { crewId: n.crewId, jobId: n.jobId, kind: n.kind })
  }

  onMessageNotice(n: MessageNotice): void {
    if (n.type === 'activity') this.emit('event', n.event)
    else if (n.type === 'message') this.emit('message', { crewId: n.crewId, messageId: n.messageId, change: n.change })
    else this.emit('unread', { crewId: n.crewId, to: n.to, count: n.count })
    this.notices.emit('message', n)
  }

  onPurge(e: PurgeEvent): void {
    this.notices.emit('purge', e)
    this.emit('purge', e)
  }

  // Caps are data-only decisions: log them and let `caps.isPaused` stop nudges and claims. Operant never
  // types into or kills a session over a cap, and no fixed line says "paused", so nothing is typed.
  private onCap(d: CapDecision): void {
    const label = d.scope === 'daily' ? 'The daily budget' : (this.store.operatorAddress(d.operatorId!) ?? 'An operator')
    const money = `$${d.spentUsd.toFixed(2)} of $${d.capUsd.toFixed(2)}`
    if (d.action === 'warn') this.log('budget', `${label} is at ${Math.floor(d.pct)}% (${money})`, d.operatorId)
    else this.log('budget', `Paused: ${label} reached its cap (${money}); no nudges, job claims refused until it is raised`, d.operatorId)
    this.notices.emit('cap', d)
    this.emit('caps', { action: d.action, scope: d.scope, operatorId: d.operatorId, spentUsd: d.spentUsd, capUsd: d.capUsd, pct: d.pct })
  }

  // "Raise cap" / "Resume": count spend from now on and let the warning and pause fire again.
  resetCap(target: number | 'daily'): void {
    if (target === 'daily') this.usage.caps.resetDaily()
    else this.usage.caps.resetOperator(target)
    this.usage.checkCaps()
    this.runs.pumpAll()
  }

  // Settings

  private jobSettings(): JobSettings {
    const c = this.settings.collab
    return {
      leaseMinutes: c.leaseMinutes,
      maxRejects: c.maxRejects,
      longJobEstimateMinutes: c.longJobEstimateMinutes,
      longJobElapsedMinutes: c.longJobElapsedMinutes,
    }
  }

  private usageConfig() {
    const { dailyBudgetUsd, tokens } = this.settings
    return {
      dailyBudgetUsd,
      operatorDailyCapUsd: tokens.operatorDailyCapUsd,
      capWarnPct: tokens.capWarnPct,
      coldThresholdPct: tokens.coldThresholdPct,
    }
  }

  private applySettings(): void {
    const { file, args } = this.settings.shell
    this.sessions.setShell(file ? { file, args: args.split(/\s+/).filter(Boolean) } : null)
    const { nudgeIdleSeconds, nudgeBatchSeconds } = this.settings.collab
    this.nudge.setConfig({ nudgeIdleSeconds, nudgeBatchSeconds })
    this.usage.setConfig(this.usageConfig())
    setSharedBanks(this.settings.hindsight.mode !== 'local')
  }

  // Operators

  private logDiscord(message: string): void {
    this.log('discord', message)
    consoleLog.add('discord', 'info', message, { error: /could not|unavailable/i.test(message) })
  }

  private log(kind: string, message: string, operatorId: number | null = null, crewId: number | null = null): void {
    const rid = crewId ?? (operatorId == null ? null : this.store.crewIdOfOperator(operatorId, true))
    this.emit('event', this.store.addEvent(kind, message, rid, operatorId))
  }

  private setStatus(operatorId: number, status: OperatorStatus): void {
    this.store.setOperatorStatus(operatorId, status)
    this.emit('operator:status', { operatorId, status })
  }

  private doingJob(operatorId: number): number | null {
    const r = this.store.db.prepare("SELECT id FROM jobs WHERE assignee_id = ? AND state = 'doing' ORDER BY id LIMIT 1").get(operatorId) as
      | { id: number }
      | undefined
    return r ? Number(r.id) : null
  }

  private onExit(operatorId: number, exitCode: number): void {
    this.learnFromConversation(operatorId)
    this.live.delete(operatorId)
    this.usage.detach(operatorId)
    this.cli?.revokeToken(operatorId)
    this.messages.cancelWaits(operatorId)
    this.nudge.forget(operatorId)
    if (!this.restarting.has(operatorId)) {
      try {
        this.jobs.releaseOperatorJobs(operatorId, { onExit: true })
      } catch (err) {
        this.log('error', `Could not release jobs of operator ${operatorId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.exitWaiters.get(operatorId)?.()
    if (!this.store.getOperator(operatorId)) return
    this.setStatus(operatorId, exitCode === 0 ? 'stopped' : 'error')
    this.log('operator', `${this.store.operatorAddress(operatorId)} stopped${exitCode ? ` (exit ${exitCode})` : ''}`, operatorId)
  }

  // A project Master's conversation ended: the learn step reads its transcript. Never throws into the exit.
  private learnFromConversation(operatorId: number): void {
    try {
      const op = this.store.getOperator(operatorId)
      const crewId = this.store.crewIdOfOperator(operatorId)
      if (op?.kind === 'master' && crewId != null && op.sessionId && !this.restarting.has(operatorId)) void this.learn.onConversationEnd(crewId, op.sessionId)
    } catch {
      // learning is a bonus
    }
  }

  private launchContext(crewId: number, crewFolder: string, sessionId: string, preset: Preset | null): LaunchContext {
    const platform = this.launch.platform ?? process.platform
    const readRole = this.launch.readRole ?? ((file: string) => this.readShippedRole(file))
    const roleFile = preset?.builtin ? ROLE_FILE_BY_PRESET[preset.builtin] : undefined
    const cliDir = this.launch.cliDir
    const probe = this.launch.codegraphOnPath ?? (() => onPath('codegraph', this.launch.baseEnv ?? process.env, platform))
    return {
      platform,
      shell: shellKind(this.settings.shell.file, platform),
      crewId,
      crewFolder,
      pluginDir: this.pluginDir,
      launchDir: this.launch.launchDir ?? join(tmpdir(), 'operant2', 'launch'),
      rolesDir: this.launch.rolesDir ?? join(tmpdir(), 'operant2', 'roles'),
      commonRoleText: readRole('_common.md'),
      presetRoleText: roleFile ? readRole(roleFile) : '',
      codegraphIndexed: probe() && this.indexes.status(crewFolder).initialized,
      sessionId,
      supported: this.launch.supported,
      operantCli: cliDir ? join(cliDir, platform === 'win32' ? 'operant.cmd' : 'operant') : undefined,
      operantNode: this.launch.operantNode,
      defaultCacheTtl: this.settings.tokens.defaultCacheTtl,
      subagentCacheTtl: this.settings.tokens.subagentCacheTtl,
      pinClaudeVersion: this.settings.tokens.pinClaudeVersion,
    }
  }

  private readShippedRole(file: string): string {
    try {
      return readFileSync(join(this.launch.shippedRolesDir ?? join(this.pluginDir, 'roles'), file), 'utf8')
    } catch {
      return ''
    }
  }

  private writeFiles(launch: LaunchResult): void {
    writeLaunchFiles(
      launch.files,
      this.launch.writer ?? { mkdir: (dir) => void mkdirSync(dir, { recursive: true }), writeFile: (path, content) => writeFileSync(path, content) },
    )
  }

  // Fills the socket and token placeholders (issuing the operator's token) and puts the CLI folder on its
  // PATH. Without a CLI server or a socket the operator runs without the CLI.
  private sessionEnv(launchEnv: Record<string, string>, operatorId: number): Record<string, string> {
    const wantsCli = Object.values(launchEnv).some((v) => v === SOCKET_PLACEHOLDER || v === TOKEN_PLACEHOLDER)
    const token = wantsCli && this.cli?.address ? this.cli.issueToken(operatorId) : null
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(launchEnv)) {
      if (v === SOCKET_PLACEHOLDER) {
        if (token) env[k] = this.cli!.address
      } else if (v === TOKEN_PLACEHOLDER) {
        if (token) env[k] = token
      } else env[k] = v
    }
    const cliDir = this.launch.cliDir
    if (token && cliDir) {
      const base = this.launch.baseEnv ?? process.env
      const platform = this.launch.platform ?? process.platform
      const key = Object.keys(base).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
      env[key] = [cliDir, base[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':')
    }
    return env
  }

  // Only a pointer to a role file this launch wrote may be typed after a launch command.
  private checkedFirstInput(launch: LaunchResult): string | null {
    if (!launch.firstInput) return null
    const ok = launch.files.some((f) => launch.firstInput === `Read ${f.path} and follow it as your role.`)
    if (!ok) throw new Error('refusing to type a first line that does not point at a role file Operant wrote')
    return launch.firstInput
  }

  startOperator(operatorId: number): void {
    this.launchOperator(operatorId)
  }

  // Starts the session; returns the failure message when the launch failed (already logged), else null.
  private launchOperator(operatorId: number): string | null {
    const operator = this.store.getOperator(operatorId)
    const crewId = this.store.crewIdOfOperator(operatorId)
    const crew = crewId == null ? null : this.store.getCrew(crewId)
    if (!operator || !crew || this.sessions.isRunning(operatorId)) return null
    const address = this.store.operatorAddress(operatorId)!
    const sessionId = randomUUID()
    try {
      const preset = operator.presetId != null ? this.store.getPreset(operator.presetId) : null
      const ctx = this.launchContext(crew.id, crew.folder, sessionId, preset)
      const launch = operator.kind === 'master' ? buildMasterLaunch(ctx, operator) : buildAgentLaunch(operator, preset, ctx)
      if (launch) this.writeFiles(launch)
      const firstInput = launch ? this.checkedFirstInput(launch) : null
      const env = launch ? this.sessionEnv(launch.env, operatorId) : {}
      this.sessions.start({
        operator,
        address,
        cwd: launch?.cwd ?? crew.folder,
        env,
        command: launch ? commandLine(launch, shellOf(ctx)) : null,
        firstInput,
      })
      this.live.add(operatorId)
      if (launch && launch.file === 'claude') {
        this.store.setOperatorSession(operatorId, sessionId)
        this.usage.attach(operatorId, this.transcriptFile(crew.folder, sessionId), sessionId)
      }
      this.setStatus(operatorId, 'running')
      this.log('operator', `${address} started`, operatorId, crew.id)
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.cli?.revokeToken(operatorId)
      this.setStatus(operatorId, 'error')
      this.log('error', `${address} failed to start: ${message}`, operatorId, crew.id)
      return message
    }
  }

  // The Master Terminal slot of a crew, created or recreated when missing.
  startMaster(crewId: number): Operator {
    const master = this.store.ensureMaster(crewId)
    this.startOperator(master.id)
    return master
  }

  // Stops a running session and waits for its exit. A pty that has not exited after EXIT_WAIT_MS is
  // killed harder and dropped, so the session is gone when this returns.
  private async stopAndWait(operatorId: number): Promise<void> {
    if (!this.sessions.isRunning(operatorId)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      await new Promise<void>((resolve) => {
        this.exitWaiters.set(operatorId, resolve)
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, EXIT_WAIT_MS)
        timer.unref?.()
        this.sessions.stop(operatorId)
      })
    } finally {
      clearTimeout(timer)
      this.exitWaiters.delete(operatorId)
    }
    if (timedOut) {
      this.log('error', `${this.store.operatorAddress(operatorId) ?? `Operator ${operatorId}`} did not exit in time and was killed`, operatorId)
      this.sessions.forceStop(operatorId)
    }
  }

  // Stop, then start fresh (ruling R1): a new session id, the same job records. Its jobs are kept (held)
  // across the restart. A start that fails is thrown, so the dialog shows it.
  async restartOperator(operatorId: number): Promise<void> {
    if (!this.sessions.isRunning(operatorId)) {
      this.startOperator(operatorId)
      return
    }
    this.restarting.add(operatorId)
    try {
      await this.stopAndWait(operatorId)
    } finally {
      this.restarting.delete(operatorId)
    }
    if (!this.store.getOperator(operatorId)) throw notFound(`Operator ${operatorId} not found`)
    const failure = this.launchOperator(operatorId)
    if (failure) throw conflict(`The operator stopped but could not start again: ${failure}`)
  }

  // Checks a patch from the dashboard: only known fields, launch fields with the launch rules.
  private checkPatch(operator: Operator, patch: OperatorPatch): OperatorPatch {
    if (!patch || typeof patch !== 'object') throw bad('The change is missing')
    for (const k of Object.keys(patch)) if (!OPERATOR_KEYS.has(k)) throw bad(`Unknown field "${k}"`)
    const next: OperatorPatch = { ...patch }
    if (patch.role !== undefined) next.role = cleanRole(patch.role)
    if (patch.dailyCapUsd !== undefined) next.dailyCapUsd = cleanCap(patch.dailyCapUsd)
    if (patch.roleText !== undefined) next.roleText = cleanRoleText(patch.roleText)
    if (patch.model !== undefined) next.model = patch.model.trim()
    validateLaunchSettings({ ...launchFields(next as Record<string, unknown>), agent: patch.agent ?? operator.agent })
    if (patch.squadId !== undefined && this.store.getSquad(patch.squadId)?.crewId !== this.store.crewIdOfOperator(operator.id)) {
      throw bad('An operator can only move to a squad in its own project')
    }
    return next
  }

  // What a change would do to a running operator, without saving anything.
  previewChange(operatorId: number, patch: OperatorPatch): ChangePlan {
    const operator = this.requireOperator(operatorId)
    return this.planFor(operator, this.checkPatch(operator, patch))
  }

  private planFor(operator: Operator, patch: OperatorPatch): ChangePlan {
    return planChange(operator, patch, {
      running: this.sessions.isRunning(operator.id),
      contextTokens: this.contexts.get(operator.id)?.contextTokens ?? 0,
    })
  }

  // Saves the change and relaunches only when the plan says a running session must restart.
  async applyChange(operatorId: number, patch: OperatorPatch): Promise<OperatorChange> {
    const operator = this.store.getOperator(operatorId)
    if (!operator) throw notFound(`Operator ${operatorId} not found`)
    const checked = this.checkPatch(operator, patch)
    const plan = this.planFor(operator, checked)
    const { role, squadId, ...launch } = checked
    if (role !== undefined || squadId !== undefined) this.store.updateOperator(operatorId, { role, squadId })
    this.store.setOperatorLaunch(operatorId, launch)
    if (checked.dailyCapUsd !== undefined) this.usage.checkCaps(operatorId)
    this.log('operator', `${this.store.operatorAddress(operatorId)} changed: ${[...plan.restartFields, ...plan.liveFields].join(', ') || 'no fields'}`, operatorId)
    this.configChanged(operatorId)
    if (plan.requiresRestart) await this.restartOperator(operatorId)
    return { operator: this.store.getOperator(operatorId)!, plan }
  }

  // Soft delete: stop the session, release its jobs, move the reviews it held to the PM or the user, revoke
  // its token, drop the messages it never read and its links, then set deleted_at. History stays until a purge.
  async deleteOperator(operatorId: number): Promise<void> {
    const operator = this.requireOperator(operatorId)
    if (operator.kind === 'master') throw bad('The Master Terminal can be stopped but not deleted')
    const address = this.store.operatorAddress(operatorId)!
    const crewId = this.store.crewIdOfOperator(operatorId)
    await this.stopAndWait(operatorId)
    this.jobs.releaseOperatorJobs(operatorId, { onExit: false })
    this.messages.closeAsksFrom(operatorId)
    this.store.db.prepare('DELETE FROM messages WHERE to_id = ? AND read_at IS NULL').run(operatorId)
    // Also clears the project's PM when it was this operator, and its links.
    this.store.deleteOperator(operatorId)
    this.dropOperatorState(operatorId)
    this.log('operator', `Operator ${address} deleted`, null, crewId)
    this.emit('operator:config', { operatorId, crewId, removed: true })
  }

  // Stops the session and forgets everything Operant tracks for the operator id (token, cap state, usage
  // feed, nudges, context), because SQLite may hand the id to the next operator created.
  private dropOperatorState(operatorId: number): void {
    this.sessions.stop(operatorId)
    this.cli?.revokeToken(operatorId)
    this.messages.cancelWaits(operatorId)
    this.usage.forget(operatorId)
    this.contexts.delete(operatorId)
    this.finished.delete(operatorId)
    this.nudge.forget(operatorId)
    this.live.delete(operatorId)
    this.restarting.delete(operatorId)
  }

  private configChanged(operatorId: number): void {
    this.emit('operator:config', { operatorId, crewId: this.store.crewIdOfOperator(operatorId, true), removed: false })
  }

  // Scratch terminals: no token, no role file, no plugin; keyed `scratch:<id>`.

  private scratchKey(id: number): SessionKey {
    return `scratch:${id}`
  }

  scratchStatus(scratchId: number): ScratchStatus {
    return { scratchId, running: this.sessions.isRunning(this.scratchKey(scratchId)), sessionId: this.store.getScratch(scratchId)?.sessionId ?? null }
  }

  // Never restarts a running session. A launch failure is logged and thrown as an OperantError.
  startScratch(scratchId: number, opts: { resume?: boolean } = {}): ScratchStatus {
    const scratch = this.store.getScratch(scratchId)
    const key = this.scratchKey(scratchId)
    if (!scratch) throw notFound(`Scratch terminal ${scratchId} not found`)
    if (this.sessions.isRunning(key)) return this.scratchStatus(scratchId)
    const crew = this.store.getCrew(scratch.crewId)
    try {
      const resume = !!opts.resume && scratch.sessionId != null
      const sessionId = resume ? scratch.sessionId! : randomUUID()
      if (!resume) this.store.updateScratch(scratchId, { sessionId })
      const row: ScratchTerminal = { ...scratch, sessionId }
      const preset = scratch.presetId != null ? this.store.getPreset(scratch.presetId) : null
      const ctx = this.launchContext(scratch.crewId, crew?.folder ?? scratch.cwd, sessionId, preset)
      const launch = buildScratchLaunch(row, ctx, { settings: preset ?? undefined, resume })
      this.writeFiles(launch)
      this.sessions.start({ key, cwd: launch.cwd, env: launch.env, command: commandLine(launch, shellOf(ctx)) })
      if (launch.file === 'claude') this.attachScratch(scratchId, this.transcriptFile(launch.cwd, sessionId), sessionId)
      this.log('operator', `Scratch terminal ${scratch.title} started`, null, scratch.crewId)
      return this.scratchStatus(scratchId)
    } catch (err) {
      const failure = toOperantError(err)
      this.log('error', `Scratch terminal ${scratch.title} failed to start: ${failure.message}`, null, scratch.crewId)
      throw failure
    }
  }

  stopScratch(scratchId: number): void {
    this.sessions.stop(this.scratchKey(scratchId))
  }

  private scratchId(key: SessionKey): number | null {
    const m = typeof key === 'string' ? /^scratch:(\d+)$/.exec(key) : null
    return m ? Number(m[1]) : null
  }

  private onScratchExit(scratchId: number, exitCode: number): void {
    this.detachScratch(scratchId)
    this.emit('scratch:exit', { scratchId, exitCode })
    const scratch = this.store.getScratch(scratchId)
    if (scratch) this.log('operator', `Scratch terminal ${scratch.title} closed${exitCode ? ` (exit ${exitCode})` : ''}`, null, scratch.crewId)
  }

  // Scratch spend: one usage row per assistant message with scratch_id set, never attributed to a job.
  private attachScratch(scratchId: number, file: string, sessionId: string): void {
    this.scratchFeeds.set(scratchId, { tail: new JsonlTail(file), sessionId, prevContext: null, current: null, currentContext: 0 })
  }

  // Reads what is left of a closed or deleted tile's transcript, then stops following it.
  private detachScratch(scratchId: number): void {
    if (this.pollScratch(scratchId) > 0) this.usage.checkCaps()
    this.scratchFeeds.delete(scratchId)
  }

  // Returns how many usage lines were ingested.
  private pollScratch(scratchId: number): number {
    const feed = this.scratchFeeds.get(scratchId)
    if (!feed || !this.store.getScratch(scratchId)) return 0
    let n = 0
    for (const line of feed.tail.read()) {
      const u = parseLine(line)
      if (!u) continue
      if (feed.current?.messageId !== u.messageId) {
        feed.prevContext = feed.current ? feed.currentContext : null
        feed.current = { messageId: u.messageId, toolUse: false }
      }
      feed.current.toolUse ||= u.toolUse
      feed.currentContext = u.contextTokens
      this.store.upsertMessageUsage(u.messageId, {
        scratchId,
        sessionId: feed.sessionId,
        model: u.model,
        at: u.at,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheRead: u.cacheReadTokens,
        cacheW5m: u.cacheWrite5mTokens,
        cacheW1h: u.cacheWrite1hTokens,
        costUsd: u.costUsd,
        contextTokens: u.contextTokens,
        cold: isColdTurn(
          { contextTokens: u.contextTokens, cacheWriteTokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens },
          feed.prevContext,
          this.settings.tokens.coldThresholdPct,
        ),
        toolUse: feed.current.toolUse,
      })
      n++
    }
    return n
  }

  private async runIndex(crewId: number): Promise<IndexStatus | null> {
    const crew = this.store.getCrew(crewId)
    if (!crew) return null
    this.emit('index:status', { crewId, status: { ...this.indexes.status(crew.folder), indexing: true } })
    this.log('index', `Indexing ${crew.name} with CodeGraph`, null, crewId)
    const status = await this.indexes.index(crew.folder).catch(
      (err: unknown): IndexStatus => ({
        ...this.indexes.status(crew.folder),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    this.emit('index:status', { crewId, status })
    this.log(
      status.error ? 'error' : 'index',
      status.error ? `Indexing ${crew.name} failed: ${status.error}` : `${crew.name} indexed: ${status.files} files, ${status.symbols} symbols`,
      null,
      crewId,
    )
    return status
  }

  // Operators can't outlive the app in v1, so anything left "running" from a crash is reset.
  resetStaleOperators(): void {
    for (const crew of this.store.listCrews())
      for (const squad of this.store.topology(crew.id)?.squads ?? [])
        for (const s of squad.operators) if (s.status !== 'stopped' && !this.sessions.isRunning(s.id)) this.store.setOperatorStatus(s.id, 'stopped')
    for (const crew of this.store.listCrews()) {
      const master = this.store.getMaster(crew.id)
      if (master && master.status !== 'stopped' && !this.sessions.isRunning(master.id)) this.store.setOperatorStatus(master.id, 'stopped')
    }
  }
}
