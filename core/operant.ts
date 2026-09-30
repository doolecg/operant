import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { CoreChannel, IpcApi, IpcEvents } from '../shared/ipc'
import { mergeSettings, sanitizeSettings, type Settings } from '../shared/settings'
import type { OperatorContext, OperatorStatus } from '../shared/types'
import type { IndexStatus, CrewIndexes } from './codegraph'
import type { SessionManager } from './sessions'
import type { Store } from './store'
import { JsonlTail, parseLine, transcriptPath } from './transcripts'

type Handlers = { [C in CoreChannel]: (...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<Awaited<ReturnType<IpcApi[C]>>> }

type PushEvents = { [E in keyof IpcEvents]: [IpcEvents[E]] }

export interface OperantOptions {
  store: Store
  sessions: SessionManager
  indexes: CrewIndexes
  pluginDir: string
  now?: () => number
  transcriptFile?: (cwd: string, sessionId: string) => string
}

const HOUR = 60 * 60 * 1000

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Everything the dashboard can ask for or be told about, independent of Electron.
export class Operant extends EventEmitter<PushEvents> {
  readonly handlers: Handlers
  private readonly store: Store
  private readonly sessions: SessionManager
  private readonly indexes: CrewIndexes
  private readonly pluginDir: string
  private readonly now: () => number
  private readonly transcriptFile: (cwd: string, sessionId: string) => string
  // Transcripts being followed for running Claude operators, and each operator's latest context size.
  private readonly tails = new Map<number, JsonlTail>()
  private readonly contexts = new Map<number, OperatorContext>()
  private settings: Settings
  // The day (start-of-day timestamp) the over-budget warning was last logged.
  private budgetWarnedFor = 0

  constructor(opts: OperantOptions) {
    super()
    const { store, sessions, indexes } = opts
    this.store = store
    this.sessions = sessions
    this.indexes = indexes
    this.pluginDir = opts.pluginDir
    this.now = opts.now ?? Date.now
    this.transcriptFile = opts.transcriptFile ?? ((cwd, id) => transcriptPath(cwd, id))
    this.settings = sanitizeSettings(store.getJson('settings'))
    this.applySettings()

    sessions.on('data', (operatorId, data) => this.emit('operator:data', { operatorId, data }))
    sessions.on('exit', (operatorId, exitCode) => {
      this.pollOperator(operatorId)
      this.tails.delete(operatorId)
      if (!store.getOperator(operatorId)) return
      this.setStatus(operatorId, exitCode === 0 ? 'stopped' : 'error')
      this.log('operator', `${store.operatorAddress(operatorId)} stopped${exitCode ? ` (exit ${exitCode})` : ''}`, operatorId)
    })

    this.handlers = {
      'crews:list': () => store.listCrews(),
      'crews:topology': (crewId) => store.topology(crewId),
      'crews:create': ({ name, folder }) => {
        const crew = store.createCrew(name.trim(), folder)
        this.emit('event', store.addEvent('crew', `Crew ${crew.name} created`, crew.id))
        return crew
      },
      'crews:delete': (crewId) => {
        for (const squad of store.topology(crewId)?.squads ?? []) for (const s of squad.operators) sessions.stop(s.id)
        store.deleteCrew(crewId)
      },
      'squads:create': ({ crewId, name }) => store.createSquad(crewId, name.trim()),
      'operators:create': ({ squadId, role, agent, model }) => {
        const operator = store.createOperator(squadId, role.trim(), agent, model.trim())
        this.log('operator', `Operator ${store.operatorAddress(operator.id)} added`, operator.id)
        return operator
      },
      'operators:start': (operatorId) => this.startOperator(operatorId),
      'operators:stop': (operatorId) => sessions.stop(operatorId),
      'operators:write': (operatorId, data) => sessions.write(operatorId, data),
      'operators:resize': (operatorId, cols, rows) => sessions.resize(operatorId, cols, rows),
      'operators:buffer': (operatorId) => sessions.buffer(operatorId),
      'operators:context': () => Object.fromEntries(this.contexts),
      'usage:series': (crewId) => {
        // Last 24 hours in hourly buckets, oldest first.
        const since = Math.floor(this.now() / HOUR) * HOUR - 23 * HOUR
        return store.spendSeries(crewId, since, HOUR, 24)
      },
      'tasks:list': (crewId) => store.listTasks(crewId),
      'tasks:create': ({ crewId, title, operatorId }) => {
        const task = store.createTask(crewId, title.trim(), operatorId ?? null)
        this.emit('event', store.addEvent('task', `Task added: ${task.title}`, crewId, task.operatorId))
        return task
      },
      'tasks:move': (taskId, state) => store.moveTask(taskId, state),
      'index:status': (crewId) => {
        const crew = store.getCrew(crewId)
        return crew ? indexes.status(crew.folder) : null
      },
      'index:run': (crewId) => this.runIndex(crewId),
      'events:recent': (limit) => store.recentEvents(limit),
      'dashboard:summary': () => {
        const crews = store.listCrews()
        const operators = crews.flatMap((r) => store.topology(r.id)?.squads.flatMap((p) => p.operators) ?? [])
        const tasks = crews.flatMap((r) => store.listTasks(r.id))
        return {
          operatorsRunning: operators.filter((s) => s.status === 'running').length,
          operatorsTotal: operators.length,
          tasksOpen: tasks.filter((t) => t.state !== 'done').length,
          spendToday: store.spendSince(startOfDay(this.now())),
          dailyBudgetUsd: this.settings.dailyBudgetUsd,
        }
      },
      'settings:get': () => this.settings,
      'settings:set': (patch) => {
        this.settings = mergeSettings(this.settings, patch)
        store.setJson('settings', this.settings)
        this.applySettings()
        this.emit('settings', this.settings)
        return this.settings
      },
    }
  }

  get currentSettings(): Settings {
    return this.settings
  }

  private applySettings(): void {
    const { file, args } = this.settings.shell
    this.sessions.setShell(file ? { file, args: args.split(/\s+/).filter(Boolean) } : null)
  }

  private checkBudget(): void {
    const budget = this.settings.dailyBudgetUsd
    const day = startOfDay(this.now())
    if (budget <= 0 || this.budgetWarnedFor === day) return
    const spent = this.store.spendSince(day)
    if (spent < budget) return
    this.budgetWarnedFor = day
    this.log('budget', `Daily budget of $${budget.toFixed(2)} reached ($${spent.toFixed(2)} spent today)`)
  }

  private log(kind: string, message: string, operatorId: number | null = null, crewId: number | null = null): void {
    const rid = crewId ?? (operatorId == null ? null : this.store.crewIdOfOperator(operatorId))
    this.emit('event', this.store.addEvent(kind, message, rid, operatorId))
  }

  private setStatus(operatorId: number, status: OperatorStatus): void {
    this.store.setOperatorStatus(operatorId, status)
    this.emit('operator:status', { operatorId, status })
  }

  private startOperator(operatorId: number): void {
    const operator = this.store.getOperator(operatorId)
    const crewId = this.store.crewIdOfOperator(operatorId)
    const crew = crewId == null ? null : this.store.getCrew(crewId)
    if (!operator || !crew || this.sessions.isRunning(operatorId)) return
    const address = this.store.operatorAddress(operatorId)!
    const sessionId = operator.agent === 'claude' ? randomUUID() : undefined
    try {
      this.sessions.start({ operator, address, cwd: crew.folder, pluginDir: this.pluginDir, sessionId })
      if (sessionId) this.tails.set(operatorId, new JsonlTail(this.transcriptFile(crew.folder, sessionId)))
      this.setStatus(operatorId, 'running')
      this.log('operator', `${address} started`, operatorId, crew.id)
    } catch (err) {
      this.setStatus(operatorId, 'error')
      this.log('error', `${address} failed to start: ${err instanceof Error ? err.message : String(err)}`, operatorId, crew.id)
    }
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

  // Reads new transcript lines for every running Claude operator; called on a timer by the host.
  pollUsage(): void {
    for (const operatorId of this.tails.keys()) this.pollOperator(operatorId)
  }

  private pollOperator(operatorId: number): void {
    const tail = this.tails.get(operatorId)
    if (!tail) return
    let latest: OperatorContext | null = null
    for (const line of tail.read()) {
      const u = parseLine(line)
      if (!u) continue
      this.store.upsertMessageUsage(u.messageId, {
        operatorId,
        at: u.at,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheTokens: u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens,
        costUsd: u.costUsd,
      })
      latest = { model: u.model, contextTokens: u.contextTokens, at: u.at }
    }
    if (latest) {
      this.contexts.set(operatorId, latest)
      this.emit('usage', { operatorId, context: latest })
      this.checkBudget()
    }
  }

  // Operators can't outlive the app in v1, so anything left "running" from a crash is reset.
  resetStaleOperators(): void {
    for (const crew of this.store.listCrews())
      for (const squad of this.store.topology(crew.id)?.squads ?? [])
        for (const s of squad.operators) if (s.status !== 'stopped' && !this.sessions.isRunning(s.id)) this.store.setOperatorStatus(s.id, 'stopped')
  }
}
