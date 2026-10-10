import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useCapabilities, useClaudeTileState, useSettings } from '@/lib/queries'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { useAgentSelection } from '@/components/chat/agentSelection'
import { ModBoundary } from './ModBoundary'
import type { ModId } from '@shared/claude-mods'
import { CLAUDE_MODS } from './registry'

const WIDTH_KEY = 'operant.subagentPanelWidth'
const COLLAPSED_KEY = 'operant.subagentPanelCollapsed'
const DEFAULT_WIDTH = 300

// localStorage can be missing or full; the panel then keeps its defaults.
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

// The Claude Mods panel beside a Claude tile. Only Operant's own panels live here: native mods draw inside Claude Code.
// Hidden when Claude mods are off or no panel is enabled; a notice says why the panel cannot run. The frame (width and
// collapse, kept in localStorage) is the host's; a crash in the panel stays inside its ModBoundary.
export function ClaudeModsHost({ tileId, crewId, chat }: { tileId: number; crewId: number | null; chat?: boolean }) {
  const settings = useSettings().data
  const caps = useCapabilities().data
  const state = useClaudeTileState(tileId).data ?? null
  const [width, setWidth] = useState(() => Number(readStored(WIDTH_KEY)) || DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) === '1')
  const panel = useRef<HTMLElement>(null)
  // Opening an agent from the chat expands a collapsed panel.
  const opened = useAgentSelection(tileId).nonce
  useEffect(() => {
    if (opened > 0) setCollapsed(false)
  }, [opened])
  if (!settings || !settings.claudeMods.enabled) return null
  const mod = CLAUDE_MODS.find((m) => m.kind === 'panel' && m.component && settings.claudeMods.mods[m.id as ModId])
  if (!mod?.component) return null
  const Panel = mod.component
  const a = chat ? { available: true } : (mod.isAvailable?.(caps) ?? { available: true })
  const toggle = () => {
    setCollapsed((c) => !c)
    writeStored(COLLAPSED_KEY, collapsed ? '0' : '1')
  }

  return (
    <aside
      ref={panel}
      aria-label={`Claude Mods: ${mod.title} panel`}
      data-testid="subagent-panel"
      className="bg-card relative my-1.5 mr-1.5 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl border text-xs shadow-xs dark:shadow-none"
      style={{ width: collapsed ? 44 : width }}
    >
      {!collapsed && (
        <ResizeHandle
          target={panel}
          axis="x"
          grow={-1}
          min={240}
          max={520}
          label="Resize Subagent Panel"
          className="left-0"
          onResize={setWidth}
          onCommit={(px) => (setWidth(px), writeStored(WIDTH_KEY, String(px)))}
          onReset={() => (setWidth(DEFAULT_WIDTH), writeStored(WIDTH_KEY, String(DEFAULT_WIDTH)))}
        />
      )}
      {collapsed ? (
        <button type="button" aria-expanded={false} aria-label="Expand Subagent Panel" title={mod.title} onClick={toggle} className="hover:bg-accent flex flex-1 flex-col rounded-2xl items-center gap-2 p-2">
          <mod.icon className="text-muted-foreground size-4" aria-hidden />
          <ChevronRight className="text-muted-foreground size-3" aria-hidden />
        </button>
      ) : (
        <ModBoundary title={mod.title}>
          {a.available ? (
            <Panel tileId={tileId} crewId={crewId} state={state} settings={settings} chat={chat} onCollapse={toggle} />
          ) : (
            <p className="text-muted-foreground p-3 text-xs">
              <span className="font-medium">{mod.title}</span> is unavailable: {a.reason}.
            </p>
          )}
        </ModBoundary>
      )}
    </aside>
  )
}
