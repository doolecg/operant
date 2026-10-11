import { randomUUID } from 'node:crypto'
import type { BrowserConfirm, BrowserConfirmEnd } from '../../shared/browser'

export const CONFIRM_TIMEOUT_MS = 5 * 60_000

export interface ConfirmBrokerOptions {
  timeoutMs?: number
  newId?: () => string
}

const grantKey = (crewId: number, tileId: number): string => `${crewId}:${tileId}`

interface Entry {
  req: BrowserConfirm
  settle: (outcome: BrowserConfirmEnd['outcome']) => void
}

// Holds the approvals the AI is waiting for. request() resolves true only when the user allows it; a "no", the
// timeout (5 minutes) and a cancelled call all resolve false. "Allow all" is a grant for one project and AI tile that
// lets its later requests through unasked; it lives in memory until revoked. No Electron: the host pushes the events.
export class ConfirmBroker {
  private readonly entries = new Map<string, Entry>()
  private readonly requestListeners = new Set<(c: BrowserConfirm) => void>()
  private readonly endListeners = new Set<(e: BrowserConfirmEnd) => void>()
  private readonly grants = new Set<string>()
  private readonly grantListeners = new Set<(crewId: number, active: boolean) => void>()
  private readonly timeoutMs: number
  private readonly newId: () => string

  constructor(opts: ConfirmBrokerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? CONFIRM_TIMEOUT_MS
    this.newId = opts.newId ?? randomUUID
  }

  onRequest(cb: (c: BrowserConfirm) => void): () => void {
    this.requestListeners.add(cb)
    return () => this.requestListeners.delete(cb)
  }

  onEnd(cb: (e: BrowserConfirmEnd) => void): () => void {
    this.endListeners.add(cb)
    return () => this.endListeners.delete(cb)
  }

  // Fires when a project gains its first allow-all grant or loses its last one.
  onGrants(cb: (crewId: number, active: boolean) => void): () => void {
    this.grantListeners.add(cb)
    return () => this.grantListeners.delete(cb)
  }

  allowAllActive(crewId: number): boolean {
    return [...this.grants].some((g) => g.startsWith(`${crewId}:`))
  }

  pending(crewId: number): BrowserConfirm[] {
    return [...this.entries.values()].map((e) => e.req).filter((r) => r.crewId === crewId)
  }

  request(info: { crewId: number; tileId: number; tool: string; summary: string }, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (this.grants.has(grantKey(info.crewId, info.tileId))) return Promise.resolve(true)
    const req: BrowserConfirm = { id: this.newId(), ...info }
    return new Promise<boolean>((resolve) => {
      const finish = (outcome: BrowserConfirmEnd['outcome']): void => {
        if (!this.entries.delete(req.id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        for (const cb of this.endListeners) cb({ id: req.id, crewId: req.crewId, outcome })
        resolve(outcome === 'allowed')
      }
      const onAbort = (): void => finish('cancelled')
      const timer = setTimeout(() => finish('timeout'), this.timeoutMs)
      timer.unref?.()
      signal.addEventListener('abort', onAbort, { once: true })
      this.entries.set(req.id, { req, settle: finish })
      for (const cb of this.requestListeners) cb(req)
    })
  }

  // The user's answer. False when the id is unknown (already answered, timed out or cancelled). With all, it also
  // grants allow-all for that project and tile and lets its other waiting requests through.
  answer(id: string, allow: boolean, all = false): boolean {
    const e = this.entries.get(id)
    if (!e) return false
    if (allow && all) this.grant(e.req.crewId, e.req.tileId)
    e.settle(allow ? 'allowed' : 'denied')
    return true
  }

  private grant(crewId: number, tileId: number): void {
    const was = this.allowAllActive(crewId)
    this.grants.add(grantKey(crewId, tileId))
    for (const o of [...this.entries.values()]) if (o.req.crewId === crewId && o.req.tileId === tileId) o.settle('allowed')
    if (!was) for (const cb of this.grantListeners) cb(crewId, true)
  }

  // Ends allow-all for a project (the user pressed Stop, took control, or the setting changed).
  revokeCrew(crewId: number): void {
    this.revoke((g) => g.startsWith(`${crewId}:`))
  }

  // Ends allow-all for an AI tile (its MCP session ended).
  revokeTile(tileId: number): void {
    this.revoke((g) => g.endsWith(`:${tileId}`))
  }

  revokeAll(): void {
    this.revoke(() => true)
  }

  private revoke(match: (key: string) => boolean): void {
    const crews = new Set<number>()
    for (const g of [...this.grants]) {
      if (!match(g)) continue
      this.grants.delete(g)
      crews.add(Number(g.split(':')[0]))
    }
    for (const crewId of crews) if (!this.allowAllActive(crewId)) for (const cb of this.grantListeners) cb(crewId, false)
  }

  cancelCrew(crewId: number): void {
    this.revokeCrew(crewId)
    for (const e of [...this.entries.values()]) if (e.req.crewId === crewId) e.settle('cancelled')
  }

  dispose(): void {
    this.revokeAll()
    for (const e of [...this.entries.values()]) e.settle('cancelled')
    this.requestListeners.clear()
    this.endListeners.clear()
    this.grantListeners.clear()
  }
}
