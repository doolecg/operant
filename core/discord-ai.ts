import type { DiscordBotAi } from '../shared/types'
import { cliChatModel, localChatModel } from './chatmodel'
import { chatFrontDeskModel, FRONT_DESK_MODEL, type FrontDeskModel } from './discord-frontdesk'
import { listLocalModels, normalizeLocalUrl, type LocalLlmDeps } from './localllm'
import { ClaudeAdapter, type MasterAdapter } from './master'

export interface DiscordAiDeps {
  supported?: ReadonlySet<string>
  // The OpenCode adapter (the app's own registry entry).
  opencode: () => MasterAdapter | undefined
  local?: LocalLlmDeps
}

// The model that answers for a bot that chose its own AI.
export function discordAiModel(ai: DiscordBotAi, d: DiscordAiDeps): FrontDeskModel {
  if (ai.cli === 'local') {
    const url = normalizeLocalUrl(ai.localUrl, true)
    return 'error' in url ? () => Promise.reject(new Error(url.error)) : chatFrontDeskModel(localChatModel(url.url, ai.model, d.local))
  }
  if (ai.cli === 'opencode') {
    const adapter = d.opencode()
    if (!adapter) return () => Promise.reject(new Error('OpenCode is not available'))
    return chatFrontDeskModel(cliChatModel(adapter, { model: ai.model || undefined, effort: ai.effort || undefined }))
  }
  const adapter = new ClaudeAdapter({ supported: d.supported, permissionMode: 'default' })
  return chatFrontDeskModel(cliChatModel(adapter, { model: ai.model || FRONT_DESK_MODEL, effort: ai.effort || undefined }))
}

export async function discordLocalModels(url: string, d: LocalLlmDeps = {}): Promise<string[]> {
  const u = normalizeLocalUrl(url, true)
  if ('error' in u) throw new Error(u.error)
  const r = await listLocalModels(u.url, d)
  if (r.error) throw new Error(r.error)
  return r.models
}
