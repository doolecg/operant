import type { JobReview } from '../shared/types'
import { JobError, type JobActor, type JobEdit, type JobEngine, type JobRecord } from './jobs'
import { MessageError, formatDigest, isSystemMessage, type Actor, type InboxResult, type MessageBus } from './messages'
import type { Store } from './store'

// Who is calling, resolved by the CLI server from the session token. Never taken from the request.
export interface Identity {
  kind: 'operator' | 'master'
  operatorId: number
}

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  FORBIDDEN: 5,
  LIMITED: 6,
  UNREACHABLE: 7,
} as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface CollabRequest {
  cmd: string
  args?: Record<string, unknown>
}

// `text` is the terse default output, `data` the `--json` payload, `error` the reason for a non-zero exit.
export interface CollabResult {
  exit: ExitCode
  text?: string
  data?: unknown
  error?: string
}

export interface CollabOptions {
  store: Store
  jobs: JobEngine
  messages: MessageBus
  now?: () => number
  // True while a spending cap pauses the operator (step 8's CapMonitor.isPaused); claims are refused.
  capPaused?: (operatorId: number) => boolean
  // Unexpected errors; the caller sees only "internal error".
  onError?: (err: unknown) => void
}

type Args = Record<string, unknown>
type Handler = (who: Identity, args: Args, signal?: AbortSignal) => CollabResult | Promise<CollabResult>

class UsageError extends Error {}
class CapError extends Error {}

const LIST_MAX = 50
// Concurrent `inbox --wait` calls per operator; more are answered at once with the current digest.
const WAITS_MAX = 2

// Argument checks. The CLI parses argv, but the request arrives over a socket, so every value is
// validated again here.
function id(v: unknown, name = 'Job id'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new UsageError(`${name} must be a positive whole number`)
  return v
}
function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`${name} is required`)
  return v
}
function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new UsageError(`${name} must be text`)
  return v
}
function optBool(v: unknown, name: string): boolean {
  if (v === undefined) return false
  if (typeof v !== 'boolean') throw new UsageError(`--${name} takes no value`)
  return v
}
function optInt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new UsageError(`--${name} must be a whole number`)
  return v
}
function optIds(v: unknown, name: string): number[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length === 0) throw new UsageError(`--${name} needs job ids`)
  return v.map((x) => id(x, `--${name}`))
}

// Unicode line separators are built from code points so no raw separator sits in the source.
const SEPARATORS = String.fromCharCode(0x85, 0x2028, 0x2029)
const BREAKS = new RegExp(String.raw`[\u0000-\u001f\u007f${SEPARATORS}]+`, 'g')
const LINE_BREAK = new RegExp(String.raw`\r\n|[\r\n\v\f${SEPARATORS}]`)

// One line of agent-written text: no line breaks or control characters.
const oneLine = (s: string): string => s.replace(BREAKS, ' ').replace(/\s+/g, ' ').trim()
// Indented so no line of agent text can pass as a header.
const block = (s: string): string =>
  s
    .split(LINE_BREAK)
    .map((l) => `  ${l.replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '')}`)
    .join('\n')

// The agent-facing command channel: one function per `operant` command, with the caller's identity
// from its token. Rules live in the job and message engines; this maps them to exit codes and output.
export class Collab {
  private readonly store: Store
  private readonly jobs: JobEngine
  private readonly messages: MessageBus
  private readonly now: () => number
  private readonly capPaused: (operatorId: number) => boolean
  private readonly onError: (err: unknown) => void
  private readonly commands: Record<string, { keys: string[]; run: Handler }>
  private readonly waits = new Map<number, number>()

