// The settings pages: grouped into categories, each page composing one or more sections. A section id is the old
// section id, so a deep link to any old section opens its page and scrolls to that section.
export const SETTINGS_SECTION_IDS = [
  'general',
  'appearance',
  'projects',
  'topbar',
  'terminals',
  'terminal',
  'tiles',
  'mods',
  'tokens',
  'budgets',
  'presets',
  'teams',
  'learning',
  'memory',
  'aux',
  'hindsight',
  'codegraph',
  'backups',
  'superpowers',
  'mcp',
  'import',
  'shortcuts',
  'reset',
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export interface SettingsSubsection {
  id: SettingsSectionId
  label: string
}

export interface SettingsPage {
  id: string
  label: string
  description: string
  keywords?: string
  subsections: SettingsSubsection[]
}

export interface SettingsCategory {
  label: string
  pages: SettingsPage[]
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    label: 'General',
    pages: [
      { id: 'general', label: 'General', description: 'Interface size and updates.', keywords: 'scale zoom ui size display update version', subsections: [{ id: 'general', label: 'Display and updates' }] },
      { id: 'appearance', label: 'Appearance', description: 'Colour themes, accent colour and terminal colours. Changes show live.', keywords: 'theme colour color accent dark light', subsections: [{ id: 'appearance', label: 'Themes and colours' }] },
      { id: 'topbar', label: 'Top bar', description: 'The Windows media controls, the clock and date, and the top bar panel buttons.', keywords: 'clock date media scale', subsections: [{ id: 'topbar', label: 'Top bar' }] },
      { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard shortcuts. Rebind any of them here.', keywords: 'keys keybind hotkey binding', subsections: [{ id: 'shortcuts', label: 'Keyboard shortcuts' }] },
    ],
  },
  {
    label: 'Workspace',
    pages: [
      { id: 'projects', label: 'Projects', description: 'The project list, its groups, and the folder and IDE each project opens with.', keywords: 'ide folder group sidebar', subsections: [{ id: 'projects', label: 'Projects' }] },
      {
        id: 'terminals',
        label: 'Terminals',
        description: 'How terminals start and look, the text in them, and how the tiles arrange.',
        keywords: 'shell cli font scrollback tile layout composer chat message',
        subsections: [
          { id: 'terminals', label: 'Defaults for new terminals' },
          { id: 'terminal', label: 'Terminal text' },
          { id: 'tiles', label: 'Tiles' },
        ],
      },
    ],
  },
  {
    label: 'Claude & OpenCode',
    pages: [
      { id: 'mods', label: 'Claude Mods', description: 'Operant hooks and status line for Claude Code tiles, and the sub-agent panel.', keywords: 'hooks status line subagent info bar', subsections: [{ id: 'mods', label: 'Claude Mods' }] },
      { id: 'superpowers', label: 'Superpowers', description: 'The Superpowers skills pack that presets can use.', keywords: 'skills plugin pack', subsections: [{ id: 'superpowers', label: 'Superpowers' }] },
      { id: 'mcp', label: 'MCP servers', description: 'Model Context Protocol servers for Claude Code and OpenCode. Secrets stay masked.', keywords: 'mcp server tools claude opencode', subsections: [{ id: 'mcp', label: 'MCP servers' }] },
    ],
  },
  {
    label: 'Presets',
    pages: [
      {
        id: 'presets',
        label: 'Presets',
        description: 'Saved setups for your projects, and the teams that guide them.',
        keywords: 'preset team role prompt',
        subsections: [
          { id: 'presets', label: 'Presets' },
          { id: 'teams', label: 'Teams' },
        ],
      },
    ],
  },
  {
    label: 'Memory & learning',
    pages: [
      {
        id: 'memory',
        label: 'Memory',
        description: 'The memory server, what recall returns, lessons, and the code index of each project.',
        keywords: 'hindsight codegraph lessons recall bank soul export reset diagnostics',
        subsections: [
          { id: 'memory', label: 'Memory provider and recall' },
          { id: 'hindsight', label: 'Hindsight' },
          { id: 'codegraph', label: 'CodeGraph' },
        ],
      },
      {
        id: 'learning',
        label: 'Learning',
        description: 'The learn step that turns finished jobs into lessons: its AI, its mode and budgets, and the records of each change.',
        keywords: 'learn ai model budget auxiliary records rollback',
        subsections: [
          { id: 'learning', label: 'Learning' },
          { id: 'aux', label: 'Auxiliary models' },
        ],
      },
    ],
  },
  {
    label: 'Usage',
    pages: [
      {
        id: 'usage',
        label: 'Tokens and budgets',
        description: 'Token warnings and caps, and the daily spend budget.',
        keywords: 'tokens budget spend cap limit cache usd',
        subsections: [
          { id: 'tokens', label: 'Tokens' },
          { id: 'budgets', label: 'Budgets' },
        ],
      },
    ],
  },
  {
    label: 'Data',
    pages: [
      {
        id: 'data',
        label: 'Data and reset',
        description: 'Backups, moving your data to or from another machine, and resetting settings.',
        keywords: 'backup restore import export reset migrate',
        subsections: [
          { id: 'backups', label: 'Backups' },
          { id: 'import', label: 'Import and export' },
          { id: 'reset', label: 'Reset' },
        ],
      },
    ],
  },
]

export const SETTINGS_PAGES: SettingsPage[] = SETTINGS_CATEGORIES.flatMap((c) => c.pages)

// The page and (when the id names a section inside a shared page) the section to scroll to.
// Page ids win over section ids, so 'general' opens the General page itself.
export function resolveSettingsTarget(id?: string): { page: SettingsPage; section?: SettingsSubsection } | undefined {
  if (!id) return undefined
  const page = SETTINGS_PAGES.find((p) => p.id === id)
  if (page) return { page }
  for (const p of SETTINGS_PAGES) {
    const section = p.subsections.find((s) => s.id === id)
    if (section) return { page: p, section }
  }
  return undefined
}

// The page list a search matches against: the page's label, description, keywords and section labels.
export function settingsSearchText(page: SettingsPage): string {
  return [page.label, page.description, page.keywords ?? '', ...page.subsections.map((s) => s.label)].join(' ').toLowerCase()
}
