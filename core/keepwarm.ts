import { decidePing, keepWarmSummary, type KeepWarmCommand, type KeepWarmView } from '../shared/keepwarm'

// One tile's keep-warm: off until the owner says /keepwarm, never resumed by itself after a restart. A single one-shot
// timer is armed for the next ping (no polling); every ping goes through the tile's own chat path and the aux budget.

const MAX_TIMER_MS = 2_000_000_000
const ERROR_LIMIT = 2

export interface KeepWarmPersisted {
  active: boolean
  always: boolean
  endsAt: number | null
  stopped: string | null
}

export interface KeepWarmDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  // The prompt cache lifetime of the tile (5 minutes unless its settings ask for 1 hour).
  ttlMs: () => number
  // A turn runs or a prompt waits.
  isBusy: () => boolean
  // The process is up (a ping never starts one).
  isRunning: () => boolean
  // Sends the ping message through the normal chat path; false when it could not be written.
  sendPing: () => boolean
  // Why the daily limits forbid another call (null: allowed).
  budgetBlocked: () => string | null
  recordUsage: (u: { tokens: number; usd: number }) => void
  emit: (view: KeepWarmView | null) => void
  notice: (text: string, tone: 'info' | 'warn') => void
  load: () => KeepWarmPersisted | null
  save: (p: KeepWarmPersisted | null) => void
}

export interface PingOutcome {
  ok: boolean
  cacheRead: number
  tokens: number
  usd: number | null
}

export class KeepWarm {
  private active = false
  private always = false
  private endsAt: number | null = null
  private stopped: string | null = null
  private lastActivity: number | null = null
  private lastPingAt: number | null = null
  private nextPingAt: number | null = null
  private pings = 0
  private lastPing: KeepWarmView['lastPing'] = null
  private errors = 0
  private timer: unknown = null
  private inFlight = false
  private touched = false

  constructor(private readonly d: KeepWarmDeps) {
    // A saved "on" means the app ended while it ran: it shows as stopped by the restart, and does not start again.
    const saved = d.load()
    if (saved?.active) {
      this.stopped = 'Stopped by restart'
      this.touched = true
      d.save({ active: false, always: saved.always, endsAt: saved.endsAt, stopped: this.stopped })
    } else if (saved?.stopped) {
      this.stopped = saved.stopped
      this.touched = true
    }
  }

  get isActive(): boolean {
    return this.active
  }

  view(): KeepWarmView | null {
    if (!this.touched) return null
    return {
      active: this.active,
      always: this.always,
      endsAt: this.endsAt,
      ttlMs: this.d.ttlMs(),
      lastActivityAt: this.lastActivity,
      nextPingAt: this.active ? this.nextPingAt : null,
      pings: this.pings,
      lastPing: this.lastPing,
      stopped: this.active ? null : this.stopped,
    }
  }

  private publish(): void {
    this.d.emit(this.view())
  }

  private persist(): void {
    this.d.save({ active: this.active, always: this.always, endsAt: this.endsAt, stopped: this.stopped })
  }

  private clearTimer(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer)
    this.timer = null
  }

  // The owner's command; the answer goes out as a notice.
  command(cmd: KeepWarmCommand): void {
    const now = this.d.now()
    if (cmd.kind === 'invalid') return this.d.notice(cmd.error, 'warn')
    if (cmd.kind === 'status') return this.d.notice(keepWarmSummary(this.view(), now), 'info')
    if (cmd.kind === 'off') {
      const was = this.active
      this.stop(null, was ? 'Keep-warm is off.' : 'Keep-warm was already off.')
      return
    }
    this.active = true
    this.touched = true
    this.always = cmd.ms === null
    this.endsAt = cmd.ms === null ? null : now + cmd.ms
    this.stopped = null
    this.errors = 0
    this.lastPingAt = null
    this.persist()
    this.d.notice(
      keepWarmSummary({ ...this.view()!, active: true }, now) +
        ' It sends one tiny message shortly before the cache expires (each costs a small cache read) and only while Claude is idle. /keepwarm off stops it.',
      'info',
    )
    this.reschedule()
  }

  // Stops pinging. `reason` null is the owner's own /keepwarm off; otherwise it is shown as why it stopped.
  stop(reason: string | null, message?: string): void {
    const wasActive = this.active
    this.clearTimer()
    this.active = false
    this.nextPingAt = null
    this.inFlight = false
    this.stopped = reason
    this.touched = true
    this.persist()
    if (message) this.d.notice(message, 'info')
    else if (wasActive && reason) this.d.notice(`Keep-warm stopped: ${reason.toLowerCase()}.`, 'warn')
    this.publish()
  }

  // The process ended or the tile closed: nothing to keep warm. The saved "on" stays, so an app restart reads as one.
  halt(reason: string): void {
    if (!this.active) return
    this.clearTimer()
    this.active = false
    this.nextPingAt = null
    this.inFlight = false
    this.stopped = reason
    this.d.notice(`Keep-warm stopped: ${reason.toLowerCase()}.`, 'warn')
    this.publish()
  }

  dispose(): void {
    this.clearTimer()
    this.active = false
    this.d.save(null)
  }

  // A turn of the owner (or any API call) ended: the cache is fresh from now on.
  noteActivity(at: number): void {
    this.lastActivity = at
    if (this.active) this.reschedule()
    else if (this.touched) this.publish()
  }

  // The ping's result.
  onPingResult(r: PingOutcome): void {
    const now = this.d.now()
    this.inFlight = false
    this.pings++
    this.lastPing = { at: now, cacheRead: r.cacheRead, usd: r.usd, ok: r.ok }
    this.d.recordUsage({ tokens: r.tokens, usd: r.usd ?? 0 })
    if (r.ok) {
      this.errors = 0
      this.lastActivity = now
    } else if (++this.errors >= ERROR_LIMIT) return this.stop('Two pings failed in a row')
    this.reschedule()
  }

  // Looks at the clock and arms the timer for the next ping (or pings now).
  reschedule(): void {
    this.clearTimer()
    if (!this.active) return
    const now = this.d.now()
    const dec = decidePing({ now, lastActivity: this.lastActivity, lastPingAt: this.lastPingAt, ttlMs: this.d.ttlMs(), busy: this.d.isBusy() || this.inFlight, endsAt: this.endsAt })
    if (dec.action === 'stop') return this.stop('The keep-warm window ended')
    if (dec.action === 'send') return this.ping()
    this.nextPingAt = dec.reason === 'not-due' ? dec.at : null
    this.publish()
    if (dec.at !== null) this.timer = this.d.setTimer(() => this.reschedule(), Math.min(MAX_TIMER_MS, Math.max(1000, dec.at - now)))
  }

  private ping(): void {
    const blocked = this.d.budgetBlocked()
    if (blocked) return this.stop(`Operant's budget: ${blocked}`)
    if (!this.d.isRunning()) return this.halt('The tile is closed')
    this.lastPingAt = this.d.now()
    this.inFlight = true
    if (!this.d.sendPing()) {
      this.inFlight = false
      if (++this.errors >= ERROR_LIMIT) return this.stop('Two pings failed in a row')
      return this.reschedule()
    }
    this.nextPingAt = null
    this.publish()
  }
}
