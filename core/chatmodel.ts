import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_TIMEOUT_MS, resultWithin, type MasterAdapter } from './master'
import { localChat, type LocalLlmDeps } from './localllm'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  // Ask for a JSON answer (a hint: the Claude and OpenCode adapters just get it in the prompt).
  json?: boolean
}

// One reply from some AI: the Claude, OpenCode and local-server adapters all offer this, so a feature (the learn step,
// the Discord front desk) can use whichever the owner chose.
export interface ChatModel {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
}

const asPrompt = (messages: ChatMessage[], json?: boolean): string =>
  [...messages.map((m) => (m.role === 'user' ? m.content : `${m.role === 'system' ? 'Instructions' : 'Earlier reply'}:\n${m.content}`)), ...(json ? ['Answer with JSON only.'] : [])].join('\n\n')

// A CLI adapter (Claude or OpenCode) as a chat model: one non-interactive run per call in an empty folder.
export function cliChatModel(adapter: MasterAdapter, o: { model?: string; effort?: string; timeoutMs?: number } = {}): ChatModel {
  return {
    async chat(messages, opts) {
      const cwd = join(tmpdir(), 'operant-learn')
      mkdirSync(cwd, { recursive: true })
      const run = await adapter.start({ cwd, prompt: asPrompt(messages, opts?.json), model: o.model, effort: o.effort, onEvent: () => undefined })
      const result = await resultWithin(run, o.timeoutMs ?? MODEL_TIMEOUT_MS, 'The model')
      if (!result.ok) throw new Error(result.text || 'The model failed')
      return result.text
    },
  }
}

export function localChatModel(baseUrl: string, model: string, deps: LocalLlmDeps = {}): ChatModel {
  return { chat: (messages, opts) => localChat(baseUrl, model, messages, { json: opts?.json }, deps) }
}
