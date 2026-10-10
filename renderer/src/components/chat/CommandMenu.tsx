import { Fragment, useState } from 'react'
import type { ChatCommand, ChatState, McpServerInfo } from '@shared/claude-chat'
import { decodeIpcError } from '@shared/ipc'
import { bridge } from '@/lib/bridge'
import { compact, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RUNS_IN_CHAT } from './chatHelpers'

const MCP_STATUS: Record<McpServerInfo['status'], string> = { connected: 'Connected', pending: 'Starting', failed: 'Failed', 'needs-auth': 'Needs sign-in', disabled: 'Disabled' }

interface Report {
  busy: boolean
  text: string | null
  error: string | null
}

// The chat's own state, as the /status command shows it.
function statusRows(s: ChatState): Array<[string, string]> {
  const ctx = s.context
  return [
    ['Model', s.modelDisplayName ?? s.model ?? 'not reported yet'],
    ['Claude Code', s.claudeVersion ?? 'unknown'],
    ['Session', s.sessionId ?? 'none yet'],
    ['Permissions', s.permissionMode],
    ['Effort', s.effort ?? 'default'],
    ['Context', ctx ? `${compact(ctx.usedTokens)}${ctx.windowTokens ? ` of ${compact(ctx.windowTokens)}` : ''}` : 'not reported yet'],
    ['Cost', s.costUsd == null ? 'not reported yet' : usd(s.costUsd)],
  ]
}

// The Commands menu of a Claude tile: every slash command, filterable. /status, /mcp and /doctor show their result
// here; a chat command goes into the message box; the rest only run on Claude Code's own screen, which is said.
export function CommandMenu({ commands, state, initial, onInsert }: { commands: ChatCommand[]; state: ChatState; initial: string | null; onInsert: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(initial)
  const [report, setReport] = useState<Report>({ busy: false, text: null, error: null })
  const q = query.trim().replace(/^\//, '').toLowerCase()
  const list = commands.filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
  const cmd = commands.find((c) => c.name === picked) ?? null

  const pick = (name: string) => {
    setPicked(name)
    setReport({ busy: false, text: null, error: null })
  }
  const runDoctor = async () => {
    setReport({ busy: true, text: null, error: null })
    try {
      setReport({ busy: false, text: await bridge().invoke('claude:doctor'), error: null })
    } catch (e) {
      setReport({ busy: false, text: null, error: decodeIpcError(e).message })
    }
  }

  return (
    <div className="text-[13px]">
      <div className="border-border border-b p-2">
        <input
          aria-label="Filter commands"
          placeholder="Filter commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="bg-background border-border focus-visible:ring-ring/50 w-full rounded-md border px-2 py-1 text-[13px] outline-none focus-visible:ring-2"
        />
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {list.map((c) => (
          <button
            key={c.name}
            type="button"
            aria-pressed={c.name === picked}
            onClick={() => pick(c.name)}
            className={cn('flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-foreground/[0.07]', c.name === picked && 'bg-foreground/[0.09]')}
          >
            <span className="shrink-0 font-semibold">/{c.name}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">{c.description}</span>
            {c.terminalOnly && (
              <span className="text-muted-foreground/70 shrink-0 text-[11px]">{RUNS_IN_CHAT.has(c.name) ? 'Here' : 'Claude screen'}</span>
            )}
          </button>
        ))}
        {list.length === 0 && <p className="text-muted-foreground px-2 py-1">No command matches.</p>}
      </div>
      {cmd && (
        <div aria-live="polite" className="border-border space-y-2 border-t p-3">
          <div>
            <span className="font-semibold">/{cmd.name}</span> <span className="text-muted-foreground">{cmd.description}</span>
          </div>
          {cmd.name === 'status' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
              {statusRows(state).map(([k, v]) => (
                <Fragment key={k}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 truncate">{v}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {cmd.name === 'mcp' &&
            (state.mcpServers?.length ? (
              <ul className="space-y-1 text-[12px]">
                {state.mcpServers.map((s) => (
                  <li key={s.name} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className="text-muted-foreground shrink-0">{MCP_STATUS[s.status]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-[12px]">No MCP servers reported yet. They appear once Claude Code starts.</p>
            ))}
          {cmd.name === 'doctor' && (
            <div className="space-y-2">
              <button type="button" disabled={report.busy} onClick={() => void runDoctor()} className="border-border hover:bg-accent rounded-[9px] border px-3 py-[4px] text-[12px] disabled:opacity-50">
                {report.busy ? 'Running claude doctor…' : 'Run claude doctor'}
              </button>
              {report.error && <p className="text-destructive text-[12px]">{report.error}</p>}
              {report.text && <pre className="bg-background max-h-56 overflow-auto rounded-md p-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap">{report.text}</pre>}
            </div>
          )}
          {cmd.terminalOnly && !RUNS_IN_CHAT.has(cmd.name) && (
            <p className="text-muted-foreground text-[12px]">This command runs only on Claude Code's own screen, which the Chat view does not show. It is not available here yet.</p>
          )}
          {!cmd.terminalOnly && (
            <button type="button" onClick={() => onInsert(cmd.name)} className="border-border hover:bg-accent rounded-[9px] border px-3 py-[4px] text-[12px]">
              Put /{cmd.name} in the message
            </button>
          )}
        </div>
      )}
    </div>
  )
}
