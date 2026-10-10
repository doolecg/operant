import type { Verdict } from '../types'

export const RULES = [
  'Simple words and short sentences; a technical term gets a few words of explanation.',
  'Little narration of the work: no step-by-step commentary on tool use.',
  'All prose sits in one final block headed "Summary".',
  'The reply ends with a "Next steps" section: a short list, or "None".',
] as const

// The system prompt section: short, because it is sent with every request.
export const SECTION =
  'Plain English: use simple words and short sentences, and explain jargon in a few words. Keep narration of your work to a minimum. Put all prose in one final block headed "Summary". End with a "Next steps" section (a short list, or "None").'

export const MAX_CHECKED_CHARS = 4000

export const buildCheck = (answer: string): string =>
  [
    'Check the reply between the markers against these rules.',
    ...RULES.map((rule, index) => `${index + 1}. ${rule}`),
    'Answer with one line only: PASS, or FAIL: <rule number> <short name of the rule>.',
    '<<<',
    answer.slice(0, MAX_CHECKED_CHARS),
    '>>>',
  ].join('\n')

export function parseVerdict(text: string): Verdict {
  const line = (text.trim().split('\n')[0] ?? '').trim()
  if (/^PASS\b/i.test(line)) return { kind: 'ok', note: 'ok' }

  const failed = /^FAIL\b:?\s*(.*)$/i.exec(line)
  if (failed) {
    const reason = (failed[1] ?? '').trim().slice(0, 80)

    return { kind: 'missed', note: `missed: ${reason === '' ? 'a rule' : reason}` }
  }

  return { kind: 'unclear', note: 'check unclear' }
}
