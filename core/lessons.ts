import type { Lesson } from '../shared/learn'

// Pure helpers over lesson text: comparing, matching and rendering for a brief.

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'should', 'make', 'always', 'never', 'use', 'are', 'was', 'not', 'but', 'you', 'its', 'then', 'than'])

export const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_./\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function words(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both)
}

export const similarity = (a: string, b: string): number => (normalize(a) === normalize(b) ? 1 : jaccard(words(a), words(b)))

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase())

type Targets = Pick<Lesson, 'files' | 'symbols'>

// True when the two lessons point at the same code: they share a file or symbol, or both name none.
export function sameTargets(a: Targets, b: Targets): boolean {
  const [af, bf, as, bs] = [lower(a.files), lower(b.files), lower(a.symbols), lower(b.symbols)]
  if (!af.length && !bf.length && !as.length && !bs.length) return true
  return af.some((f) => bf.includes(f)) || as.some((s) => bs.includes(s))
}

export const DUPLICATE_AT = 0.7

export const isDuplicate = (a: Pick<Lesson, 'text' | 'files' | 'symbols'>, b: Pick<Lesson, 'text' | 'files' | 'symbols'>): boolean =>
  similarity(a.text, b.text) >= DUPLICATE_AT && sameTargets(a, b)

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase()

// Active lessons that bear on a task: they name one of its symbols or files, or share at least two of its words.
export function matchLessons(lessons: Lesson[], task: string, symbols: string[], limit = 8): Lesson[] {
  const syms = new Set(lower(symbols))
  const taskWords = words(task)
  return lessons
    .filter((l) => l.status === 'active')
    .map((l) => {
      const shared = [...words(l.text)].filter((w) => taskWords.has(w)).length
      const named = l.symbols.filter((s) => syms.has(s.toLowerCase())).length + l.files.filter((f) => syms.has(f.toLowerCase()) || syms.has(base(f))).length
      return { l, score: named * 3 + shared, strong: named > 0 || shared >= 2 }
    })
    .filter((s) => s.strong)
    .sort((a, b) => b.score - a.score || b.l.hits - a.l.hits || b.l.id - a.l.id)
    .slice(0, limit)
    .map((s) => s.l)
}

export function lessonLine(l: Lesson): string {
  const where = [...l.files.slice(0, 3), ...l.symbols.slice(0, 3)]
  const jobs = l.sourceJobs.length ? ` (from ${l.sourceJobs.map((j) => `JOB#${j}`).join(', ')})` : ''
  return `- [${l.kind}] ${l.text}${where.length ? ` [${where.join(', ')}]` : ''}${jobs}`
}

export function lessonsSection(lessons: Lesson[]): string {
  return `Lessons from past jobs (CodeGraph notes tagged to these files and symbols; check them against the code):\n${lessons.map(lessonLine).join('\n')}`
}

export const slug = (text: string, max = 40): string =>
  normalize(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'lesson'