  constructor(opts: CollabOptions) {
    this.store = opts.store
    this.jobs = opts.jobs
    this.messages = opts.messages
    this.now = opts.now ?? Date.now
    this.capPaused = opts.capPaused ?? (() => false)
    this.onError = opts.onError ?? (() => {})
    this.commands = {
      whoami: { keys: [], run: (w) => this.whoami(w) },
      who: { keys: ['squad'], run: (w, a) => this.who(w, a) },
      msg: { keys: ['to', 'text', 'job'], run: (w, a) => this.msg(w, a) },
      ask: { keys: ['to', 'text', 'job'], run: (w, a) => this.ask(w, a) },
      inbox: { keys: ['peek', 'wait'], run: (w, a, s) => this.inbox(w, a, s) },
      'job.list': { keys: ['open'], run: (w, a) => this.jobList(w, a) },
      'job.show': { keys: ['id'], run: (w, a) => this.jobShow(w, a) },
      'job.add': { keys: ['title', 'body', 'for', 'after', 'review', 'priority', 'estimate'], run: (w, a) => this.jobAdd(w, a) },
      'job.claim': { keys: ['id'], run: (w, a) => this.jobClaim(w, a) },
      'job.done': { keys: ['id', 'note'], run: (w, a) => this.jobDone(w, a) },
      'job.release': { keys: ['id', 'note'], run: (w, a) => this.jobRelease(w, a) },
      'job.handoff': { keys: ['id', 'to', 'note'], run: (w, a) => this.jobHandoff(w, a) },
      'job.approve': { keys: ['id', 'note'], run: (w, a) => this.jobApprove(w, a) },
      'job.reject': { keys: ['id', 'reason'], run: (w, a) => this.jobReject(w, a) },
      'job.escalate': { keys: ['id', 'reason'], run: (w, a) => this.jobEscalate(w, a) },
      'job.edit': {
        keys: ['id', 'title', 'body', 'priority', 'estimate', 'review', 'note', 'for', 'after', 'notAfter'],
        run: (w, a) => this.jobEdit(w, a),
      },
    }
  }

  // The identity for a token's operator, or null when it is gone (deleted operators are refused).
  identify(operatorId: number): Identity | null {
    const op = this.store.getOperator(operatorId)
    if (!op) return null
    return { kind: op.kind === 'master' ? 'master' : 'operator', operatorId: op.id }
  }

  // One CLI request: re-checks the identity, renews the caller's leases, runs the command and maps
  // engine errors to exit codes. `signal` aborts a waiting `inbox --wait` when the client disconnects.
  async run(who: Identity, req: CollabRequest, signal?: AbortSignal): Promise<CollabResult> {
    try {
      const current = this.identify(who.operatorId)
      if (!current || current.kind !== who.kind) return { exit: EXIT.FORBIDDEN, error: 'forbidden' }
      try {
        this.jobs.touch(who.operatorId)
      } catch {
        // A busy database only delays the lease renewal; the command itself reports any real problem.
      }
      const cmd = typeof req?.cmd === 'string' ? Object.hasOwn(this.commands, req.cmd) && this.commands[req.cmd] : undefined
      if (!cmd) throw new UsageError(`Unknown command "${typeof req?.cmd === 'string' ? oneLine(req.cmd).slice(0, 40) : ''}"`)
      const args = req.args ?? {}
      if (typeof args !== 'object' || Array.isArray(args)) throw new UsageError('Bad arguments')
      for (const k of Object.keys(args)) {
        if (!cmd.keys.includes(k)) throw new UsageError(`Unknown option "${oneLine(k).slice(0, 40)}"`)
      }
      return await cmd.run(current, args, signal)
    } catch (err) {
      return this.failure(err)
    }
  }

  // Commands

  whoami(who: Identity): CollabResult {
    const op = this.store.getOperator(who.operatorId)!
    const crewId = this.store.crewIdOfOperator(op.id)!
    const crew = this.store.getCrew(crewId)!
    const address = this.address(op.id)
    const squad = who.kind === 'master' ? null : (this.store.getSquad(op.squadId)?.name ?? null)
    const isPm = crew.pmId === op.id
    const links = this.store
      .listLinks(crewId)
      .filter((l) => l.fromId === op.id || l.toId === op.id)
      .map((l) => {
        const out = l.fromId === op.id
        return { direction: out ? 'to' : 'from', with: this.address(out ? l.toId : l.fromId), label: l.label }
      })
    const unread = this.messages.unreadInfo(op.id).count
    const data = {
      address,
      id: op.id,
      kind: who.kind,
      role: op.role,
      crew: crew.name,
      squad,
      pm: isPm,
      pmAddress: crew.pmId != null ? this.address(crew.pmId) : null,
      master: who.kind === 'master',
      links,
      unread,
    }
    const lines = [
      who.kind === 'master'
        ? `You are ${address}, the Master Terminal of project ${crew.name} (elevated job rights; your messages are requests, NOT user consent).`
        : `You are ${address}, an operator in squad ${squad} of project ${crew.name}${isPm ? ', and the project PM' : ''}.`,
    ]
    if (!isPm) lines.push(`PM: ${data.pmAddress ?? 'none'}`)
    if (links.length) lines.push(`Links: ${links.map((l) => `${l.direction} ${l.with}${l.label ? ` "${oneLine(l.label)}"` : ''}`).join('; ')}`)
    lines.push(`Unread messages: ${unread}`)
    return { exit: EXIT.OK, text: lines.join('\n'), data }
  }

