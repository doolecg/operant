import type { CapabilityReport, CapabilityTerminal, TerminalCapabilities, UsageSource } from '@shared/claude-mods'
import type { MainCli } from '@shared/settings'

export const MAIN_CLIS: MainCli[] = ['claude', 'opencode']
export const CLI_NAME: Record<CapabilityTerminal, string> = { claude: 'Claude Code', opencode: 'OpenCode' }
export const CLI_SHORT: Record<CapabilityTerminal, string> = { claude: 'Claude', opencode: 'OpenCode' }

// Why this CLI cannot open a terminal, or undefined when it can (or the report is not in yet).
export function cliBlocked(caps: CapabilityReport | undefined, cli: MainCli): string | undefined {
  const cap = caps?.[cli]
  if (!cap || cap.installed) return undefined
  return `${CLI_NAME[cli]} is not installed${cap.error ? `: ${cap.error}` : ''}`
}

const USAGE: Record<UsageSource, string> = {
  transcript: 'Claude Code transcripts',
  'opencode-db': 'OpenCode database',
  none: 'none',
}

// One line per feature: 'Available' only when the probe showed it works; anything else is 'Unavailable'.
export function featureRows(cap: TerminalCapabilities): Array<{ label: string; value: string; on: boolean }> {
  return [
    { label: 'Hooks', value: cap.hooks ? 'Available' : 'Unavailable', on: cap.hooks },
    { label: 'Status line', value: cap.statusLine ? 'Available' : 'Unavailable', on: cap.statusLine },
    { label: 'Sub-agent events', value: cap.subagentEvents ? 'Available' : 'Unavailable', on: cap.subagentEvents },
    { label: 'Usage source', value: USAGE[cap.usageSource] ?? 'none', on: cap.usageSource !== 'none' },
  ]
}
