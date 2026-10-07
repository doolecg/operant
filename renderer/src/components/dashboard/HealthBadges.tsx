import type { ProjectHealth } from '@shared/types'

type Tone = 'ok' | 'warn' | 'bad' | 'idle'

export interface HealthBadge {
  id: 'hindsight' | 'codegraph'
  label: string
  tone: Tone
  tip: string
}

const HINDSIGHT: Record<ProjectHealth['hindsight']['state'], { label: string; tone: Tone }> = {
  running: { label: 'up', tone: 'ok' },
  stopped: { label: 'down', tone: 'bad' },
  'no-uv': { label: 'no uv', tone: 'warn' },
  error: { label: 'down', tone: 'bad' },
}

// The two health entries of the Memory status: Hindsight up, down or missing uv; CodeGraph indexed, stale, indexing or not indexed.
export function healthBadges(h: ProjectHealth): HealthBadge[] {
  const hs = HINDSIGHT[h.hindsight.state]
  const hsTip =
    h.hindsight.state === 'running'
      ? `Hindsight memory is running at ${h.hindsight.url} (bank ${h.hindsight.bank}).`
      : h.hindsight.state === 'no-uv'
        ? 'Hindsight needs uvx to start its memory server, and uv is not installed. Jobs run without memory.'
        : `Hindsight memory is not available${h.hindsight.detail ? `: ${h.hindsight.detail}` : ''}. Jobs run without memory.`
  const c = h.codegraph
  const cg: { label: string; tone: Tone; tip: string } = c.indexing
    ? { label: 'indexing', tone: 'idle', tip: 'CodeGraph is indexing this project now.' }
    : !c.initialized
      ? { label: 'not indexed', tone: 'idle', tip: 'This project has no CodeGraph index yet. Use Index with CodeGraph.' }
      : c.error
        ? { label: 'error', tone: 'bad', tip: `CodeGraph reported an error: ${c.error}` }
        : c.stale
          ? { label: 'stale', tone: 'warn', tip: `Files changed since the last index (${c.files} files, ${c.symbols} symbols indexed). Use Update index.` }
          : { label: 'indexed', tone: 'ok', tip: `CodeGraph index is current: ${c.files} files, ${c.symbols} symbols.${c.cliAvailable ? '' : ' The codegraph command is not on PATH, so jobs cannot explore with it.'}` }
  return [
    { id: 'hindsight', label: `Hindsight ${hs.label}`, tone: hs.tone, tip: hsTip },
    { id: 'codegraph', label: `CodeGraph ${cg.label}`, tone: cg.tone, tip: cg.tip },
  ]
}
