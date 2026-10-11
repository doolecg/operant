import type { BrowserActionStatus } from '../../shared/browser'
import type { BrowserHub } from './hub'
import { carriesPageText, wrapUntrusted } from './untrusted'

// Loose JSON-RPC shapes: the gate sits on the wire and must not depend on the MCP SDK types.
export interface RpcMessage {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: unknown
}

export interface GateTransport {
  onmessage?: ((message: never, extra?: never) => void) | undefined
  send(message: never, options?: never): Promise<void>
}

export interface GateContext {
  crewId: number
  tileId: number
}

// A tool the host adds next to the Playwright ones (tools/list is appended, calls are answered here). It goes
// through the same pause, approval and "browser opened" steps as a Playwright tool unless `ungated` is set.
export interface ExtraTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // Reads host state only: answered at once, even while the user has control.
  ungated?: boolean
  run(ctx: GateContext, args: Record<string, unknown>, signal: AbortSignal): Promise<string> | string
}

// An error whose message is safe to show the AI (no endpoint, token or cookie in it). Any other error from a tool
// is answered with a fixed text, because Playwright errors can carry the proxy URL.
export class ExtraError extends Error {}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  crewId: number
  tileId: number
}

export interface GateOptions extends GateContext {
  hub: Pick<BrowserHub, 'isPaused' | 'pauseEpoch' | 'waitUntilResumed' | 'aiBegin' | 'aiEnd' | 'actionBegin' | 'actionEnd'>
  // How long a call waits while the user has control before it is answered with USER_HAS_CONTROL.
  pauseTimeoutMs?: number
  extras?: readonly ExtraTool[]
  // Autonomy: 'confirm' asks `confirm` first; a "no" (or no answer) answers with REFUSED.
  policy?: (call: ToolCall) => 'allow' | 'confirm'
  confirm?: (call: ToolCall, signal: AbortSignal) => Promise<boolean>
  // Runs once the call may proceed (the host reopens a closed browser here).
  beforeCall?: () => Promise<void>
  // Sees the text of every successful tool result before it is fenced (the host learns element refs from snapshots).
  // It must not log the text: it can hold page content.
  onResult?: (crewId: number, tool: string, text: string) => void
}

export const USER_HAS_CONTROL =
  'The user has taken control of the browser. Do not act on the page. Wait for them to hand back control, or ask them.'
export const INTERRUPTED =
  'Interrupted: the user took control during this action; it may not have completed. Take a new snapshot after control returns.'
export const REFUSED = 'The user did not allow this browser action.'
export const CLOSE_DISABLED = 'browser_close is disabled: the browser panel stays open for the user.'

// Playwright tools the AI must not use: the panel belongs to the user and outlives the AI's task.
const HIDDEN = new Set(['browser_close'])

const PAUSE_TIMEOUT_MS = 60_000

type EndStatus = Exclude<BrowserActionStatus, 'running'>

const textResult = (text: string): Record<string, unknown> => ({ content: [{ type: 'text', text }] })

// The tool name plus a short, non-secret target. Typed text, form values and URL paths or queries never get in.
export function describeCall(name: string, args: Record<string, unknown> | undefined): string {
  let target = ''
  const a = args ?? {}
  if (typeof a.url === 'string') {
    try {
      target = new URL(a.url).host
    } catch {
      target = ''
    }
  } else if (typeof a.element === 'string') target = a.element
  else if (typeof a.target === 'string') target = a.target
  else if (typeof a.ref === 'string') target = a.ref
  else if (name === 'browser_fill_form' && Array.isArray(a.fields)) target = `${a.fields.length} fields`
  else if (name === 'browser_tabs' && typeof a.action === 'string') target = a.action
  const short = target.replace(/\s+/g, ' ').slice(0, 60)
  return short ? `${name} ${short}` : name
}

// The element ref or selector a call acts on, for the action log (the UI highlights it).
export function targetsOf(args: Record<string, unknown> | undefined): { target?: string; endTarget?: string } {
  const a = args ?? {}
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = a[k]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200)
    }
    return undefined
  }
  const target = pick('target', 'ref', 'startTarget', 'selector')
  const endTarget = pick('endTarget')
  return { ...(target ? { target } : {}), ...(endTarget ? { endTarget } : {}) }
}

