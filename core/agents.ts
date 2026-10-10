type Obj = Record<string, unknown>

// Token-shaped text removed from anything Operant shows or keeps: named secrets and any token-looking string.
export function scrubSecrets(text: string, ...secrets: Array<string | null | undefined>): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[token]')
  return out.replace(/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, '[token]')
}

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const LOG_MAX_LINE = 600

// Token-shaped text removed from a log line before it leaves core.
export function scrubLogLine(text: string): string {
  return scrubSecrets(text)
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [secret]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[secret]')
}

const clip = (s: string): string => (s.length > LOG_MAX_LINE ? `${s.slice(0, LOG_MAX_LINE)}...` : s)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// The text of a content field of unknown shape: a string, or blocks with text / content.
function textOf(v: unknown, depth = 0): string {
  if (typeof v === 'string') return v
  if (depth > 4 || !v || typeof v !== 'object') return ''
  if (Array.isArray(v)) return v.map((x) => textOf(x, depth + 1)).filter(Boolean).join(' ')
  const o = obj(v)
  return str(o.text) || textOf(o.content, depth + 1)
}

// Plain-text lines for one transcript entry (a Claude jsonl line or an OpenCode message); [] when it says nothing.
export function logLines(entry: unknown): string[] {
  const l = obj(entry)
  const m = Object.keys(obj(l.message)).length ? obj(l.message) : l
  const role = str(m.role) || str(l.type) || 'agent'
  const content = m.content ?? m.parts ?? m.text
  const out: string[] = []
  const blocks = Array.isArray(content) ? content : [content]
  for (const raw of blocks) {
    if (typeof raw === 'string') {
      if (raw.trim()) out.push(`${role}: ${oneLine(raw)}`)
      continue
    }
    const b = obj(raw)
    const type = str(b.type)
    if (type === 'tool_use' || type === 'tool') {
      const input = b.input ?? obj(b.state).input
      out.push(`tool: ${str(b.name) || str(b.tool) || 'tool'}${input && Object.keys(obj(input)).length ? ` ${oneLine(JSON.stringify(input))}` : ''}`)
    } else if (type === 'tool_result') {
      const t = oneLine(textOf(b.content))
      if (t) out.push(`result: ${t}`)
    } else if (type === 'thinking' || type === 'reasoning') {
      continue
    } else {
      const t = oneLine(textOf(b))
      if (t) out.push(`${role}: ${t}`)
    }
  }
  return out.map((s) => clip(scrubLogLine(s)))
}

