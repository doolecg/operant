// Claude model ids and efforts offered everywhere (renderer selectors and the core); one source.
export const CLAUDE_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelEntry {
  // provider/model, exactly as `opencode models` prints it.
  id: string
  name: string
  free: boolean
  efforts: string[]
  context?: number
}

export interface ModelProvider {
  providerId: string
  providerName: string
  // False when the provider is known but has no stored credentials (sign in with `opencode auth login`).
  connected: boolean
  models: ModelEntry[]
}

// What models:list answers. `models` and `efforts` are the flat shape older callers use; `providers` groups the same ids.
export interface ModelList {
  models: string[]
  // Effort choices per model id; a model missing here (or with an empty list) has none.
  efforts: Record<string, string[]>
  // Absent only in lists built by hand; the core always sets it.
  providers?: ModelProvider[]
  error?: string
}

const PROVIDER_NAMES: Record<string, string> = {
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  'zai-coding-plan': 'Z.AI Coding Plan',
  zai: 'Z.AI',
  openai: 'OpenAI (ChatGPT)',
  anthropic: 'Anthropic',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  groq: 'Groq',
  'amazon-bedrock': 'Amazon Bedrock',
  azure: 'Azure OpenAI',
}

const WORD_CASE: Record<string, string> = { ai: 'AI', api: 'API', gpt: 'GPT', llm: 'LLM' }

export function providerName(providerId: string): string {
  const known = PROVIDER_NAMES[providerId]
  if (known) return known
  const words = providerId.split(/[-_.\s]+/).filter(Boolean)
  return words.length ? words.map((w) => WORD_CASE[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : providerId
}

// A readable name from a bare model id when the service gave none: "glm-5.2-highspeed" -> "GLM 5.2 Highspeed".
export function modelName(id: string): string {
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const words = bare.split(/[-_]+/).filter(Boolean)
  if (!words.length) return bare
  return words.map((w) => (/^(glm|gpt|llm|ai)$/i.test(w) ? w.toUpperCase() : /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

export const providerOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf('/')))