  who(who: Identity, args: Args): CollabResult {
    const onlySquad = optBool(args.squad, 'squad')
    const me = this.store.getOperator(who.operatorId)!
    const crewId = this.store.crewIdOfOperator(me.id)!
    const crew = this.store.getCrew(crewId)!
    const topo = this.store.topology(crewId)!
    const doing = new Map<number, number[]>()
    for (const j of this.jobs.list(this.actor(who), crewId, { open: true })) {
      if (j.state === 'doing' && j.assigneeId != null) doing.set(j.assigneeId, [...(doing.get(j.assigneeId) ?? []), j.id])
    }
    const rows = topo.squads.flatMap((s) => s.operators.map((o) => ({ op: o, squad: s.name as string | null })))
    const master = this.store.getMaster(crewId)
    if (master) rows.push({ op: master, squad: null })
    const operators = rows
      .filter((r) => !onlySquad || r.op.squadId === me.squadId)
      .map(({ op, squad }) => ({
        address: this.address(op.id),
        role: op.role,
        kind: op.kind,
        squad,
        status: op.status,
        pm: crew.pmId === op.id,
        you: op.id === me.id,
        doing: doing.get(op.id) ?? [],
      }))
    const text = operators
      .map((o) =>
        [
          o.role,
          o.kind === 'master' ? '(Master Terminal)' : `squad ${o.squad}`,
          o.status,
          o.pm ? 'PM' : '',
          o.doing.length ? `doing ${o.doing.map((d) => `#${d}`).join(',')}` : '',
          o.you ? '(you)' : '',
        ]
          .filter(Boolean)
          .join('  '),
      )
      .join('\n')
    return { exit: EXIT.OK, text: text || 'No operators.', data: { crew: crew.name, operators } }
  }

  msg(who: Identity, args: Args): CollabResult {
    const to = str(args.to, 'Recipient')
    const text = str(args.text, 'Message text')
    const jobId = args.job === undefined ? undefined : id(args.job, '--job')
    const r = this.messages.send(this.sender(who), to, text, { jobId })
    const data = { ids: r.ids, duplicate: r.duplicate }
    if (r.duplicate) return { exit: EXIT.OK, text: `Already sent as message ${r.ids.join(', ')}; not sent again.`, data }
    const target = r.messages.length === 1 ? r.messages[0]!.toLabel || to : `${r.messages.length} recipients`
    return { exit: EXIT.OK, text: `Sent message ${r.messages.map((m) => m.id).join(', ')} to ${oneLine(target)}.`, data }
  }

  ask(who: Identity, args: Args): CollabResult {
    if (args.to !== 'user') throw new UsageError('Usage: operant ask user <text>')
    const text = str(args.text, 'Request text')
    const jobId = args.job === undefined ? undefined : id(args.job, '--job')
    const r = this.messages.ask(this.sender(who), text, { jobId })
    const data = { ids: r.ids, duplicate: r.duplicate }
    if (r.duplicate) return { exit: EXIT.OK, text: `Already asked as message ${r.id}; not sent again.`, data }
    return { exit: EXIT.OK, text: `Sent consent request ${r.id} to the user. The answer arrives in your inbox.`, data }
  }

  async inbox(who: Identity, args: Args, signal?: AbortSignal): Promise<CollabResult> {
    const peek = optBool(args.peek, 'peek')
    let r: InboxResult
    if (args.wait === undefined) r = this.messages.inbox(who.operatorId, { peek })
    else {
      if (typeof args.wait !== 'number' || !Number.isFinite(args.wait) || args.wait < 0) throw new UsageError('--wait must be a number of seconds')
      const seconds = Math.min(args.wait, this.messages.limits.waitMaxSeconds)
      r = await this.waitInbox(who.operatorId, peek, seconds, signal)
    }
    const messages = r.messages.map((m) => ({
      id: m.id,
      from: isSystemMessage(m) ? 'Operant' : m.fromKind === 'user' ? 'user' : m.fromLabel,
      fromKind: isSystemMessage(m) ? 'operant' : m.fromKind,
      kind: m.kind,
      jobId: m.jobId,
      at: m.createdAt,
      body: m.body,
    }))
    return { exit: EXIT.OK, text: r.digest, data: { count: r.count, messages } }
  }

