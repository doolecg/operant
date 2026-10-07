// Thread names for Discord requests: derived by code (no tokens), or titled by the cheap model with code as the fallback.
import type { FrontDeskModel } from './discord-frontdesk'

export const THREAD_NAME_MAX = 100
export const AI_TITLE_TIMEOUT_MS = 10_000
const TITLE_WORDS = 8

const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])

// A short, clean title: mentions, URLs and Markdown removed, the first sentence, up to 8 words, Title Case.
export function threadTitle(text: string): string {
  const plain = text
    .replace(/<(?:@[!&]?|#)\d+>|<a?:\w+:\d+>/g, ' ')
    .replace(/@(?:everyone|here)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_~|>#\[\]()]/g, ' ')
  const sentence = plain.split(/[.!?\n\r]+(?:\s|$)|[\n\r]+/).find((s) => /\w/.test(s)) ?? ''
  const words = sentence
    .replace(/[^\p{L}\p{N}\s'’+/#:,&-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TITLE_WORDS)
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
  return words.join(' ').replace(/[\s:,&/+-]+$/, '').slice(0, THREAD_NAME_MAX - 12).trim() || 'Request'
}

// Adds " (2)", " (3)" ... until the name is not in `taken` (case-insensitive); never longer than 100 characters.
export function uniqueThreadName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()))
  let name = base.slice(0, THREAD_NAME_MAX)
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, THREAD_NAME_MAX - suffix.length) + suffix
  }
  return name
}

export const jobThreadName = (runId: number, title: string): string => `JOB#${runId} ${title}`.slice(0, THREAD_NAME_MAX)

// Asks the front desk model for a title; any failure or a slow answer (10 s) gives the code's title.
export async function aiThreadTitle(model: FrontDeskModel, text: string, timeoutMs = AI_TITLE_TIMEOUT_MS): Promise<string> {
  const fallback = threadTitle(text)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const prompt = `Give a title of at most 6 words for this chat request. Answer with the title only, no quotes.\n\n${text.slice(0, 1000)}`
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
    })
    const raw = await Promise.race([model(prompt), late])
    const title = threadTitle(raw.split('\n').find((l) => l.trim()) ?? '')
    return title === 'Request' ? fallback : title
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}
