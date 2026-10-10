export type Verdict = {
  // ok: the rules held. missed: a rule did not. unclear: the check gave no usable answer.
  kind: 'ok' | 'missed' | 'unclear'
  note: string
}

export type PlainEnglishView = {
  verdict: Verdict | null
  // Model checks made this session, and the tokens they used.
  checks: number
  tokens: number
  // The first words of the latest prompt, for the status line.
  topic: string
}

declare module 'claude-code' {
  interface PluginState {
    'plain-english': { view: PlainEnglishView }
  }
}
