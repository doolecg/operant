import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Crew, DiscordBot, Run } from '../shared/types'
import type { ChatModel } from './chatmodel'
import { ClaudeAdapter, MODEL_TIMEOUT_MS, resultWithin, type MasterAdapter } from './master'

// Sends one prompt to the cheapest model and returns its text.
export type FrontDeskModel = (prompt: string) => Promise<string>

// Any ChatModel (Claude, OpenCode or a local server) as the front desk's one-prompt model.
export const chatFrontDeskModel =
  (chat: ChatModel): FrontDeskModel =>
  (prompt) =>
    chat.chat([{ role: 'user', content: prompt }], { json: true })

export const FRONT_DESK_MODEL = 'claude-haiku-4-5'

// The real front desk: one non-interactive Claude Haiku run in an empty folder, with no permission to
// change anything.
export function claudeFrontDeskModel(supported?: ReadonlySet<string>, o: { adapter?: MasterAdapter; timeoutMs?: number } = {}): FrontDeskModel {
  const adapter = o.adapter ?? new ClaudeAdapter({ supported, permissionMode: 'default' })
  return async (prompt) => {
    const cwd = join(tmpdir(), 'operant-front-desk')
    mkdirSync(cwd, { recursive: true })
    const run = await adapter.start({ cwd, prompt, model: FRONT_DESK_MODEL, onEvent: () => undefined })
    const result = await resultWithin(run, o.timeoutMs ?? MODEL_TIMEOUT_MS, 'The front desk model')
    if (!result.ok) throw new Error(result.text || 'The front desk model failed')
    return result.text
  }
}

export type FrontDeskAction = { type: 'start'; project: string; task: string }

export interface FrontDeskReply {
  reply: string
  action: FrontDeskAction | null
}

export interface FrontDeskContext {
  bot: DiscordBot
  crews: Crew[]
  runs: Run[]
  text: string
  // A user outside the allowlist: the model gets no job data and any action it asks for is dropped.
  chatOnly: boolean
}

const STATUS_RE = /\b(what('?s| is| are)?\s+(running|going on|happening)|status|jobs?\s+(list|status)|list\s+(the\s+)?jobs|running now)\b/i

export const asksForStatus = (text: string): boolean => STATUS_RE.test(text)

export function statusReport(crews: Crew[], runs: Run[]): string {
  const live = runs.filter((r) => r.status !== 'done' && r.status !== 'failed')
  const recent = runs.filter((r) => r.status === 'done' || r.status === 'failed').slice(0, 5)
  const line = (r: Run) => {
    const crew = crews.find((c) => c.id === r.crewId)
    return `JOB#${r.id} [${r.status}] PRJ${crew?.prjNumber ?? '?'} ${crew?.name ?? ''}: ${r.task.replace(/\s+/g, ' ').slice(0, 100)}`
  }
  const parts = [live.length ? `Running or waiting:\n${live.map(line).join('\n')}` : 'Nothing is running right now.']
  if (recent.length) parts.push(`Recently finished:\n${recent.map(line).join('\n')}`)
  return parts.join('\n\n')
}

export function findProject(crews: Crew[], ref: string): Crew | null {
  const q = ref.trim().toLowerCase()
  if (!q) return null
  const prj = /^(?:prj\s*#?)?(\d{3,})$/.exec(q)
  if (prj) return crews.find((c) => c.prjNumber === Number(prj[1])) ?? null
  const exact = crews.filter((c) => c.name.toLowerCase() === q)
  if (exact.length === 1) return exact[0] ?? null
  const partial = crews.filter((c) => c.name.toLowerCase().includes(q))
  return partial.length === 1 ? (partial[0] ?? null) : null
}

function buildPrompt(c: FrontDeskContext): string {
  const lines = [
    'You are the front desk of Operant, a tool that runs coding agents. Reply briefly and plainly (a few sentences, Discord-friendly).',
    'Answer with ONE JSON object and nothing else: {"reply": string, "action": null | {"type": "start", "project": string, "task": string}}.',
  ]
  if (c.chatOnly) {
    lines.push('This user may only chat. Never start work, never mention jobs or projects; the action must be null.')
  } else {
    lines.push(
      'Use action "start" only when the user clearly asks for coding work. "project" is the PRJ number or name from the list; "task" is the full task text. If the project is unclear, ask in "reply" and set action to null.',
      `Projects:\n${c.crews.map((p) => `PRJ${p.prjNumber} ${p.name}`).join('\n') || '(none)'}`,
      `Jobs:\n${statusReport(c.crews, c.runs)}`,
    )
  }
  if (c.bot.rules.trim()) lines.push(`Rules for this bot:\n${c.bot.rules.trim()}`)
  lines.push(`User message:\n${c.text}`)
  return lines.join('\n\n')
}

// Every top-level {...} in the text, in order (string-aware), so JSON wrapped in prose or code fences is found.
function jsonObjects(raw: string): string[] {
  const out: string[] = []
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]!
      if (inStr) {
        if (ch === '\\') i++
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        out.push(raw.slice(start, i + 1))
        start = i
        break
      }
    }
  }
  return out
}

function parseReply(raw: string): FrontDeskReply {
  for (const cand of jsonObjects(raw)) {
    try {
      const o = JSON.parse(cand) as { reply?: unknown; action?: { type?: unknown; project?: unknown; task?: unknown } | null }
      if (!o || typeof o !== 'object' || (!('reply' in o) && !('action' in o))) continue
      const reply = typeof o.reply === 'string' ? o.reply : ''
      const a = o.action
      const action =
        a && a.type === 'start' && typeof a.project === 'string' && typeof a.task === 'string' && a.task.trim()
          ? ({ type: 'start', project: a.project, task: a.task.trim() } as const)
          : null
      return { reply, action }
    } catch {
      // Try the next candidate.
    }
  }
  // Plain text is still a reply (code fences and a leading "reply:" label from a small model are dropped).
  return { reply: raw.replace(/```(?:json)?/gi, '').replace(/^\s*reply\s*:\s*/i, '').trim(), action: null }
}

export async function askFrontDesk(model: FrontDeskModel, c: FrontDeskContext): Promise<FrontDeskReply> {
  if (!c.chatOnly && asksForStatus(c.text)) return { reply: statusReport(c.crews, c.runs), action: null }
  const out = parseReply(await model(buildPrompt(c)))
  return c.chatOnly ? { reply: out.reply, action: null } : out
}
