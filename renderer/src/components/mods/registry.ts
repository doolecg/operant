import type { ComponentType } from 'react'
import { Bot, Command, Flame, FolderTree, Lightbulb, MessageSquareText, Palette, Sparkles, type LucideIcon } from 'lucide-react'
import type { CapabilityReport, ClaudeTileState, ModId } from '@shared/claude-mods'
import type { Settings } from '@shared/settings'
import { SubagentPanel } from './SubagentPanel'

// What a panel mod gets from the host. The host owns the panel's frame (width, collapse) and passes onCollapse.
export interface ModProps {
  tileId: number
  // The project the tile belongs to (its git branch and changes); null for the Playground.
  crewId: number | null
  state: ClaudeTileState | null
  settings: Settings
  // The tile is in the Chat view: its agents come from the chat stream.
  chat?: boolean
  onCollapse: () => void
}

export interface ModAvailability {
  available: boolean
  // Why the mod is not available, shown to the person when it is not.
  reason?: string
}

export interface ClaudeMod {
  // 'keepWarm' and 'commandMenu' are Operant features of the Chat view (kind 'chat'), not Claude Code mods.
  id: ModId | 'keepWarm' | 'commandMenu'
  title: string
  // One line for the settings card.
  description: string
  appliesTo: 'claude'
  icon: LucideIcon
  defaultEnabled: boolean
  // 'panel': Operant's own panel beside the Claude tile (has a component). 'native': a Claude Code mod, a plugin under
  // plugin/mods/<id> that Operant loads with --plugin-dir; it draws inside Claude Code, not in Operant.
  // 'chat': an Operant feature for the Chat view: no plugin, never adds a --plugin-dir.
  kind: 'panel' | 'native' | 'chat'
  isAvailable?: (capabilities: CapabilityReport | undefined) => ModAvailability
  component?: ComponentType<ModProps>
}

const claudeInstalled = (caps: CapabilityReport | undefined): ModAvailability => {
  if (!caps) return { available: false, reason: 'checking the Claude Code CLI' }
  if (!caps.claude.installed) return { available: false, reason: caps.claude.error ?? 'Claude Code is not installed' }
  return { available: true }
}

export const CLAUDE_MODS: ClaudeMod[] = [
  {
    id: 'subagents',
    title: 'Agents',
    description: "The panel beside a Claude tile: what Claude is doing right now, its sub-agents with their model, context and progress (click one to read its conversation), and the MCP, skill and session status.",
    appliesTo: 'claude',
    icon: Bot,
    defaultEnabled: true,
    kind: 'panel',
    isAvailable: (caps) => {
      const a = claudeInstalled(caps)
      if (!a.available) return a
      if (!caps!.claude.subagentEvents) return { available: false, reason: 'this Claude Code version does not send sub-agent events' }
      return { available: true }
    },
    component: SubagentPanel,
  },
  { id: 'promptEnhancer', title: 'Prompt Enhancer', description: '/enhance <rough prompt>, or start a prompt with ++, and a small model rewrites it: the skills to load, the big choices to ask you first, and what done looks like. You approve it before it is sent.', appliesTo: 'claude', icon: Sparkles, defaultEnabled: false, kind: 'native' },
  { id: 'designPicker', title: 'Design Picker', description: 'When Claude asks you to choose a design style, it opens a preview page in your browser showing each style, so you pick by seeing. You still answer in Claude.', appliesTo: 'claude', icon: Palette, defaultEnabled: false, kind: 'native' },
  { id: 'ideaShelf', title: 'Idea Shelf', description: 'Park ideas with /idea while Claude works, without interrupting it. One shelf per project, kept after you close Claude; /ideas to edit, delete or send one as a prompt.', appliesTo: 'claude', icon: Lightbulb, defaultEnabled: false, kind: 'native' },
  { id: 'folderTracker', title: 'Same-Folder Tracker', description: 'When two sessions work in the same project, each shows what the other is editing and warns when both touch the same file.', appliesTo: 'claude', icon: FolderTree, defaultEnabled: false, kind: 'native' },
  { id: 'plainEnglish', title: 'Plain-English Claude Code', description: 'Simple language, all prose in a summary at the end with next steps, and a status line of what the session is doing. A Haiku check flags replies that miss the rules.', appliesTo: 'claude', icon: MessageSquareText, defaultEnabled: false, kind: 'native' },
  { id: 'keepWarm', title: 'Keep warm', description: 'Keeps the prompt cache warm while a chat tile is idle by sending a one-word ping just before the cache expires. Start it with /keepwarm (6h, 90m, always, off, status). Each ping costs tokens. Chat view only.', appliesTo: 'claude', icon: Flame, defaultEnabled: true, kind: 'chat' },
  {
    id: 'commandMenu',
    title: 'Commands menu',
    description: "The Commands button in the Chat view lists Claude Code's slash commands. /status, /mcp and /doctor show their result there. The others run only on Claude Code's own screen, so the menu says so instead of opening the terminal.",
    appliesTo: 'claude',
    icon: Command,
    defaultEnabled: true,
    kind: 'chat',
  },
]