function resultText(result: Record<string, unknown>): string {
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

export interface Gate {
  // Aborts held calls and releases the activity counters (session closed).
  dispose(): void
}

interface Inflight {
  epoch: number
  name: string
  // An extra's own error text is not page content.
  own: boolean
  end: (status: EndStatus) => void
}

function accessorSetter(o: object, key: string): ((v: unknown) => void) | undefined {
  for (let p: object | null = o; p; p = Object.getPrototypeOf(p) as object | null) {
    const d = Object.getOwnPropertyDescriptor(p, key)
    if (d) return d.set
  }
  return undefined
}

// Wraps an MCP server transport. Every tools/call waits while the project is paused (Take control), asks the
// user first when the autonomy policy says so, marks the AI active, is written to the action log, and a result
// that straddled a pause is replaced by INTERRUPTED. Results that can carry page text are fenced as untrusted.
// Call it before the server connects; the server then sets onmessage on the wrapped transport.
export function gateTransport(transport: GateTransport, opts: GateOptions): Gate {
  const { hub, crewId, tileId } = opts
  const timeoutMs = opts.pauseTimeoutMs ?? PAUSE_TIMEOUT_MS
  const extras = new Map((opts.extras ?? []).map((t) => [t.name, t]))
  const pending = new Map<string | number, AbortController>()
  const inflight = new Map<string | number, Inflight>()
  const listIds = new Set<string | number>()
  let inner: ((message: never, extra?: never) => void) | undefined
  const rawSend = transport.send.bind(transport)
  const send = (m: RpcMessage): Promise<void> => rawSend(m as never).catch(() => {})

  const answer = (id: string | number, result: Record<string, unknown>) => send({ jsonrpc: '2.0', id, result })

  const gated = async (msg: RpcMessage, extra: never | undefined, call: ToolCall, tool: ExtraTool | undefined): Promise<void> => {
    const id = msg.id as string | number
    const ac = new AbortController()
    pending.set(id, ac)
    const summary = describeCall(call.name, call.args)
    hub.aiBegin(crewId, tileId, summary)
    const actionId = hub.actionBegin(crewId, { tileId, tool: call.name, summary, ...targetsOf(call.args) })
    let ended = false
    const end = (status: EndStatus) => {
      if (ended) return
      ended = true
      pending.delete(id)
      inflight.delete(id)
      hub.actionEnd(crewId, actionId, status)
      hub.aiEnd(crewId)
    }
    // Waits out Take control. False = the call is already answered and ended.
    const waitForControl = async (): Promise<boolean> => {
      if (!hub.isPaused(crewId)) return true
      const r = await hub.waitUntilResumed(crewId, timeoutMs, ac.signal)
      if (r === 'resumed') return true
      if (r === 'timeout') await answer(id, textResult(USER_HAS_CONTROL))
      end('interrupted')
      return false
    }
    try {
      if (!(await waitForControl())) return
      if (opts.policy?.(call) === 'confirm') {
        const ok = opts.confirm ? await opts.confirm(call, ac.signal) : false
        if (ac.signal.aborted) return end('interrupted')
        if (!ok) {
          await answer(id, textResult(REFUSED))
          return end('refused')
        }
        // The user may have taken control while the approval was open.
        if (!(await waitForControl())) return
      }
      await opts.beforeCall?.()
      if (ac.signal.aborted) return end('interrupted')
      inflight.set(id, { epoch: hub.pauseEpoch(crewId), name: call.name, own: tool !== undefined, end })
      if (!tool) {
        inner?.(msg as never, extra)
        return
      }
      let reply: Record<string, unknown>
      try {
        reply = textResult(await tool.run({ crewId, tileId }, call.args, ac.signal))
      } catch (err) {
        reply = { ...textResult(err instanceof ExtraError ? err.message : `${tool.name} failed.`), isError: true }
      }
      if (ac.signal.aborted) return end('interrupted')
      await transport.send({ jsonrpc: '2.0', id, result: reply } as never)
    } catch {
      await answer(id, { ...textResult('The browser is not available.'), isError: true })
      end('error')
    }
  }

  // Extras that only read host state.
  const ungated = async (msg: RpcMessage, tool: ExtraTool): Promise<void> => {
    const id = msg.id as string | number
    const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {}
    try {
      await answer(id, textResult(await tool.run({ crewId, tileId }, args, new AbortController().signal)))
    } catch {
      await answer(id, { ...textResult(`${tool.name} failed.`), isError: true })
    }
  }

  const onmessage = (message: never, extra?: never): void => {
    const msg = message as RpcMessage
    if (msg.method === 'notifications/cancelled') {
      const rid = msg.params?.requestId
      if ((typeof rid === 'string' || typeof rid === 'number') && pending.has(rid)) pending.get(rid)?.abort()
    } else if (msg.method === 'tools/list' && msg.id !== undefined) {
      listIds.add(msg.id)
    } else if (msg.method === 'tools/call' && msg.id !== undefined) {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
      const tool = extras.get(name)
      if (tool?.ungated) return void ungated(msg, tool)
      if (HIDDEN.has(name)) return void answer(msg.id, textResult(CLOSE_DISABLED))
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {}
      return void gated(msg, extra, { name, args, crewId, tileId }, tool)
    }
    inner?.(message, extra)
  }

  // The SDK's Node transport forwards onmessage to an inner web-standard transport through an accessor; ours
  // shadows it, so it must pass our handler on or no message (initialize included) ever reaches the server.
  const forward = accessorSetter(transport, 'onmessage')
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => (inner ? onmessage : undefined),
    set: (h) => {
      inner = h
      forward?.call(transport, h ? onmessage : undefined)
    },
  })

  transport.send = ((message: RpcMessage, options?: never) => {
    let out = message
    if (message.id !== undefined && message.method === undefined) {
      const f = inflight.get(message.id)
      if (f) {
        let status: EndStatus = message.error !== undefined || message.result?.isError === true ? 'error' : 'done'
        if (opts.onResult && message.result && status === 'done') {
          const text = resultText(message.result)
          if (text) {
            try {
              opts.onResult(crewId, f.name, text)
            } catch {
              /* a listener must not break the reply */
            }
          }
        }
        if (hub.pauseEpoch(crewId) !== f.epoch) {
          out = { jsonrpc: '2.0', id: message.id, result: textResult(INTERRUPTED) }
          status = 'interrupted'
        } else if (message.result && carriesPageText(f.name) && !(f.own && status === 'error')) {
          out = { ...message, result: wrapUntrusted(message.result) }
        }
        f.end(status)
      } else if (listIds.delete(message.id) && Array.isArray(message.result?.tools)) {
        const tools = [
          ...(message.result.tools as { name?: unknown }[]).filter((t) => !HIDDEN.has(String(t.name))),
          ...[...extras.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ]
        out = { ...message, result: { ...message.result, tools } }
      }
    }
    return rawSend(out as never, options)
  }) as GateTransport['send']

  return {
    dispose() {
      for (const ac of pending.values()) ac.abort()
      for (const f of [...inflight.values()]) f.end('interrupted')
    },
  }
}
