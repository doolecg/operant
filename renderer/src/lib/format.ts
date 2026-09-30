import type { AgentKind, OperatorStatus } from '@shared/types'

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(at).toLocaleDateString()
}

export const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

export const compact = (n: number) => n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export const agentLabel: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' }

export const defaultModel: Record<AgentKind, string> = { claude: 'sonnet', codex: 'gpt-5', shell: '-' }

export const statusLabel: Record<OperatorStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle',
  error: 'Error',
}

// Context window by model family; the 5.x models and Opus/Sonnet 4.6+ have 1M.
export const contextWindow = (model: string) => (model.startsWith('claude-haiku') ? 200_000 : 1_000_000)
