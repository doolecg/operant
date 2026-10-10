// Series colours for the cost charts: four token kinds, theme colours (CSS variables), readable on the card background and
// distinguishable without hue alone because every chart also prints its values.
export const KIND_COLORS = {
  input: 'var(--chart-1)',
  output: 'var(--chart-2)',
  cacheRead: 'var(--chart-3)',
  cacheWrite: 'var(--chart-4)',
} as const

export type KindKey = keyof typeof KIND_COLORS