  jobList(who: Identity, args: Args): CollabResult {
    const open = optBool(args.open, 'open')
    const all = this.jobs.list(this.actor(who), this.crewOf(who), { open })
    const shown = all.slice(-LIST_MAX)
    const lines = shown.map((j) => this.jobLine(j))
    if (all.length > shown.length) lines.unshift(`(${all.length - shown.length} older jobs not shown${open ? '' : '; try --open'})`)
    return {
      exit: EXIT.OK,
      text: lines.length ? lines.join('\n') : open ? 'No open jobs.' : 'No jobs.',
      data: { total: all.length, jobs: shown.map((j) => this.jobJson(j, false)) },
    }
  }

  jobShow(who: Identity, args: Args): CollabResult {
    const job = this.jobs.get(this.actor(who), id(args.id))
    const deps = job.deps.map((d) => {
      try {
        return `${d} (${this.jobs.get(this.actor(who), d).state})`
      } catch {
        return `${d}`
      }
    })
    const facts = [
      `state ${job.state}${job.blocked ? ' (blocked)' : ''}`,
      `assignee ${this.addrOf(job.assigneeId)}`,
      `created by ${job.createdBy == null ? 'the user' : this.addrOf(job.createdBy)}`,
      `priority ${job.priority}`,
      `review ${this.reviewText(job)}`,
    ]
    if (job.estimateMinutes != null) facts.push(`estimate ${job.estimateMinutes} min`)
    if (job.rejects) facts.push(`rejects ${job.rejects}`)
    const lines = [`job ${job.id} "${oneLine(job.title)}"`, facts.join(', ')]
    if (deps.length) lines.push(`waits for: ${deps.join(', ')}`)
    if (job.escalation) lines.push(`escalation: ${oneLine(job.escalation)}`)
    if (job.body) lines.push('body:', block(job.body))
    if (job.note) lines.push('note:', block(job.note))
    return { exit: EXIT.OK, text: lines.join('\n'), data: this.jobJson(job, true) }
  }

  jobAdd(who: Identity, args: Args): CollabResult {
    const crewId = this.crewOf(who)
    const title = str(args.title, 'Title')
    const body = optStr(args.body, '--body')
    const forAddr = optStr(args.for, '--for')
    const review = optStr(args.review, '--review')
    const r = review === undefined ? {} : this.reviewArg(who, review)
    const job = this.jobs.create(this.actor(who), {
      crewId,
      title,
      body,
      priority: optInt(args.priority, 'priority'),
      estimateMinutes: optInt(args.estimate, 'estimate'),
      for: forAddr === undefined ? undefined : this.resolve(who, forAddr),
      deps: optIds(args.after, 'after'),
      ...r,
    })
    return this.jobResult('Added', job)
  }

  jobClaim(who: Identity, args: Args): CollabResult {
    const jobId = args.id === undefined ? undefined : id(args.id)
    if (this.capPaused(who.operatorId)) throw new CapError('Spending cap reached: you are paused and cannot claim jobs until the user raises the cap.')
    return this.jobResult('Claimed', this.jobs.claim(this.actor(who), jobId))
  }

  jobDone(who: Identity, args: Args): CollabResult {
    return this.jobResult('Finished', this.jobs.done(this.actor(who), id(args.id), optStr(args.note, '--note')))
  }

  jobRelease(who: Identity, args: Args): CollabResult {
    return this.jobResult('Released', this.jobs.release(this.actor(who), id(args.id), optStr(args.note, '--note')))
  }

  jobHandoff(who: Identity, args: Args): CollabResult {
    const jobId = id(args.id)
    const to = this.resolve(who, str(args.to, 'Handoff target'))
    return this.jobResult('Handed off', this.jobs.handoff(this.actor(who), jobId, to, optStr(args.note, '--note')))
  }

  jobApprove(who: Identity, args: Args): CollabResult {
    return this.jobResult('Approved', this.jobs.approve(this.actor(who), id(args.id), optStr(args.note, '--note')))
  }

