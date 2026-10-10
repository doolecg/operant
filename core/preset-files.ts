import type { ExportText, Preset } from '../shared/types'
import type { PresetFileEntry, PresetImportItem } from '../shared/ops'

// Preset files: one JSON document of presets (their launch settings and guidance text). Built-ins export like any
// preset; importing never recreates a built-in, it adds a copy the user owns.
const FORMAT = 'operant-presets'
const FILE_MAX = 1_000_000
const PRESETS_MAX = 200
const NAME_MAX = 80
const TEXT_MAX = 20_000

export type { PresetFileEntry, PresetImportItem }

export function exportPresets(presets: Preset[], filename?: string): ExportText {
  const out = presets.map((p) => ({
    key: p.builtin ?? `user:${p.name}`,
    name: p.name,
    agent: p.agent,
    model: p.model,
    effort: p.effort,
    permissionMode: p.permissionMode,
    tools: p.tools,
    allow: p.allow,
    deny: p.deny,
    cacheTtl: p.cacheTtl,
    contextCap: p.contextCap,
    mcp: p.mcp,
    roleText: p.roleText,
  }))
  const one = presets.length === 1 ? presets[0]!.name.replace(/[^\w-]+/g, '-').toLowerCase() : 'presets'
  return { filename: filename ?? `operant-preset-${one}.json`, mime: 'application/json', text: JSON.stringify({ format: FORMAT, version: 1, presets: out }, null, 2) }
}

// Reads a preset file and says, per preset, whether it adds, is skipped (a preset of that name exists) or is refused.
// Nothing is written here.
export function parsePresetFile(text: string, existingNames: string[]): PresetImportItem[] {
  if (text.length > FILE_MAX) throw new Error('That file is too large to be a preset file')
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON')
  }
  const d = doc as { format?: unknown; presets?: unknown }
  if (!d || d.format !== FORMAT || !Array.isArray(d.presets)) throw new Error('That is not an Operant preset file')
  if (d.presets.length > PRESETS_MAX) throw new Error(`A preset file holds at most ${PRESETS_MAX} presets`)
  const taken = new Set(existingNames.map((n) => n.toLowerCase()))
  return d.presets.map((raw: unknown, i): PresetImportItem => {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    const refuse = (reason: string): PresetImportItem => ({ name: name || `Preset ${i + 1}`, action: 'invalid', reason, input: null })
    if (!name) return refuse('It has no name')
    if (name.length > NAME_MAX) return refuse(`The name is longer than ${NAME_MAX} characters`)
    const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback)
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100) : [])
    const roleText = typeof p.roleText === 'string' ? p.roleText : null
    if (roleText && roleText.length > TEXT_MAX) return refuse(`The guidance text is longer than ${TEXT_MAX} characters`)
    const agent = str(p.agent, 20, 'claude')
    if (!['claude', 'codex', 'shell', 'opencode'].includes(agent)) return refuse(`Unknown agent ${agent}`)
    if (taken.has(name.toLowerCase())) return { name, action: 'skip', reason: 'Already here', input: null }
    taken.add(name.toLowerCase())
    const contextCap = typeof p.contextCap === 'number' && Number.isFinite(p.contextCap) ? Math.max(0, Math.round(p.contextCap)) : 200_000
    return {
      name,
      action: 'add',
      reason: '',
      input: {
        name,
        agent,
        model: str(p.model, 200),
        effort: str(p.effort, 40),
        permissionMode: str(p.permissionMode, 40, 'default'),
        tools: str(p.tools, 500),
        allow: list(p.allow),
        deny: list(p.deny),
        cacheTtl: str(p.cacheTtl, 10, 'auto'),
        contextCap,
        mcp: str(p.mcp, 40, 'off'),
        roleText,
      },
    }
  })
}
