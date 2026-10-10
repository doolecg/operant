import type { McpCli, McpServer, OptionalMcpEntry, OptionalMcpId } from '../shared/types'

// Optional MCP integrations. Operant never installs one by itself: the user clicks Add in Settings, and a preset that
// names one simply leaves it out while it is not there.
export interface OptionalMcpDef {
  id: OptionalMcpId
  name: string
  // The name Operant writes into a CLI's config.
  server: string
  // Other names the same server may have in a user's config.
  aliases: string[]
  // Text that identifies the package on a server's command line.
  package: string
  description: string
  enables: string
  runtime: { command: string; hint: string }
  needsProject: boolean
  // A user's own copy has the same name and command, so Operant remembers the entries it wrote instead of matching them.
  recordsWrites?: boolean
  // The command Operant writes. Checked against PyPI (mcp-server-git 2026.8.18: --repository) and npm (@playwright/mcp 0.0.83).
  launch: (folder: string) => { command: string; args: string[] }
}

export const OPTIONAL_MCP: OptionalMcpDef[] = [
  {
    id: 'git',
    name: 'Git MCP',
    server: 'git',
    aliases: ['mcp-git', 'git-mcp', 'mcp-server-git'],
    package: 'mcp-server-git',
    description: 'The official Git server from the Model Context Protocol project: an agent reads the history, status, diffs and branches of one repository through tools.',
    enables: 'Review, Release and Implement read the repository state through git tools instead of shell commands.',
    runtime: { command: 'uvx', hint: 'install uv (it provides uvx), from docs.astral.sh/uv' },
    needsProject: true,
    launch: (folder) => ({ command: 'uvx', args: ['mcp-server-git', '--repository', folder] }),
  },
  {
    id: 'playwright',
    name: 'Playwright MCP',
    server: 'playwright',
    aliases: ['playwright-mcp', 'mcp-playwright'],
    package: '@playwright/mcp',
    description: 'Microsoft’s Playwright server: an agent opens pages, clicks, types and takes screenshots in a real browser.',
    enables: 'Test drives the app in a browser for end-to-end checks.',
    runtime: { command: 'npx', hint: 'install Node.js (it provides npx), from nodejs.org' },
    needsProject: false,
    launch: () => ({ command: 'npx', args: ['@playwright/mcp@latest'] }),
  },
  {
    id: 'codegraph',
    name: 'CodeGraph MCP',
    server: 'codegraph',
    aliases: ['codegraph-mcp', 'mcp-codegraph'],
    package: 'codegraph',
    description: 'CodeGraph answers code questions from an index (symbols, callers, impact) so agents read less. Operant’s own CodeGraph indexing keeps working whether or not this server is added.',
    enables: 'Agents look up symbols, callers and impact through CodeGraph tools instead of reading whole files.',
    runtime: { command: 'codegraph', hint: 'install CodeGraph (npm install -g @colbymchenry/codegraph)' },
    needsProject: false,
    recordsWrites: true,
    launch: () => ({ command: 'codegraph', args: ['serve', '--mcp'] }),
  },
]

const CLI_LABEL: Record<McpCli, string> = { claude: 'Claude Code', opencode: 'OpenCode' }

export const optionalMcp = (name: string): OptionalMcpDef | undefined => OPTIONAL_MCP.find((d) => d.id === name)

export const isOptionalMcp = (name: string): boolean => optionalMcp(name) !== undefined

// The names a preset may use for this server, and the names a CLI config may hold it under.
export const optionalNames = (def: OptionalMcpDef): string[] => [def.server, ...def.aliases]

// Every name a server may go by in a CLI config: the preset's own name, or the optional server's aliases.
export const aliasesOf = (name: string): string[] => {
  const def = optionalMcp(name)
  return def ? optionalNames(def) : [name]
}

// The key of a CLI entry in the record of what Operant wrote.
export const writtenKey = (s: Pick<McpServer, 'cli' | 'scope' | 'name'>): string => `${s.cli}:${s.scope}:${s.name}`

// Operant's own entry: the name it writes, with its package on the command line, in a CLI's own config. For a server whose
// entries look like a user's copy, only the entries in the record count.
export function isAppAdded(def: OptionalMcpDef, s: Pick<McpServer, 'cli' | 'scope' | 'name' | 'target' | 'editable'>, written: string[] = []): boolean {
  if (!s.editable || s.name !== def.server || !s.target.includes(def.package)) return false
  return def.recordsWrites ? written.includes(writtenKey(s)) : true
}

// The same server under another name, or added by hand, or a plugin's copy of it. Operant's built-in CodeGraph is not a
// config entry, so it is never a copy.
export function isFoundElsewhere(def: OptionalMcpDef, s: Pick<McpServer, 'cli' | 'scope' | 'name' | 'target' | 'editable'>, written: string[] = []): boolean {
  if (isAppAdded(def, s, written) || s.scope === 'builtin') return false
  return optionalNames(def).includes(s.name) || s.target.includes(def.package)
}

export function optionalEntry(
  def: OptionalMcpDef,
  servers: McpServer[],
  runtime: { ok: boolean; error?: string },
  hasProject: boolean,
  written: string[] = [],
): OptionalMcpEntry {
  const own = servers.filter((s) => isAppAdded(def, s, written))
  const other = servers.find((s) => isFoundElsewhere(def, s, written))
  const status = own.length ? 'added' : other ? 'found' : 'not-added'
  const blocked = !runtime.ok
    ? `${def.runtime.command} is not installed: ${def.runtime.hint}`
    : def.needsProject && !hasProject
      ? 'Select a project first: Git MCP reads one project folder'
      : null
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    enables: def.enables,
    server: def.server,
    status,
    added: own.map((s) => ({ cli: s.cli, scope: s.scope })),
    // A copy a Claude plugin or connector provides is not Operant's to add or remove.
    provided: status === 'found' && other !== undefined && (other.scope === 'plugin' || other.scope === 'connector'),
    ...(status === 'found' && other
      ? {
          foundAs: other.name,
          foundIn: other.scope === 'plugin' || other.scope === 'connector' ? `Provided by a Claude ${other.scope}` : `${CLI_LABEL[other.cli]} (${other.scope})`,
        }
      : {}),
    runtime: { command: def.runtime.command, ok: runtime.ok, ...(runtime.error ? { error: runtime.error } : {}) },
    needsProject: def.needsProject,
    blocked,
    hint: `${def.name} is not installed (optional): Add it in Settings → MCP servers`,
  }
}
