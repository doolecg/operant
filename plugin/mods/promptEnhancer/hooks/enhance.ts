import type { Usage } from '../types'

export const MARK = /^\+\+ /

export const LIMITS = { calls: 20, tokens: 120_000, maxTokens: 900, timeoutMs: 30_000, skills: 60 }

export type Skill = { name: string; description: string }

export const SYSTEM_PROMPT = `You rewrite a rough request to Claude Code into a clear, complete prompt.
Reply with the rewritten prompt only: no preface, no code fence. Use exactly this shape:

<the cleaned task in the person's own intent, one to five sentences>

Load these skills: <names from the Installed skills list that clearly fit, comma separated, or "none">
Ask me first about: <the big decisions to settle before work starts, a short list, or "nothing">
Done when: <what the finished result looks like, a short list>

Use only skill names from the Installed skills list. Do not invent facts about the project or add requirements the person did not imply.`

export function withinBudget(usage: Usage): boolean {
  return usage.calls < LIMITS.calls && usage.tokens < LIMITS.tokens
}

export function parseSkill(markdown: string): { name?: string; description?: string } {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!head) return {}
  const found: { name?: string; description?: string } = {}
  for (const line of head[1]!.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line)
    if (field) found[field[1] as 'name' | 'description'] = field[2]!.trim().replace(/^["']|["']$/g, '').slice(0, 200)
  }
  return found
}

export function buildPrompt(rough: string, skills: readonly Skill[], note?: string): string {
  const list = skills.length
    ? skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
    : 'none'
  const notes = note ? `\n(${note})` : ''
  return `Installed skills:\n${list}${notes}\n\nRough prompt:\n"""\n${rough}\n"""`
}

export function cleanReply(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim()
    .slice(0, 6000)
}
