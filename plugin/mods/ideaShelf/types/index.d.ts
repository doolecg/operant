export type Idea = { text: string; at: number }

export type Editing = { id: string; draft: string }

declare module 'claude-code' {
  interface PluginState {
    'idea-shelf': { editing: Editing | null }
  }
}
