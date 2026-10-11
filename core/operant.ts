import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreChannel, IpcApi, IpcEvents } from '../shared/ipc'
import { mergeSettings, sanitizeSettings, type Settings, type SettingsPatch } from '../shared/settings'
import type {
  BudgetConfig,
  BudgetStatus,
  Crew,
  CrewPatch,
  ExportText,
  ImportSource,
  IpcErrorCode,
  LaunchSettings,
  Preset,
  ScratchTerminal,
  ScratchStatus,
  TeamImportPreview,
  UsageQuery,
  UsageView,
  ExportFormat,
  ScratchInput,
  ScratchPatch,
  Team,
  TeamInput,
  TeamPatch,
} from '../shared/types'
import type { IndexStatus, CrewIndexes } from './codegraph'
import { ProjectGroups } from './groups'
import { BUDGETS_KEY, BudgetMonitor, mergeBudgets, sanitizeBudgets, WINDOW_LABEL, type BudgetDecision } from './usage-budgets'
import { HindsightService, bankFor, setSharedBanks } from './hindsight'
import { generateApiKey, listAdapters } from './hindsight-net'
import { LearnError, LearnService, claudeLearnModel, realGit, type LearnModel } from './learn'
import { AuxBudget, resolveAux } from './aux-budget'
import type { KeepWarmPersisted } from './keepwarm'
import { LearnChangesDb } from './learn-changes'
import { Ops } from './ops'
import { claudeDir as claudeDirOf } from './paths'
import { ENHANCE_MAX_MEMORY_TOKENS, ENHANCE_MAX_SYMBOL_LINES, buildEnhancePrompt, mergeSkills, parseEnhanceReply, type EnhanceContext } from '../shared/prompt-enhance'
import { gatherEnhanceContext } from './enhance-context'
import { recallMemory } from './memory-recall'
import { installedSkills } from './installed-skills'
import { SETTINGS_SECTIONS, resetSettings } from '../shared/settings'
import type { AuxTask } from '../shared/aux-settings'
import type { LearnSettings } from '../shared/learn'
import { LessonsDb } from './lessons-store'
import { checkOpencodeIds, learnModelList, notListedError, resolveLearnAi } from './learn-ai'
import { LaunchError, buildChatLaunch, buildScratchLaunch, commandLine, shellOf, validateLaunchSettings, writeLaunchFiles, SOCKET_PLACEHOLDER, TOKEN_PLACEHOLDER, type LaunchContext, type LaunchResult, type ShellKind } from './launch'
import { McpError, McpService } from './mcp'
import { listModels } from './models'
import { ProviderMonitor } from './providers'
import { exportTeams, parseTeamFile } from './team-presets'
import { applyRead, exportBundle, previewRead, readSource, type ImportDeps } from './import'
import { gitChanges, gitInfo, listIdes, openInIde } from './projecttools'
import * as repoGit from './git'
import { killAllOwn, resolveCli, runHidden } from './proc'
import { scrubLogLine } from './agents'
import { ChatHub, ChatSession, type ChatLaunchSpec, type ChatSpawn } from './claude-chat'
import { listChatFiles } from './chat-files'
import { emptyChatState, stripAnsi, type ChatState } from '../shared/claude-chat'
import { PLAYGROUND_KEPT, type Store } from './store'
import { JsonlTail, parseLine, transcriptPath } from './transcripts'
import { CapabilityProber, systemProbeDeps, type ProbeDeps } from './capabilities'
import { ClaudeAgents } from './claude-agents'
import { claudeModsConfig, type ModsPaths } from './claude-events'
import { openCodeDbPath } from './opencode-usage'
import { enabledMods, type CapabilityReport, type ClaudeTileState } from '../shared/claude-mods'
import { inheritedEnv, type SessionKey, type SessionManager } from './sessions'
import { cleanFilter, queryUsage, querySeries } from './usage-query'
import { exportView } from './usage-export'
import { isColdTurn } from './usage'
import { MemorySecretStore, type SecretStore } from './secrets'
import { randomUUID } from 'node:crypto'
import { EXIT, type CliRequest, type CliResult, type Identity } from './cli-server'

