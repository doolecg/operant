import type { Operator, Preset } from '@shared/types'

// Models offered in the selectors; a model an operator or preset already has is always added.
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']
export const CODEX_MODELS = ['gpt-5']

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Select items cannot carry an empty value.
export const DEFAULT_EFFORT = 'default'

export const effortValue = (effort: string) => effort || DEFAULT_EFFORT
export const effortFromValue = (value: string) => (value === DEFAULT_EFFORT ? '' : value)
export const effortLabel = (effort: string) => effort || 'default'

export function modelOptions(agent: Operator['agent'], current: string, presets: Preset[] = []): string[] {
  const base = agent === 'claude' ? CLAUDE_MODELS : agent === 'codex' ? CODEX_MODELS : []
  const used = presets.filter((p) => p.agent === agent).map((p) => p.model)
  return [...new Set([...base, ...used, current].filter((m) => m && m !== '-'))]
}

export const hasModel = (o: Pick<Operator, 'agent'>) => o.agent !== 'shell'

// Effort is a Claude flag (ruling R3); the shipped table leaves it out for Haiku.
export const hasEffort = (o: Pick<Operator, 'agent' | 'model'>) => o.agent === 'claude' && !o.model.includes('haiku')
