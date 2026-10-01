// Series colours for the cost charts: four token kinds, readable on the dark card background and
// distinguishable without hue alone because every chart also prints its values.
export const KIND_COLORS = {
  input: '#60a5fa',
  output: '#fbbf24',
  cacheRead: '#34d399',
  cacheWrite: '#c084fc',
} as const

export const KIND_LABELS = {
  input: 'Uncached input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write (5m + 1h)',
} as const

export type KindKey = keyof typeof KIND_COLORS
export const KIND_KEYS: KindKey[] = ['input', 'output', 'cacheRead', 'cacheWrite']

export const MODEL_COLOR = '#38bdf8'