type Handlers = { [C in CoreChannel]: (...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<Awaited<ReturnType<IpcApi[C]>>> }

type PushEvents = { [E in keyof IpcEvents]: [IpcEvents[E]] }

type Group<P extends string> = Pick<Handlers, Extract<CoreChannel, `${P}:${string}`>>

// What Operant needs from the CLI server (CliServer satisfies it).
export interface CliAccess {
  readonly address: string
  listen(): Promise<string>
  issueToken(id: number): string
  revokeToken(id: number): void
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
  // <userData>/launch (settings files) and <userData>/roles (preset guidance files).
  launchDir?: string
  rolesDir?: string
  writer?: LaunchWriter
  // Folder holding the `operant` wrapper; put on a tile's PATH when it has a CLI token.
  cliDir?: string
  // The binary the wrapper runs the CLI with (OPERANT_NODE).
  operantNode?: string
  // The CodeGraph MCP server is offered only when the `codegraph` CLI is on PATH.
  codegraphOnPath?: () => boolean
  baseEnv?: NodeJS.ProcessEnv
  supported?: ReadonlySet<string>
}

export interface LaunchWriter {
  mkdir(dir: string): void
  writeFile(path: string, content: string): void
}

export interface OperantOptions {
  store: Store
  sessions: SessionManager
  indexes: CrewIndexes
  pluginDir: string
  // Where backups are written (the app passes <userData>/backups); the default is a folder under the temp dir.
  backupDir?: string
  // Where the Claude Code hooks write and which script they run; absent turns Claude mods off.
  claudeMods?: ModsPaths
  // plugin/mods in the repo (dev) or in resources (packaged): one folder per native mod.
  modPluginsDir?: string
  // The CLI probe (tests pass a fake); the real one runs `claude --version` and `opencode --version`.
  capabilityProbe?: ProbeDeps
  now?: () => number
  transcriptFile?: (cwd: string, sessionId: string) => string
  launch?: LaunchOptions
  // Each is built from the store when not given.
  cliServer?: (target: CliTarget) => CliAccess
  scheduler?: Scheduler
  // API keys (the OS keychain in the app).
  secrets?: SecretStore
  // The learning loop; the real one when not given.
  learn?: LearnService
  // The cheap model the learn step asks; Claude Haiku when not given.
  learnModel?: LearnModel
  mcp?: McpService
  // Plan limits and provider usage; real pollers when not given.
  providers?: ProviderMonitor
  // File pickers (the app supplies Electron's); without them `usage:export` and `data:exportFile` refuse.
  fileDialogs?: FileDialogs
  // Where Operant 2.8.2 kept its data and the clock/files import reads with (tests).
  importDeps?: ImportDeps
  // How a Chat view tile starts Claude Code (tests pass a fake child).
  chatSpawn?: ChatSpawn
  // The embedded browser's MCP URL, or null while it is not running. Used when Settings > Browser > AI control is on.
  browserMcp?: () => string | null
  // Called after a project is deleted (main clears that project's browser partition).
  onCrewDeleted?: (crewId: number) => void
}

export interface FileDialogs {
  save(suggestedName: string, filter: { name: string; extensions: string[] }): Promise<string | null>
  open(filter: { name: string; extensions: string[] }): Promise<string | null>
}

// What the CLI server asks of Operant: who a token belongs to (a tile's project) and the memory commands.
export interface CliTarget {
  identify(tileId: number): Identity | null
  run(who: Identity, req: CliRequest): Promise<CliResult>
}

const HOUR = 60 * 60 * 1000
// Transcripts are polled rather than watched: fs.watch is unreliable across platforms for appends.
const USAGE_POLL_MS = 2_000
const PROVIDER_TICK_MS = 30_000
// How long a tile that has the finished flag must sit still before the idle learn runs.
const FINISHED_QUIET_MS = 5_000

// A running Claude tile's transcript, followed so its spend counts.
interface ScratchFeed {
  tail: JsonlTail
  sessionId: string
  prevContext: number | null
  current: { messageId: string; toolUse: boolean } | null
  currentContext: number
  // When the transcript last grew; null once learned from (until it grows again).
  activityAt: number | null
  // The tile's turn went from working to idle (the finished flag) and has not started again.
  finished: boolean
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
  if (err instanceof LaunchError) return { code: 'BAD_ARGS', message: err.message }
  if (err instanceof LearnError) return { code: err.code, message: err.message }
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

const NAME_MAX = 80
const TILE_LAYOUT_MAX = 100_000
const AGENTS = new Set<string>(['claude', 'codex', 'shell', 'opencode'])

function cleanName(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${what} cannot be empty`)
  const t = v.trim()
  if (t.length > NAME_MAX) throw bad(`${what} is longer than ${NAME_MAX} characters`)
  return t
}

// Everything the dashboard can ask for or be told about, independent of Electron.
export class Operant extends EventEmitter<PushEvents> {
  readonly handlers: Handlers
  readonly budgets: BudgetMonitor
  readonly learn: LearnService
  // Every learn and memory model call is counted and limited here.
  readonly aux: AuxBudget
  private readonly changes: LearnChangesDb
  private readonly ops: Ops
  readonly mcp: McpService
  readonly providers: ProviderMonitor
  private readonly secrets: SecretStore
  private readonly hindsight: HindsightService
  private readonly store: Store
  private readonly sessions: SessionManager
  private readonly indexes: CrewIndexes
  private readonly groups: ProjectGroups
  private readonly pluginDir: string
  private readonly now: () => number
  private readonly transcriptFile: (cwd: string, sessionId: string) => string
  private readonly launch: LaunchOptions
  private readonly claudeModsPaths: ModsPaths | null
  private readonly claudeAgents: ClaudeAgents | null
  private readonly modPluginsDir: string | null
  private readonly prober: CapabilityProber
  private readonly cli: CliAccess | null
  private readonly scheduler: Scheduler
  private readonly timers: unknown[] = []
  // The longest a quit waits on any one step (the CLI socket, killing processes).
  shutdownStepMs = 3000
  // Scratch terminals: transcript followers and the sessions Operant opened.
  private readonly scratchFeeds = new Map<number, ScratchFeed>()
  // The last turn phase each tile reported, from the Chat view's ops and from the Terminal view's hooks.
  private readonly chatPhase = new Map<number, string>()
  private readonly modsPhase = new Map<number, string>()
  // Chat view tiles: one Claude Code stream-json process each (claude-chat.ts).
  readonly chat: ChatHub
  private readonly chatSpawn: ChatSpawn | undefined
  private readonly browserMcp: (() => string | null) | undefined
  private readonly onCrewDeleted: ((crewId: number) => void) | undefined
  // Tiles switching between the Chat and Terminal views (their end is not a closed session: no learning) and tiles the
  // owner closed (a chat process that ends then is the end of the session).
  private readonly switching = new Set<number>()
  private readonly closing = new Set<number>()
  private settings: Settings
  private budgetConfig: BudgetConfig
  private readonly fileDialogs: FileDialogs | undefined
  private readonly importDeps: ImportDeps
  private pendingTeamImport: string | null = null

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
    this.claudeModsPaths = opts.claudeMods ?? null
    this.modPluginsDir = opts.modPluginsDir ?? null
    this.claudeAgents = opts.claudeMods
      ? new ClaudeAgents({
          eventsDir: opts.claudeMods.eventsDir,
          now: this.now,
          emit: (state) => {
            this.noteTurn(this.modsPhase, state.tileId, state.session.phase)
            this.emit('claudeMods:state', state)
          },
        })
      : null
    this.prober = new CapabilityProber(opts.capabilityProbe ?? systemProbeDeps(openCodeDbPath()))
    this.scheduler = opts.scheduler ?? realScheduler
    this.settings = sanitizeSettings(store.getJson('settings'))
    this.budgetConfig = sanitizeBudgets(store.getJson(BUDGETS_KEY))
    this.fileDialogs = opts.fileDialogs
    this.importDeps = opts.importDeps ?? {}
    this.chatSpawn = opts.chatSpawn
    this.browserMcp = opts.browserMcp
    this.onCrewDeleted = opts.onCrewDeleted
    this.chat = new ChatHub({
      push: (scratchId, ops) => {
        for (const op of ops) if (op.op === 'meta' && op.patch.turn) this.noteTurn(this.chatPhase, scratchId, op.patch.turn.phase)
        this.emit('chat:ops', { scratchId, ops })
      },
    })

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
      globalCaps: () => ({ fiveHour: this.settings.fiveHourBudgetUsd, day: this.settings.dailyBudgetUsd, week: this.settings.weeklyBudgetUsd }),
      warnPct: () => this.settings.tokens.capWarnPct,
      crewIds: () => store.listCrews().map((c) => c.id),
      projectSpend: (crewId, since) => store.spendSince(since, crewId),
      globalSpend: (since) => store.spendSince(since),
    })
    this.secrets = opts.secrets ?? new MemorySecretStore()
    // Shared mode sends and requires the shared key; remote sends the remote key; local sends none.
    this.hindsight = new HindsightService({
      url: () => (this.settings.hindsight.mode === 'remote' ? this.settings.hindsight.url : ''),
      lan: () => {
        const h = this.settings.hindsight
        return h.mode === 'lan' ? { host: h.bindHost, port: h.port, openBind: h.openBind } : null
      },
      key: () => (this.settings.hindsight.mode === 'local' ? null : this.secrets.get(HINDSIGHT_KEY[this.settings.hindsight.mode === 'lan' ? 'shared' : 'remote'])),
      llmEnv: () => ({ HINDSIGHT_API_LLM_PROVIDER: 'claude-code' }),
    })
    this.aux = new AuxBudget({
      now: this.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      // The learn budget's daily USD cap applies too: the lower of the two caps that are set.
      settings: () => {
        const a = this.settings.aux
        const learnCap = this.settings.learn.dailyUsdBudget
        const maxUsdPerDay = learnCap > 0 && a.maxUsdPerDay > 0 ? Math.min(learnCap, a.maxUsdPerDay) : learnCap > 0 ? learnCap : a.maxUsdPerDay
        return { ...a, maxUsdPerDay }
      },
      store: { load: () => store.getJson('aux.usage'), save: (v) => store.setJson('aux.usage', v) },
    })
    this.enhanceModel = opts.learnModel ?? claudeLearnModel(opts.launch?.supported, { settings: () => this.auxLearn('promptEnhance'), local: this.localLlm() })
    this.changes = new LearnChangesDb(store.db, this.now)
    this.learn =
      opts.learn ??
      new LearnService({
        store,
        db: new LessonsDb(store.db, this.now),
        hindsight: this.hindsight,
        git: realGit,
        model: this.budgetedModel(opts.learnModel ?? claudeLearnModel(opts.launch?.supported, { settings: () => this.auxLearn('extraction'), local: this.localLlm() }), () => this.learnAiProblem('extraction')),
        settings: () => this.settings.learn,
        log: (message, crewId) => this.log('learn', message, crewId || null),
        changes: this.changes,
      })
    this.ops = new Ops({
      store,
      learn: this.learn,
      hindsight: this.hindsight,
      aux: this.aux,
      indexes: this.indexes,
      settings: () => this.settings,
      saveSettings: (next) => this.saveSettings(next),
      backupDir: opts.backupDir ?? join(tmpdir(), 'operant2', 'backups'),
      claudeDir: claudeDirOf(),
      now: this.now,
      log: (kind, message) => this.log(kind, message),
    })
    this.mcp =
      opts.mcp ??
      new McpService({
        log: (message) => this.log('mcp', message),
        written: {
          get: () => {
            const v = this.store.getJson('mcp.written')
            return Array.isArray(v) ? v.map(String) : []
          },
          set: (keys) => this.store.setJson('mcp.written', keys),
        },
        builtin: async (name) => {
          if (name === 'codegraph') {
            const ok = onPath('codegraph', this.launch.baseEnv ?? process.env, process.platform)
            return { ok, error: ok ? undefined : 'the codegraph CLI is not on PATH' }
          }
          const h = await this.hindsightStatus()
          return { ok: h.state === 'running', error: h.detail }
        },
      })
    this.cli = opts.cliServer?.({ identify: (id) => this.identify(id), run: (who, req) => this.runCli(who, req) }) ?? null
    this.applySettings()

    sessions.on('data', (key, data) => {
      const id = this.scratchId(key)
      if (id != null) this.emit('scratch:data', { scratchId: id, data })
    })
    sessions.on('exit', (key, exitCode) => {
      const id = this.scratchId(key)
      if (id != null) this.onScratchExit(id, exitCode)
    })

    const all: Handlers = {
      ...this.crewHandlers(),
      ...this.groupHandlers(),
      ...this.presetHandlers(),
      ...this.teamHandlers(),
      ...this.modelHandlers(),
      ...this.tileHandlers(),
      ...this.scratchHandlers(),
      ...this.chatHandlers(),
      ...this.usageHandlers(),
      ...this.moveHandlers(),
      ...this.miscHandlers(),
      ...this.mcpHandlers(),
      ...this.capabilityHandlers(),
      ...this.opsHandlers(),
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

  private requireCrew(crewId: number): Crew {
    const crew = typeof crewId === 'number' ? this.store.getCrew(crewId) : null
    if (!crew) throw notFound(`Project ${String(crewId)} not found`)
    return crew
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

  private crewHandlers(): Group<'crews'> {
    const store = this.store
    return {
      'crews:list': () => store.listCrews(),
      'crews:create': ({ name, folder }) => {
        if (typeof folder !== 'string' || !folder.trim()) throw bad('The folder cannot be empty')
        const crew = store.createCrew(cleanName(name, 'The project name'), folder.trim())
        this.log('crew', `Project ${crew.name} created`, crew.id)
        return crew
      },
      'crews:update': (crewId, patch) => {
        const crew = this.requireCrew(crewId)
        const next: CrewPatch = {}
        if (patch.name !== undefined) next.name = cleanName(patch.name, 'The project name')
        if (patch.folder !== undefined) {
          if (typeof patch.folder !== 'string' || !patch.folder.trim()) throw bad('The folder cannot be empty')
          if (patch.folder.trim() !== crew.folder && this.crewRunning(crewId) > 0) {
            throw conflict('Stop the project’s tiles before changing its folder')
          }
          next.folder = patch.folder.trim()
        }
        const updated = store.updateCrew(crewId, next)
        this.log('crew', `Project ${updated.name} updated`, crewId)
        return updated
      },
      'crews:reorder': (crewIds) => {
        if (!Array.isArray(crewIds) || crewIds.some((id) => typeof id !== 'number')) throw bad('The order must be a list of project ids')
        return store.reorderCrews(crewIds)
      },
      'crews:delete': async (crewId) => {
        const crew = this.requireCrew(crewId)
        if (crew.kind === 'playground') throw conflict(PLAYGROUND_KEPT)
        const scratchIds = store.listScratch(crewId).map((s) => s.id)
        for (const id of scratchIds) {
          this.sessions.stop(this.scratchKey(id))
          this.detachScratch(id)
        }
        store.deleteCrew(crewId)
        this.log('crew', `Project ${crew.name} deleted`)
        try {
          this.onCrewDeleted?.(crewId)
        } catch (e) {
          this.log('crew', `Browser data cleanup failed: ${e instanceof Error ? e.message : String(e)}`)
        }
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

  private presetHandlers(): Group<'presets'> {
    const store = this.store
    const checkPreset = (p: Partial<LaunchSettings> & { name?: unknown; roleText?: unknown; mcpServers?: unknown }): void => {
      validateLaunchSettings(p)
      if (p.roleText !== undefined && p.roleText !== null && typeof p.roleText !== 'string') throw bad('Preset guidance must be text')
      if (typeof p.roleText === 'string' && p.roleText.length > 20_000) throw bad('Preset guidance is longer than 20000 characters')
      if (p.mcpServers !== undefined && (!Array.isArray(p.mcpServers) || p.mcpServers.length > 100 || p.mcpServers.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_. :-]{1,100}$/.test(n)))) {
        throw bad('MCP servers must be a list of server names')
      }
    }
    return {
      'presets:list': () => store.listPresets(),
      'presets:export': (presetId) => this.ops.presetExport(presetId),
      'presets:importPreview': (text) => this.ops.presetPreview(text),
      'presets:import': (text) => this.ops.presetImport(text),
      'presets:create': (input) => {
        checkPreset(input)
        if (!input.permissionMode) throw bad('A preset needs a permission mode')
        const preset = store.createPreset({ ...input, name: cleanName(input.name, 'The preset name') })
        this.log('preset', `Preset ${preset.name} created`)
        return preset
      },
      'presets:update': (presetId, patch) => {
        const before = this.requirePreset(presetId)
        checkPreset({ ...patch, agent: patch.agent ?? before.agent })
        const next = { ...patch } as typeof patch
        if (patch.name !== undefined) next.name = cleanName(patch.name, 'The preset name')
        const preset = store.updatePreset(presetId, next)
        this.log('preset', `Preset ${preset.name} updated`)
        return preset
      },
      'presets:duplicate': (presetId, name) => {
        const src = this.requirePreset(presetId)
        const copy = store.duplicatePreset(presetId, name === undefined ? undefined : cleanName(name, 'The preset name'))
        this.log('preset', `Preset ${src.name} duplicated as ${copy.name}`)
        return copy
      },
      'presets:delete': (presetId) => {
        const preset = this.requirePreset(presetId)
        store.deletePreset(presetId)
        this.log('preset', `Preset ${preset.name} deleted`)
      },
      'presets:reset': (presetId) => {
        const before = this.requirePreset(presetId)
        if (before.builtin == null) throw bad('Only built-in presets can be reset')
        const preset = store.resetPreset(presetId)
        this.log('preset', `Preset ${preset.name} reset to its shipped values`)
        return preset
      },
      'presets:restoreBuiltins': () => {
        const added = store.restoreBuiltins()
        if (added.length) this.log('preset', `Restored built-in presets: ${added.map((p) => p.name).join(', ')}`)
        return added
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
      if (v.length > 20_000) throw bad('Rules are longer than 20000 characters')
      return v
    }
    const description = (v: unknown): string => {
      if (typeof v !== 'string') throw bad('The description must be text')
      if (v.length > 500) throw bad('The description is longer than 500 characters')
      return v
    }
    return {
      'teams:list': () => store.listTeams(),
      'teams:create': (input: TeamInput) => {
        const team = store.createTeam({
          name: cleanName(input.name, 'The team name'),
          rules: input.rules === undefined ? '' : rules(input.rules),
          description: input.description === undefined ? '' : description(input.description),
        })
        this.log('team', `Team ${team.name} created`)
        return team
      },
      'teams:update': (teamId, patch: TeamPatch) => {
        requireTeam(teamId)
        const next: TeamPatch = {}
        if (patch.name !== undefined) next.name = cleanName(patch.name, 'The team name')
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
      'teams:importPreview': async (): Promise<TeamImportPreview | null> => {
        const path = await this.fileDialogs?.open({ name: 'Operant teams', extensions: ['json'] })
        if (!path) return null
        const items = parseTeamFile(store, readFileSync(path, 'utf8'))
        this.pendingTeamImport = path
        return { path, entries: items.map((i) => i.entry) }
      },
      'teams:import': (path) => {
        if (path !== this.pendingTeamImport) throw bad('Choose the file again before importing')
        const added: Team[] = parseTeamFile(store, readFileSync(path, 'utf8')).flatMap((i) => (i.input ? [store.createTeam({ ...i.input, name: store.teamNameFree(i.input.name, null) })] : []))
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

  // Tile layout (the split tree of the terminal view), kept per project.
  private tileHandlers(): Group<'tiles'> {
    const store = this.store
    return {
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
    const check = (p: { agent?: string; model?: string; effort?: string; presetId?: number | null }, agent: string) => {
      if (p.agent !== undefined && !AGENTS.has(p.agent)) throw bad('The agent must be claude, codex, opencode or shell')
      validateLaunchSettings({ agent: agent as LaunchSettings['agent'], ...(p.model !== undefined ? { model: p.model.trim() } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}) })
      if (p.presetId != null) this.requirePreset(p.presetId)
    }
    const cwd = (v: unknown): string => {
      if (typeof v !== 'string' || !v.trim() || /[\0-\x1f\x7f]/.test(v)) throw bad('The folder is not valid')
      return v.trim()
    }
    return {
      'scratch:list': (crewId) => store.listScratch(this.requireCrew(crewId).id),
      'scratch:create': (input: ScratchInput) => {
        const crew = this.requireCrew(input.crewId)
        check(input, input.agent)
        const scratch = store.createScratch({
          crewId: crew.id,
          title: cleanName(input.title, 'The title'),
          agent: input.agent,
          model: input.model?.trim() ?? '',
          effort: input.effort ?? '',
          presetId: input.presetId ?? null,
          view: input.view === 'chat' || input.view === 'terminal' ? input.view : input.agent === 'claude' ? 'chat' : 'terminal',
          cwd: input.cwd === undefined ? crew.folder : cwd(input.cwd),
        })
        this.log('scratch', `Tile ${scratch.title} created`, crew.id)
        return scratch
      },
      'scratch:update': (scratchId, patch: ScratchPatch) => {
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
        this.log('scratch', `Tile ${scratch.title} updated`, scratch.crewId)
        return scratch
      },
      'scratch:delete': (scratchId) => {
        const scratch = this.requireScratch(scratchId)
        this.sessions.stop(this.scratchKey(scratchId))
        void this.chat.drop(scratchId)
        this.detachScratch(scratchId)
        store.deleteScratch(scratchId)
        this.log('scratch', `Tile ${scratch.title} deleted`, scratch.crewId)
      },
      'scratch:start': (scratchId, resume) => {
        this.requireScratch(scratchId)
        return this.startScratch(scratchId, { resume: resume === true })
      },
      'scratch:status': (scratchId) => {
        this.requireScratch(scratchId)
        return this.scratchStatus(scratchId)
      },
      'scratch:spend': (crewId) => store.scratchSpend(this.requireCrew(crewId).id, this.now() - 24 * HOUR),
      'scratch:stop': (scratchId) => {
        this.requireScratch(scratchId)
        this.stopScratch(scratchId)
      },
      'scratch:write': (scratchId, data) => this.sessions.write(this.scratchKey(scratchId), data),
      'scratch:resize': (scratchId, cols, rows) => this.sessions.resize(this.scratchKey(scratchId), cols, rows),
      'scratch:buffer': (scratchId) => this.sessions.buffer(this.scratchKey(scratchId)),
      'scratch:setView': (scratchId, view) => this.setView(scratchId, view),
    }
  }

  private usageHandlers(): Group<'usage'> & Group<'purge'> & Group<'budgets'> {
    const deps = () => ({ store: this.store, now: this.now })
    const checkView = (view: UsageView): UsageView => {
      if (!view || typeof view !== 'object') throw bad('Unknown view')
      if (view.kind === 'report') return { kind: 'report', query: { ...view.query, filter: cleanFilter(view.query?.filter) } }
      if (view.kind === 'series') return { kind: 'series', query: { ...view.query, filter: cleanFilter(view.query?.filter) } }
      throw bad('Unknown view')
    }
    const query = (q: UsageQuery): UsageQuery => ({ ...q, filter: cleanFilter(q?.filter) })
    return {
      'usage:report': (q) => queryUsage(deps(), query(q)),
      'usage:timeseries': (q) => querySeries(deps(), { ...q, filter: cleanFilter(q?.filter) }),
      'usage:exportText': (view: UsageView, format: ExportFormat) => exportView(deps(), checkView(view), format),
      'usage:export': async (view: UsageView, format: ExportFormat) => ({ saved: await this.saveExport(exportView(deps(), checkView(view), format)) }),
      'budgets:get': () => this.budgetStatus(),
      'budgets:set': (patch) => {
        this.budgetConfig = mergeBudgets(this.budgetConfig, patch)
        this.store.setJson(BUDGETS_KEY, this.budgetConfig)
        this.checkBudgets()
        return this.budgetStatus()
      },
    }
  }

  // `claude doctor` for the Chat view's /doctor: its report as plain text, colours and secrets removed.
  private async claudeDoctor(): Promise<string> {
    const cli = resolveCli('claude')
    if (!cli) throw bad('Claude Code is not on PATH')
    const r = await runHidden(cli.file, ['doctor'], { shell: cli.shell, timeoutMs: 60_000, quiet: true })
    const text = stripAnsi(`${r.stdout}${r.stderr}`).split(/\r?\n/).map(scrubLogLine).join('\n').trim()
    if (!text) throw bad('claude doctor printed nothing')
    return text.slice(0, 20_000)
  }

  private capabilityHandlers(): Group<'capabilities'> & Group<'claudeMods'> & Group<'claude'> {
    return {
      'capabilities:get': (): Promise<CapabilityReport> => this.prober.get(),
      'capabilities:refresh': (): Promise<CapabilityReport> => this.prober.refresh(),
      'claude:doctor': () => this.claudeDoctor(),
      'claudeMods:get': (tileId): ClaudeTileState | null => this.claudeAgents?.get(tileId) ?? null,
    }
  }

  // The native mods' plugin folders (plugin/mods/<id>) for the enabled mods, each passed to Claude Code with
  // --plugin-dir. Operant's own Subagent Panel has no plugin. A folder that is missing is skipped with a log line.
  private modPluginDirs(): string[] {
    if (!this.modPluginsDir) return []
    const dirs: string[] = []
    for (const id of enabledMods(this.settings.claudeMods.mods)) {
      if (id === 'subagents') continue
      const dir = join(this.modPluginsDir, id)
      if (existsSync(dir)) dirs.push(dir)
      else this.log('error', `Claude mod ${id} is not installed: ${dir} is missing`)
    }
    return dirs
  }

  private mcpHandlers(): Group<'mcp'> {
    // Refusals from the CLIs and config files reach the page as plain messages.
    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn()
      } catch (err) {
        throw err instanceof McpError ? bad(err.message) : err
      }
    }
    const folderOf = (crewId: number | null): string | null => (crewId == null ? null : this.requireCrew(crewId).folder)
    return {
      'mcp:list': (crewId, refresh) => guard(() => (refresh ? this.mcp.list(folderOf(crewId)) : this.mcp.cached(folderOf(crewId)))),
      'mcp:add': (crewId, input) => guard(() => this.mcp.add(folderOf(crewId), input)),
      'mcp:update': (crewId, id, input) => guard(() => this.mcp.update(folderOf(crewId), id, input)),
      'mcp:setEnabled': (crewId, id, enabled) => guard(() => this.mcp.setEnabled(folderOf(crewId), id, enabled === true)),
      'mcp:remove': (crewId, id) => guard(() => this.mcp.remove(folderOf(crewId), id)),
      'mcp:optional': (crewId, refresh) => guard(() => this.mcp.optional(folderOf(crewId), refresh === true)),
      'mcp:optionalAdd': (crewId, id, targets) => guard(() => this.mcp.addOptional(folderOf(crewId), id, targets)),
      'mcp:optionalRemove': (crewId, id) => guard(() => this.mcp.removeOptional(folderOf(crewId), id)),
    }
  }

  // The local model server client's key, read per call from the encrypted store.
  private localLlm() {
    return { apiKey: () => this.secrets.get(LOCAL_LLM_KEY) }
  }

  // Memory, aux, CodeGraph rebuild, backup and superpowers: thin calls into Ops (core/ops.ts).
  private opsHandlers(): Group<'memory'> & Group<'aux'> & Group<'codegraph'> & Group<'backup'> & Group<'superpowers'> {
    const ops = this.ops
    return {
      'memory:recall': (query, crewId) => ops.recall(query, crewId),
      'memory:edit': (id, patch) => this.learn.editLesson(id, patch),
      'memory:delete': (id) => this.learn.setLessonStatus(id, 'deleted'),
      'memory:export': () => ops.exportMemory(),
      'memory:reset': (req) => ops.reset(req),
      'memory:diagnostics': async () => ops.diagnostics(await this.learn.status()),
      'aux:status': () => ops.aux(),
      'aux:enhancePrompt': (text, commands, context) => this.enhancePrompt(text, commands, context),
      'aux:enhanceContext': (text, scratchId) => this.enhanceContext(text, scratchId),
      'codegraph:rebuild': (folder) => ops.codegraphRebuild(folder),
      'codegraph:status': (folder) => ops.codegraphStatus(folder),
      'backup:create': (label) => ops.createBackup(label),
      'backup:list': () => ops.listBackups(),
      'backup:restore': (name, confirm) => ops.restoreBackup(name, confirm),
      'backup:delete': (name) => ops.deleteBackup(name),
      'superpowers:status': () => ops.superpowers(),
    }
  }

  private miscHandlers(): Group<'health'> & Group<'hindsight'> & Group<'learn'> & Group<'index'> & Group<'events'> & Group<'settings'> {
    const store = this.store
    const indexes = this.indexes
    return {
      'index:status': (crewId) => {
        const crew = store.getCrew(crewId)
        return crew ? indexes.status(crew.folder) : null
      },
      'index:run': (crewId) => this.runIndex(crewId),
      'hindsight:status': () => this.hindsightStatus(),
      'learn:status': (crewId) => this.learn.status(crewId),
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
      'learn:runNow': (tileId, confirm) => {
        const tile = this.store.getScratch(tileId)
        if (!tile) throw notFound(`Tile ${tileId} not found`)
        if (!tile.sessionId) throw bad('This tile has no session to learn from yet')
        return this.learn.learnNow(tile.crewId, tile.sessionId, confirm === true)
      },
      'learn:records': (filter) => this.learn.changeRecords(filter ?? {}),
      'learn:rollback': (changeId) => this.learn.rollback(changeId),
      'learn:clearRecords': (crewId) => this.learn.clearRecords(crewId),
      'hindsight:act': (action) => {
        if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new OperantError('BAD_ARGS', 'Action must be start, stop or restart')
        return this.hindsightAct(action)
      },
      'hindsight:adapters': () => listAdapters(),
      'hindsight:test': () => this.hindsight.test(),
      'hindsight:keyState': () => this.hindsightKeys(),
      'hindsight:setKey': (slot, key) => {
        const k = typeof key === 'string' ? key.trim() : ''
        if (k.length < 8 || /\s/.test(k)) throw bad('An API key is at least 8 characters with no spaces')
        this.secrets.set(HINDSIGHT_KEY[slotOf(slot)], k)
        return this.hindsightKeys()
      },
      'hindsight:clearKey': (slot) => {
        this.secrets.delete(HINDSIGHT_KEY[slotOf(slot)])
        return this.hindsightKeys()
      },
      // The one time a key is shown: right after it is made, so it can be copied to the other machines.
      'hindsight:generateKey': () => {
        const key = generateApiKey()
        this.secrets.set(HINDSIGHT_KEY.shared, key)
        return key
      },
      'events:recent': (limit) => store.recentEvents(limit),
      'events:clear': () => void store.db.prepare('DELETE FROM events').run(),
      'settings:get': () => this.settings,
      'settings:set': (patch) => this.setSettings(patch),
      'settings:reset': (section) => {
        if (section !== undefined && !SETTINGS_SECTIONS.includes(section)) throw bad(`Unknown settings section "${String(section)}"`)
        return this.saveSettings(resetSettings(this.settings, section))
      },
    }
  }

  private hindsightKeys() {
    return { shared: this.secrets.get(HINDSIGHT_KEY.shared) !== null, remote: this.secrets.get(HINDSIGHT_KEY.remote) !== null }
  }

  async hindsightStatus() {
    return this.hindsight.status()
  }

  async hindsightAct(action: 'start' | 'stop' | 'restart') {
    return this.hindsight.act(action)
  }

  // An OpenCode model the patch sets must be listed by `opencode models`; with no catalogue (OpenCode missing) nothing is refused.
  private async setSettings(patch: SettingsPatch): Promise<Settings> {
    const next = mergeSettings(this.settings, patch)
    const ids: string[] = []
    if (patch.learn && ('model' in patch.learn || 'cli' in patch.learn) && next.learn.cli === 'opencode') ids.push(next.learn.model)
    for (const task of Object.keys(patch.auxModels ?? {}) as AuxTask[]) if (next.auxModels[task].cli === 'opencode') ids.push(next.auxModels[task].model)
    if (ids.some(Boolean)) {
      const { all, missing } = await checkOpencodeIds(ids, learnModelList(() => this.settings.learn, this.localLlm()))
      if (missing && all.models.length) throw new Error(notListedError(missing))
    }
    return this.saveSettings(next)
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
    for (const s of this.store.listScratch(crewId)) if (this.sessions.isRunning(this.scratchKey(s.id))) n++
    return n
  }

  private moveHandlers(): Group<'import'> & Group<'data'> & Group<'providers'> {
    const bundleText = (): ExportText => ({
      filename: `operant-export-${new Date(this.now()).toISOString().slice(0, 10)}.json`,
      mime: 'application/json',
      text: JSON.stringify(exportBundle(this.store, this.now()), null, 2),
    })
    return {
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

  // Budgets

  // Project budgets: warnings and a log line per decision.
  checkBudgets(): BudgetDecision[] {
    const decisions = this.budgets.check()
    for (const d of decisions) this.onBudget(d)
    return decisions
  }

  private onBudget(d: BudgetDecision): void {
    const crew = d.crewId == null ? null : this.store.getCrew(d.crewId)
    const money = `$${d.spentUsd.toFixed(2)} of $${d.capUsd.toFixed(2)}`
    const who = d.crewId == null ? 'All projects are' : `Project ${crew?.name ?? d.crewId} is`
    this.log('budget', `${who} at ${Math.floor(d.pct)}% of the ${WINDOW_LABEL[d.window]} budget (${money})`, d.crewId)
    this.emit('budget', { crewId: d.crewId, window: d.window, spentUsd: d.spentUsd, capUsd: d.capUsd, pct: d.pct })
  }

  private budgetStatus(): BudgetStatus {
    return { config: this.budgetConfig, ...this.budgets.progress() }
  }

  get currentSettings(): Settings {
    return this.settings
  }

  // Startup seeds from .env (loaded by main): the Hindsight URL and key fill settings that are still unset.
  // Nothing already stored is overwritten.
  seedFromEnv(env: NodeJS.ProcessEnv): void {
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

  // Opens the CLI socket (a failure is logged, the timers start anyway), sweeps once and starts the timers.
  async start(): Promise<void> {
    if (this.timers.length > 0) return
    if (this.cli) {
      try {
        await this.cli.listen()
      } catch (err) {
        // Without the socket tiles start from now on get no CLI environment (`operant` exits 7).
        this.log('error', `The operant CLI socket could not be opened (${err instanceof Error ? err.name : 'unexpected error'}). Tiles run without the operant CLI`)
      }
    }
    this.timers.push(this.scheduler.every(() => this.pollUsage(), USAGE_POLL_MS))
    this.timers.push(this.scheduler.every(() => void this.providers.refresh().catch(() => undefined), PROVIDER_TICK_MS))
    this.checkBudgets()
  }

  stopTimers(): void {
    for (const h of this.timers.splice(0)) this.scheduler.cancel(h)
  }

  // Quit path: no more timers, every process Operant started killed by pid, every token revoked, the socket
  // closed. No step can hold the quit for more than shutdownStepMs. Sessions are the caller's.
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
    await bounded(() => this.chat.stopAll())
    await bounded(() => killAllOwn(this.shutdownStepMs))
    for (const id of this.scratchFeeds.keys()) this.cli?.revokeToken(id)
    await bounded(() => this.cli?.close())
  }

  // Reads new transcript lines for every running Claude tile.
  pollUsage(): void {
    let rows = 0
    for (const id of [...this.scratchFeeds.keys()]) rows += this.pollScratch(id)
    if (rows > 0) this.checkBudgets()
    this.learnIdle()
  }

  // The finished flag: a turn going from working to idle sets it, the next turn starting clears it.
  private noteTurn(phases: Map<number, string>, scratchId: number, phase: string): void {
    const prev = phases.get(scratchId)
    phases.set(scratchId, phase)
    const feed = this.scratchFeeds.get(scratchId)
    if (!feed) return
    if (phase === 'working') feed.finished = false
    else if (prev === 'working' && phase === 'idle') feed.finished = true
  }

  // The app's own timer: a Claude tile whose transcript has not grown for learn.idleMinutes (or a few seconds when the tile has
  // the finished flag) and is not mid-turn is learned from once, until it grows again.
  private learnIdle(): void {
    const l = this.settings.learn
    if (!l.enabled || l.mode === 'off' || l.idleMinutes <= 0) return
    const now = this.now()
    for (const [id, feed] of this.scratchFeeds) {
      if (feed.activityAt === null) continue
      if (now - feed.activityAt < (feed.finished ? FINISHED_QUIET_MS : l.idleMinutes * 60_000)) continue
      const phase = this.chat.get(id)?.snapshot().turn.phase
      if (phase && phase !== 'idle') continue
      const scratch = this.store.getScratch(id)
      if (scratch?.agent !== 'claude' || !scratch.sessionId) continue
      feed.activityAt = null
      feed.finished = false
      void this.learn.learnNow(scratch.crewId, scratch.sessionId)
    }
  }

  // Notices

  // Settings

  private applySettings(): void {
    const { file, args } = this.settings.shell
    this.sessions.setShell(file ? { file, args: args.split(/\s+/).filter(Boolean) } : null)
    setSharedBanks(this.settings.hindsight.mode !== 'local')
    if (!this.settings.claudeMods.enabled) this.claudeAgents?.dispose()
    if (!this.settings.claudeMods.keepWarm) this.chat?.stopAllKeepWarm()
  }

  // The hooks and status line for Claude tiles, or undefined when Claude mods are off.
  private claudeModsConfig(): Record<string, unknown> | undefined {
    if (!this.claudeModsPaths) return undefined
    return claudeModsConfig(this.claudeModsPaths, this.settings.claudeMods) ?? undefined
  }

  // The learn AI for one aux task: the learn settings, with the task's own CLI and model where it has them.
  private auxLearn(task: AuxTask): LearnSettings {
    return { ...this.settings.learn, ...resolveAux(task, this.settings.auxModels, this.settings.learn) }
  }

  // Every learn and memory model call goes through the aux budget: counts, spend, bounded retries and limits.
  // A model the settings name that OpenCode does not list is refused before any call is counted or made.
  private budgetedModel(base: LearnModel, problem?: () => Promise<string | null>): LearnModel {
    return async (prompt, onUsed, opts) => {
      const bad = await problem?.()
      if (bad) throw new Error(bad)
      return this.aux.call('learn', async () => ({ text: await base(prompt, onUsed, opts) }), { confirm: opts?.confirm }).then((r) => r.text)
    }
  }

  // Chat view "Enhance prompt": one counted, capped, retried call to the promptEnhance aux model.
  private readonly enhanceModel: LearnModel
  // The recall and CodeGraph lookups for a tile's project: not model calls, so they are not counted.
  private async enhanceContext(text: string, scratchId: number): Promise<EnhanceContext> {
    const folder = this.store.getCrew(this.requireScratch(scratchId).crewId)?.folder ?? null
    const memory = this.settings.memory
    return gatherEnhanceContext(String(text ?? ''), {
      recall: (q) => recallMemory(this.hindsight, folder, q, { ...memory, maxTokens: Math.min(memory.maxTokens, ENHANCE_MAX_MEMORY_TOKENS) }),
      symbols: async (q) => (folder ? this.indexes.symbols(folder, q, ENHANCE_MAX_SYMBOL_LINES) : null),
    })
  }

  private async enhancePrompt(text: string, commands: Array<{ name: string; description: string }> = [], context?: EnhanceContext): Promise<string> {
    const rough = String(text ?? '').trim()
    if (!rough) throw new Error('Write something in the box first')
    const bad = await this.learnAiProblem('promptEnhance')
    if (bad) throw new Error(bad)
    const model = this.enhanceModel
    const skills = mergeSkills(installedSkills(claudeDirOf()), commands.filter((c) => c && typeof c.name === 'string').map((c) => ({ name: c.name, description: String(c.description ?? '') })))
    const prompt = buildEnhancePrompt(rough, skills, context && Array.isArray(context.memories) && Array.isArray(context.symbols) ? context : null)
    const r = await this.aux.call('promptEnhance', async () => ({ text: await model(prompt) }))
    const out = parseEnhanceReply(r.text)
    if (!out) throw new Error('The model returned no text')
    return out
  }

  private async learnAiProblem(task: AuxTask): Promise<string | null> {
    return (await resolveLearnAi(this.auxLearn(task), learnModelList(() => this.settings.learn, this.localLlm()))).error ?? null
  }

  // Called by the updater before an install: a snapshot of the settings, presets, teams and learn data.
  snapshotBeforeUpdate(toVersion: string): string {
    return this.ops.snapshotBeforeUpdate(toVersion)
  }

  private log(kind: string, message: string, crewId: number | null = null): void {
    this.emit('event', this.store.addEvent(kind, message, crewId))
  }

  // The CLI: a tile's token identifies its project; the memory commands use that project's Hindsight bank.

  private identify(tileId: number): Identity | null {
    const tile = this.store.getScratch(tileId)
    return tile ? { crewId: tile.crewId } : null
  }

  private async runCli(who: Identity, req: CliRequest): Promise<CliResult> {
    const crew = this.store.getCrew(who.crewId)
    if (!crew) return { exit: EXIT.FORBIDDEN, error: 'forbidden' }
    const args = req.args ?? {}
    if (req.cmd === 'memory.recall') {
      const query = typeof args.query === 'string' ? args.query : ''
      const r = await this.hindsight.recall(bankFor(crew.folder), query)
      return r.ok ? { exit: EXIT.OK, out: r.items?.join('\n') ?? '' } : { exit: EXIT.ERROR, error: r.error ?? 'recall failed' }
    }
    if (req.cmd === 'memory.retain') {
      const text = typeof args.text === 'string' ? args.text : ''
      const tags = Array.isArray(args.tag) ? args.tag.filter((t): t is string => typeof t === 'string') : []
      const r = await this.hindsight.retain(bankFor(crew.folder), text, tags, 'Operant agent note')
      return r.ok ? { exit: EXIT.OK, out: 'retained' } : { exit: EXIT.ERROR, error: r.error ?? 'retain failed' }
    }
    return { exit: EXIT.USAGE, error: `unknown command ${req.cmd}` }
  }

  // Tiles

  private scratchKey(id: number): SessionKey {
    return `scratch:${id}`
  }

  private launchContext(crewId: number, crewFolder: string, sessionId: string): LaunchContext {
    const platform = this.launch.platform ?? process.platform
    const cliDir = this.launch.cliDir
    const browserUrl = this.settings.browser.aiControl ? (this.browserMcp?.() ?? null) : null
    return {
      platform,
      shell: shellKind(this.settings.shell.file, platform),
      crewId,
      crewFolder,
      pluginDir: this.pluginDir,
      launchDir: this.launch.launchDir ?? join(tmpdir(), 'operant2', 'launch'),
      rolesDir: this.launch.rolesDir ?? join(tmpdir(), 'operant2', 'roles'),
      sessionId,
      supported: this.launch.supported,
      operantCli: cliDir ? join(cliDir, platform === 'win32' ? 'operant.cmd' : 'operant') : undefined,
      operantNode: this.launch.operantNode,
      defaultCacheTtl: this.settings.tokens.defaultCacheTtl,
      subagentCacheTtl: this.settings.tokens.subagentCacheTtl,
      pinClaudeVersion: this.settings.tokens.pinClaudeVersion,
      mods: this.claudeModsConfig(),
      modPlugins: this.settings.claudeMods.enabled ? this.modPluginDirs() : [],
      browserMcp: browserUrl ? { url: browserUrl } : undefined,
    }
  }

  private writeFiles(launch: LaunchResult): void {
    writeLaunchFiles(
      launch.files,
      this.launch.writer ?? { mkdir: (dir) => void mkdirSync(dir, { recursive: true }), writeFile: (path, content) => writeFileSync(path, content) },
    )
  }

  // Fills the socket and token placeholders (issuing the tile's token) and puts the CLI folder on its PATH.
  // Without a CLI server or a socket the tile runs without the CLI.
  private sessionEnv(launchEnv: Record<string, string>, tileId: number): Record<string, string> {
    const wantsCli = Object.values(launchEnv).some((v) => v === SOCKET_PLACEHOLDER || v === TOKEN_PLACEHOLDER)
    const token = wantsCli && this.cli?.address ? this.cli.issueToken(tileId) : null
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

  scratchStatus(scratchId: number): ScratchStatus {
    const scratch = this.store.getScratch(scratchId)
    return {
      scratchId,
      running: this.sessions.isRunning(this.scratchKey(scratchId)) || this.chat.isRunning(scratchId),
      sessionId: scratch?.sessionId ?? null,
      ...(scratch ? { view: scratch.view } : {}),
    }
  }

  // Never restarts a running session. A launch failure is logged and thrown as an OperantError.
  startScratch(scratchId: number, opts: { resume?: boolean } = {}): ScratchStatus {
    const scratch = this.store.getScratch(scratchId)
    const key = this.scratchKey(scratchId)
    if (!scratch) throw notFound(`Scratch terminal ${scratchId} not found`)
    if (this.sessions.isRunning(key) || this.chat.isRunning(scratchId)) return this.scratchStatus(scratchId)
    const crew = this.store.getCrew(scratch.crewId)
    if (scratch.agent === 'claude' && scratch.view === 'chat') return this.startChat(scratch, opts)
    try {
      const keep = !!opts.resume && scratch.sessionId != null
      const sessionId = keep ? scratch.sessionId! : randomUUID()
      if (!keep) this.store.updateScratch(scratchId, { sessionId })
      // Claude only writes a transcript with the first message: --resume of an id it has not saved fails ("No
      // conversation found"), so a conversation without turns restarts with the same id instead.
      const resume = keep && (scratch.agent !== 'claude' || existsSync(this.transcriptFile(scratch.cwd, sessionId)))
      const row: ScratchTerminal = { ...scratch, sessionId }
      const preset = scratch.presetId != null ? this.store.getPreset(scratch.presetId) : null
      const ctx = this.launchContext(scratch.crewId, crew?.folder ?? scratch.cwd, sessionId)
      const launch = buildScratchLaunch(row, ctx, { preset, resume })
      this.writeFiles(launch)
      const env = this.sessionEnv(launch.env, scratchId)
      // A Claude tile tagged with its tile id and Operant as the source: the hooks write only for these.
      const tagged: Record<string, string> = launch.file === 'claude' && ctx.mods ? { OPERANT_TILE_ID: String(scratchId), OPERANT_SOURCE: 'operant' } : {}
      this.sessions.start({ key, cwd: launch.cwd, env: { ...env, ...tagged }, command: commandLine(launch, shellOf(ctx)) })
      if (launch.file === 'claude') this.attachScratch(scratchId, this.transcriptFile(launch.cwd, sessionId), sessionId)
      if (ctx.mods) this.claudeAgents?.begin(scratchId, sessionId, launch.cwd)
      this.log('scratch', `Tile ${scratch.title} started`, scratch.crewId)
      return this.scratchStatus(scratchId)
    } catch (err) {
      const failure = toOperantError(err)
      this.log('error', `Tile ${scratch.title} failed to start: ${failure.message}`, scratch.crewId)
      throw failure
    }
  }

  stopScratch(scratchId: number): void {
    this.sessions.stop(this.scratchKey(scratchId))
    if (this.chat.isRunning(scratchId)) {
      this.closing.add(scratchId)
      void this.chat.stop(scratchId)
    }
  }

  private scratchId(key: SessionKey): number | null {
    const m = /^scratch:(\d+)$/.exec(key)
    return m ? Number(m[1]) : null
  }

  private onScratchExit(scratchId: number, exitCode: number): void {
    this.detachScratch(scratchId)
    this.cli?.revokeToken(scratchId)
    this.claudeAgents?.end(scratchId)
    this.emit('scratch:exit', { scratchId, exitCode, switching: this.switching.has(scratchId) })
    const scratch = this.store.getScratch(scratchId)
    if (scratch) this.log('scratch', `Tile ${scratch.title} closed${exitCode ? ` (exit ${exitCode})` : ''}`, scratch.crewId)
    // The learn step for a finished Claude session; it does nothing when learning is off.
    if (scratch?.agent === 'claude' && scratch.sessionId && this.settings.learn.mode !== 'off' && !this.switching.has(scratchId)) void this.learn.learnNow(scratch.crewId, scratch.sessionId)
  }

  // ---- Chat view (claude-chat.ts)

  private makeChatSession(scratch: ScratchTerminal, sessionId: string): ChatSession {
    const id = scratch.id
    const eventsDir = this.claudeModsPaths?.eventsDir
    return this.chat.ensure(
      id,
      (emit) =>
        new ChatSession({
          scratchId: id,
          sessionId,
          cwd: scratch.cwd,
          transcriptFile: this.transcriptFile(scratch.cwd, sessionId),
          ...(eventsDir ? { statusFile: join(eventsDir, `status-${sessionId}.json`) } : {}),
          launch: (resume) => this.chatLaunch(id, sessionId, resume),
          emit,
          ...(this.chatSpawn ? { spawn: this.chatSpawn } : {}),
          now: this.now,
          onStart: () => this.onChatStart(id, sessionId),
          onWaiting: (w) => (w ? this.claudeAgents?.setWaiting(id, w) : this.claudeAgents?.clearWaiting(id)),
          onExit: (info) => this.onChatExit(id, info),
          effort: scratch.effort || null,
          bypassAllowed: this.presetOf(scratch)?.permissionMode === 'bypassPermissions',
          keepWarm: {
            ttlMs: () => this.cacheTtlMs(scratch),
            enabled: () => this.settings.claudeMods.keepWarm,
            budgetBlocked: () => this.aux.blocked(),
            recordUsage: (u) => this.aux.record('keepwarm', u),
            load: () => (this.store.getJson(`keepwarm.${id}`) as KeepWarmPersisted | null) ?? null,
            save: (p) => this.store.setJson(`keepwarm.${id}`, p),
          },
        }),
    )
  }

  // The tile's prompt cache lifetime as launch.ts passes it to Claude: its preset, else the Tokens default; 'auto' counts as 5 minutes.
  private cacheTtlMs(scratch: ScratchTerminal): number {
    const own = this.presetOf(scratch)?.cacheTtl ?? 'auto'
    const ttl = own === 'auto' ? this.settings.tokens.defaultCacheTtl : own
    return ttl === '1h' ? 3_600_000 : 300_000
  }

  private presetOf(scratch: ScratchTerminal): Preset | null {
    return scratch.presetId != null ? this.store.getPreset(scratch.presetId) : null
  }

  private chatLaunch(scratchId: number, sessionId: string, resume: boolean): ChatLaunchSpec {
    const scratch = this.store.getScratch(scratchId)
    if (!scratch) throw notFound(`Scratch terminal ${scratchId} not found`)
    const crew = this.store.getCrew(scratch.crewId)
    const ctx = this.launchContext(scratch.crewId, crew?.folder ?? scratch.cwd, sessionId)
    const launch = buildChatLaunch({ ...scratch, sessionId }, ctx, { preset: this.presetOf(scratch), resume })
    this.writeFiles(launch)
    const base = this.launch.baseEnv ?? process.env
    const cli = resolveCli('claude', base, ctx.platform)
    const tagged: Record<string, string> = ctx.mods ? { OPERANT_TILE_ID: String(scratchId), OPERANT_SOURCE: 'operant' } : {}
    const env = { ...inheritedEnv(base), ...this.sessionEnv(launch.env, scratchId), ...tagged }
    if (!cli) return { file: 'claude', args: launch.args, cwd: launch.cwd, env, shell: false, blocked: 'Claude Code was not found on PATH. Install it, or check Settings > Capabilities.' }
    return { file: cli.file, args: launch.args, cwd: launch.cwd, env, shell: cli.shell }
  }

  // A Chat tile's process started: follow its transcript for spend and tell the Agents panel.
  private onChatStart(scratchId: number, sessionId: string): void {
    const scratch = this.store.getScratch(scratchId)
    if (!scratch) return
    this.attachScratch(scratchId, this.transcriptFile(scratch.cwd, sessionId), sessionId)
    if (this.claudeModsConfig()) this.claudeAgents?.begin(scratchId, sessionId, scratch.cwd)
    this.log('scratch', `Tile ${scratch.title} started (Chat view)`, scratch.crewId)
  }

  private onChatExit(scratchId: number, info: { code: number | null; expected: boolean }): void {
    this.detachScratch(scratchId)
    this.cli?.revokeToken(scratchId)
    this.claudeAgents?.end(scratchId)
    this.emit('scratch:exit', { scratchId, exitCode: info.code ?? 0, switching: this.switching.has(scratchId) })
    const scratch = this.store.getScratch(scratchId)
    const closing = this.closing.delete(scratchId)
    if (scratch) this.log('scratch', `Tile ${scratch.title} ${info.expected ? 'closed' : 'stopped unexpectedly'}${info.code ? ` (exit ${info.code})` : ''}`, scratch.crewId)
    // The end of a session the owner closed (not a crash, a restart or a view switch) runs the learn step once.
    if (closing && info.expected && !this.switching.has(scratchId) && scratch?.agent === 'claude' && scratch.sessionId && this.settings.learn.mode !== 'off') void this.learn.learnNow(scratch.crewId, scratch.sessionId)
  }

  private startChat(scratch: ScratchTerminal, opts: { resume?: boolean }): ScratchStatus {
    const id = scratch.id
    try {
      const resume = !!opts.resume && scratch.sessionId != null
      const existing = this.chat.get(id)
      const sessionId = resume ? scratch.sessionId! : randomUUID()
      // The same conversation reopens with its items; a new one starts clean.
      if (existing && (!resume || existing.state.sessionId !== sessionId)) this.chat.forget(id)
      if (!resume) this.store.updateScratch(id, { sessionId })
      const session = this.makeChatSession(scratch, sessionId)
      session.start(resume ? undefined : false)
      return this.scratchStatus(id)
    } catch (err) {
      const failure = toOperantError(err)
      this.log('error', `Tile ${scratch.title} failed to start: ${failure.message}`, scratch.crewId)
      throw failure
    }
  }

  private waitScratchExit(scratchId: number, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer)
        this.off('scratch:exit', onExit)
        resolve(ok)
      }
      const onExit = (e: { scratchId: number }) => {
        if (e.scratchId === scratchId) done(true)
      }
      const timer = setTimeout(() => done(false), ms)
      this.on('scratch:exit', onExit)
    })
  }

  // Chat <-> Terminal on the same session, only between turns: the one process stops, the other starts with --resume.
  private async setView(scratchId: number, view: 'chat' | 'terminal'): Promise<ScratchStatus> {
    const scratch = this.requireScratch(scratchId)
    if (scratch.agent !== 'claude') throw bad('Only Claude Code tiles have a Chat view')
    if (view !== 'chat' && view !== 'terminal') throw bad('The view must be chat or terminal')
    if (scratch.view === view) return this.scratchStatus(scratchId)
    const session = this.chat.get(scratchId)
    if (session?.running && session.busy) throw conflict('Wait for Claude to finish, or Stop it, before switching views')
    const key = this.scratchKey(scratchId)
    const wasRunning = this.chat.isRunning(scratchId) || this.chat.get(scratchId)?.state.process === 'starting' || this.sessions.isRunning(key)
    this.switching.add(scratchId)
    try {
      if (view === 'terminal') {
        await this.chat.drop(scratchId)
        this.store.updateScratch(scratchId, { view })
      } else {
        if (this.sessions.isRunning(key)) {
          // The terminal is a shell that ran claude: /exit ends Claude but not the shell, so the shell is closed too.
          const exited = this.waitScratchExit(scratchId, 1500)
          this.sessions.write(key, '/exit\r')
          if (!(await exited)) {
            this.sessions.forceStop(key)
            await this.waitScratchExit(scratchId, 1000)
          }
        }
        this.store.updateScratch(scratchId, { view })
      }
      if (!wasRunning) return this.scratchStatus(scratchId)
      try {
        return this.startScratch(scratchId, { resume: true })
      } catch (err) {
        // The other side would not start: the tile keeps the view it had, so the switch can be tried again.
        this.store.updateScratch(scratchId, { view: scratch.view })
        throw err
      }
    } finally {
      this.switching.delete(scratchId)
    }
  }

  private chatHandlers(): Group<'chat'> {
    const live = (scratchId: number): ChatSession => {
      const scratch = this.requireScratch(scratchId)
      const s = this.chat.get(scratchId)
      if (!s) throw conflict(`${scratch.title} has no Chat session: start the tile first`)
      return s
    }
    return {
      'chat:snapshot': (scratchId): ChatState => {
        const scratch = this.requireScratch(scratchId)
        if (scratch.agent !== 'claude' || !scratch.sessionId) return emptyChatState(scratchId)
        return (this.chat.get(scratchId) ?? this.makeChatSession(scratch, scratch.sessionId)).snapshot()
      },
      'chat:send': (scratchId, input) => {
        if (!input || typeof input.text !== 'string') throw bad('A message needs text')
        live(scratchId).send(input)
      },
      'chat:interrupt': (scratchId) => live(scratchId).interrupt(),
      'chat:permission': (scratchId, requestId, decision) => {
        if (typeof requestId !== 'string' || !decision || typeof decision.kind !== 'string') throw bad('Not a valid answer')
        if (!live(scratchId).answer(requestId, decision)) throw conflict('That prompt is no longer waiting')
      },
      'chat:setMode': (scratchId, mode) => live(scratchId).setMode(String(mode)),
      'chat:setModel': (scratchId, model) => {
        validateLaunchSettings({ agent: 'claude', model })
        const s = live(scratchId)
        this.store.updateScratch(scratchId, { model })
        s.setModel(model)
        this.saveSettings(mergeSettings(this.settings, { defaultModels: { claude: model } }))
      },
      'chat:setEffort': (scratchId, level) => {
        validateLaunchSettings({ agent: 'claude', effort: level })
        const s = live(scratchId)
        this.store.updateScratch(scratchId, { effort: level })
        s.setEffort(level)
        this.saveSettings(mergeSettings(this.settings, { defaultEfforts: { claude: level } }))
      },
      'chat:requestContext': (scratchId, force) => live(scratchId).requestContext(force === true),
      'chat:history': (scratchId, beforeIndex) => live(scratchId).historyPage(Number.isInteger(beforeIndex) ? beforeIndex : 0),
      'chat:agentHistory': (scratchId, toolUseId) => {
        if (typeof toolUseId !== 'string' || !/^[\w-]{1,120}$/.test(toolUseId)) throw bad('Not a valid tool call id')
        return live(scratchId).agentHistory(toolUseId)
      },
      'chat:restart': (scratchId) => {
        const s = live(scratchId)
        s.restart()
        return s.snapshot()
      },
      'chat:files': (scratchId, query) => listChatFiles(this.requireScratch(scratchId).cwd, typeof query === 'string' ? query.slice(0, 200) : ''),
    }
  }


  // Tile spend: one usage row per assistant message with scratch_id set.
  private attachScratch(scratchId: number, file: string, sessionId: string): void {
    this.scratchFeeds.set(scratchId, { tail: new JsonlTail(file), sessionId, prevContext: null, current: null, currentContext: 0, activityAt: null, finished: false })
  }

  // Reads what is left of a closed or deleted tile's transcript, then stops following it.
  private detachScratch(scratchId: number): void {
    if (this.pollScratch(scratchId) > 0) this.checkBudgets()
    this.scratchFeeds.delete(scratchId)
  }

  // Returns how many usage lines were ingested.
  private pollScratch(scratchId: number): number {
    const feed = this.scratchFeeds.get(scratchId)
    if (!feed || !this.store.getScratch(scratchId)) return 0
    let n = 0
    const lines = feed.tail.read()
    if (lines.length > 0) feed.activityAt = this.now()
    for (const line of lines) {
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
    this.log('index', `Indexing ${crew.name} with CodeGraph`, crewId)
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
      crewId,
    )
    return status
  }

}