  jobReject(who: Identity, args: Args): CollabResult {
    const jobId = id(args.id)
    return this.jobResult('Rejected', this.jobs.reject(this.actor(who), jobId, str(args.reason, '--reason')))
  }

  jobEscalate(who: Identity, args: Args): CollabResult {
    const jobId = id(args.id)
    return this.jobResult('Escalated', this.jobs.escalate(this.actor(who), jobId, str(args.reason, '--reason')))
  }

  // Field edits, then reassignment (`--for`, PM and master), then dependencies. Each step is its own
  // engine transaction, checked in that order.
  jobEdit(who: Identity, args: Args): CollabResult {
    const jobId = id(args.id)
    const actor = this.actor(who)
    const patch: JobEdit = {}
    if (args.title !== undefined) patch.title = str(args.title, '--title')
    if (args.body !== undefined) patch.body = optStr(args.body, '--body')
    if (args.note !== undefined) patch.note = optStr(args.note, '--note')
    if (args.priority !== undefined) patch.priority = optInt(args.priority, 'priority')
    if (args.estimate !== undefined) patch.estimateMinutes = args.estimate === null ? null : optInt(args.estimate, 'estimate')
    if (args.review !== undefined) Object.assign(patch, this.reviewArg(who, str(args.review, '--review')))
    let assignee: number | null | undefined
    if (args.for !== undefined) assignee = args.for === null ? null : this.resolve(who, str(args.for, '--for'))
    const add = optIds(args.after, 'after') ?? []
    const remove = optIds(args.notAfter, 'not-after') ?? []
    if (Object.keys(patch).length === 0 && assignee === undefined && add.length === 0 && remove.length === 0) {
      throw new UsageError('Nothing to change')
    }
    let job = Object.keys(patch).length ? this.jobs.edit(actor, jobId, patch) : this.jobs.get(actor, jobId)
    if (assignee !== undefined) job = this.jobs.reassign(actor, jobId, assignee)
    for (const d of add) job = this.jobs.addDep(actor, jobId, d)
    for (const d of remove) job = this.jobs.removeDep(actor, jobId, d)
    return this.jobResult('Edited', job)
  }

  // Internals

  // Waits on peeked results and reads (marks read) only while the client is still there, so a client
  // that disconnects never swallows messages. A wait resolved early by someone else's cancel waits again.
  private async waitInbox(operatorId: number, peek: boolean, seconds: number, signal?: AbortSignal): Promise<InboxResult> {
    const empty: InboxResult = { digest: formatDigest([]), messages: [], count: 0 }
    if (signal?.aborted) return empty
    const waiting = this.waits.get(operatorId) ?? 0
    if (waiting >= WAITS_MAX) return this.messages.inbox(operatorId, { peek })
    this.waits.set(operatorId, waiting + 1)
    const deadline = this.now() + seconds * 1000
    const cancel = () => this.messages.cancelWaits(operatorId)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      for (;;) {
        const r = await this.messages.inboxWait(operatorId, { peek: true, waitSeconds: Math.max(0, (deadline - this.now()) / 1000) })
        if (signal?.aborted) return empty
        if (r.count > 0 || this.now() >= deadline) return this.messages.inbox(operatorId, { peek })
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
      const left = (this.waits.get(operatorId) ?? 1) - 1
      if (left > 0) this.waits.set(operatorId, left)
      else this.waits.delete(operatorId)
    }
  }

  private failure(err: unknown): CollabResult {
    if (err instanceof UsageError) return { exit: EXIT.USAGE, error: err.message }
    if (err instanceof CapError) return { exit: EXIT.LIMITED, error: err.message }
    if (err instanceof JobError) {
      const exit = { NOT_FOUND: EXIT.NOT_FOUND, CONFLICT: EXIT.CONFLICT, FORBIDDEN: EXIT.FORBIDDEN, BAD_ARGS: EXIT.USAGE }[err.code]
      return { exit, error: err.message }
    }
    if (err instanceof MessageError) {
      const exit = {
        NOT_FOUND: EXIT.NOT_FOUND,
        BAD_ARGS: EXIT.USAGE,
        FORBIDDEN: EXIT.FORBIDDEN,
        RATE_LIMITED: EXIT.LIMITED,
        INBOX_FULL: EXIT.LIMITED,
      }[err.code]
      return { exit, error: err.message }
    }
    this.onError(err)
    return { exit: EXIT.ERROR, error: 'internal error' }
  }

