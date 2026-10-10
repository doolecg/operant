export type DesignOption = { label: string; description?: string }

export type DesignQuestion = {
  header: string
  question: string
  options: DesignOption[]
}

export type DesignPending = {
  questions: DesignQuestion[]
  previewPath?: string
}

declare module 'claude-code' {
  interface PluginState {
    'design-picker': { pending: DesignPending | null }
  }
}
