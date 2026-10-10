import { ENHANCE_MAX_MEMORY_TOKENS, ENHANCE_MAX_SYMBOL_LINES, ENHANCE_MAX_SYMBOL_TOKENS, capLines, type EnhanceContext } from '../shared/prompt-enhance'

export const ENHANCE_LOOKUP_MS = 8000

export interface EnhanceContextDeps {
  // Plain memory recall (no model call). `error` says why nothing came back.
  recall(query: string): Promise<{ items: Array<{ text: string }>; error: string }>
  // Compact symbol lines of the project's CodeGraph index, or null when it has none.
  symbols(query: string): Promise<string[] | null>
  timeoutMs?: number
}

const timed = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    )
  })

// Both lookups run at once, each with its own timeout; a failure of one only drops that part.
export async function gatherEnhanceContext(query: string, deps: EnhanceContextDeps): Promise<EnhanceContext> {
  const ms = deps.timeoutMs ?? ENHANCE_LOOKUP_MS
  const q = query.trim().slice(0, 1000)
  const out: EnhanceContext = { memories: [], symbols: [], memoryNote: '', codeNote: '' }
  await Promise.all([
    (async () => {
      try {
        const r = await timed(deps.recall(q), ms)
        if (r === 'timeout') return void (out.memoryNote = 'memory unavailable')
        out.memories = capLines(r.items.map((i) => i.text), 12, ENHANCE_MAX_MEMORY_TOKENS, 600)
        if (!out.memories.length) out.memoryNote = r.error ? 'memory unavailable' : 'no matching memories'
      } catch {
        out.memoryNote = 'memory unavailable'
      }
    })(),
    (async () => {
      try {
        const r = await timed(deps.symbols(q), ms)
        if (r === 'timeout') return void (out.codeNote = 'CodeGraph timed out')
        if (r === null) return void (out.codeNote = 'no CodeGraph index')
        out.symbols = capLines(r, ENHANCE_MAX_SYMBOL_LINES, ENHANCE_MAX_SYMBOL_TOKENS)
        if (!out.symbols.length) out.codeNote = 'no matching code symbols'
      } catch {
        out.codeNote = 'CodeGraph unavailable'
      }
    })(),
  ])
  return out
}
