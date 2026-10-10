import type { PlainEnglishView, Verdict } from '../types'

import { buildCheck, parseVerdict } from './rules'

// Replies shorter than this are not worth a check.
export const MIN_CHECK_CHARS = 400
export const MAX_CHECKS = 25
export const MAX_TOKENS = 150_000
export const CHECK_TIMEOUT_MS = 15_000

// What a check needs from the engine: a Haiku-class completion, the toast, and
// the session's view. The hook passes its own `$`; tests pass fakes.
export type CheckDeps = {
  complete: (prompt: string) => Promise<{ isAnswered: true; text: string; usage: { input_tokens: number; output_tokens: number } } | { isAnswered: false; usage: { input_tokens: number; output_tokens: number } }>
  toast: (text: string) => void
  read: () => Promise<PlainEnglishView>
  write: (change: (current: PlainEnglishView) => PlainEnglishView) => Promise<void>
}

export async function checkReply(deps: CheckDeps, answer: string): Promise<void> {
  const before = await deps.read()
  if (before.checks >= MAX_CHECKS || before.tokens >= MAX_TOKENS) return
  await deps.write(current => ({ ...current, checks: current.checks + 1 }))

  let verdict: Verdict
  let used = 0
  try {
    const reply = await deps.complete(buildCheck(answer))
    used = reply.usage.input_tokens + reply.usage.output_tokens
    verdict = reply.isAnswered ? parseVerdict(reply.text) : { kind: 'unclear', note: 'check unclear' }
  } catch {
    verdict = { kind: 'unclear', note: 'check did not run' }
  }

  await deps.write(current => ({ ...current, verdict, tokens: current.tokens + used }))
  if (verdict.kind === 'missed') deps.toast(`Plain-English: ${verdict.note}`)
}
