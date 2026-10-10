export type Proposal = { original: string; proposal: string }
export type Usage = { calls: number; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': { pending: Proposal | null; usage: Usage }
  }
}