  private actor(who: Identity): JobActor {
    return { kind: who.kind, id: who.operatorId }
  }

  private sender(who: Identity): Actor {
    return { kind: who.kind, operatorId: who.operatorId }
  }

  private crewOf(who: Identity): number {
    return this.store.crewIdOfOperator(who.operatorId)!
  }

  private address(operatorId: number): string {
    return this.store.operatorAddress(operatorId, true) ?? `operator ${operatorId}`
  }

  private addrOf(operatorId: number | null): string {
    return operatorId == null ? 'nobody' : this.address(operatorId)
  }

  private role(operatorId: number | null): string {
    if (operatorId == null) return '-'
    const a = this.address(operatorId)
    const at = a.lastIndexOf('@')
    return at > 0 ? a.slice(0, at) : a
  }

  // `role`, `role@crew`, `pm` or `master` to a live operator of the caller's crew.
  private resolve(who: Identity, addr: string): number {
    const crewId = this.crewOf(who)
    const crew = this.store.getCrew(crewId)!
    let role = addr.trim()
    const at = role.indexOf('@')
    if (at >= 0) {
      if (role.slice(at + 1) !== crew.name) throw new JobError('NOT_FOUND', `No operator "${oneLine(addr).slice(0, 80)}" in this project`)
      role = role.slice(0, at)
    }
    if (role === 'pm') {
      if (crew.pmId == null) throw new JobError('NOT_FOUND', 'This project has no PM')
      return crew.pmId
    }
    const row = this.store.db
      .prepare(
        `SELECT o.id FROM operators o JOIN squads q ON q.id = o.squad_id
         WHERE q.crew_id = ? AND o.role = ? AND o.deleted_at IS NULL AND q.deleted_at IS NULL`,
      )
      .get(crewId, role) as { id: number } | undefined
    if (!row) throw new JobError('NOT_FOUND', `No operator "${oneLine(addr).slice(0, 80)}" in this project`)
    return Number(row.id)
  }

  // `--review none|pm|user|<address>`; an address means that operator reviews.
  private reviewArg(who: Identity, v: string): { review: JobReview; reviewerId?: number | null } {
    if (v === 'none' || v === 'pm' || v === 'user') return { review: v, reviewerId: null }
    return { review: 'operator', reviewerId: this.resolve(who, v) }
  }

  private reviewText(j: JobRecord): string {
    return j.review === 'operator' ? `by ${this.addrOf(j.reviewerId)}` : j.review
  }

  private jobLine(j: JobRecord): string {
    const extra: string[] = []
    if (j.priority) extra.push(`p${j.priority}`)
    if (j.estimateMinutes != null) extra.push(`est ${j.estimateMinutes}m`)
    if (j.review !== 'none') extra.push(`review ${j.review === 'operator' ? this.role(j.reviewerId) : j.review}`)
    if (j.blocked) extra.push(`waits ${j.deps.join(',')}`)
    if (j.escalation) extra.push(`escalated: ${oneLine(j.escalation)}`)
    return `#${j.id} ${j.state} ${this.role(j.assigneeId)} "${oneLine(j.title)}"${extra.length ? ` (${extra.join(', ')})` : ''}`
  }

  private jobJson(j: JobRecord, full: boolean) {
    return {
      id: j.id,
      title: j.title,
      state: j.state,
      blocked: j.blocked,
      assignee: j.assigneeId == null ? null : this.address(j.assigneeId),
      priority: j.priority,
      review: j.review,
      reviewer: j.reviewerId == null ? null : this.address(j.reviewerId),
      estimateMinutes: j.estimateMinutes,
      escalation: j.escalation,
      deps: j.deps,
      ...(full
        ? {
            body: j.body,
            note: j.note,
            createdBy: j.createdBy == null ? 'user' : this.address(j.createdBy),
            rejects: j.rejects,
            startedAt: j.startedAt,
            leaseUntil: j.leaseUntil,
          }
        : {}),
    }
  }

  private jobResult(verb: string, j: JobRecord): CollabResult {
    return { exit: EXIT.OK, text: `${verb}: ${this.jobLine(j)}`, data: this.jobJson(j, true) }
  }
}
