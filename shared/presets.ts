// The eight lifecycle stages. Every built-in preset is one stage for one CLI: its key is the stage key, and an OpenCode
// copy adds "-opencode". Shared by core (the store adds the info to each preset) and the renderer (the Presets page
// lists one row per stage, in this order).
export interface StageInfo {
  stage: number
  name: string
  description: string
  whenToUse: string
  readOnly: boolean
}

export const STAGES: Record<string, StageInfo> = {
  research: {
    stage: 1,
    name: 'Research',
    description: 'Finds out how something works or what is true, with evidence.',
    whenToUse: 'You need to know where something lives, or whether a claim holds, before you decide anything.',
    readOnly: true,
  },
  plan: {
    stage: 2,
    name: 'Plan',
    description: 'Writes ordered steps, each with a done-check, the files it touches and its risks.',
    whenToUse: 'A change is big enough that you want the steps and checks before any edit.',
    readOnly: true,
  },
  design: {
    stage: 3,
    name: 'Design',
    description: 'Decides structure, boundaries, data flow and trade-offs before anything is built.',
    whenToUse: 'The approach is not obvious, or the change reaches into several modules.',
    readOnly: true,
  },
  implement: {
    stage: 4,
    name: 'Implement',
    description: 'Makes the smallest change that works and checks it. Also covers bug fixes, features, refactors, performance and docs.',
    whenToUse: 'The change is clear, or a bug needs its cause found and fixed.',
    readOnly: false,
  },
  test: {
    stage: 5,
    name: 'Test',
    description: 'Adds or extends tests, in test files only, and reports the behaviour that is still untested.',
    whenToUse: 'Behaviour is unproven or untested, and the code itself must not change.',
    readOnly: false,
  },
  review: {
    stage: 6,
    name: 'Review',
    description: 'Checks a change against what was asked: correctness, edge cases, security and clarity.',
    whenToUse: 'A diff or branch needs a critical read before it is accepted.',
    readOnly: true,
  },
  release: {
    stage: 7,
    name: 'Release',
    description: 'Drafts the release notes, checks the version and runs the build. Edits release files only; commits nothing.',
    whenToUse: 'A release is about to be cut and its notes or version need checking.',
    readOnly: false,
  },
  learn: {
    stage: 8,
    name: 'Learn',
    description: 'Extracts durable lessons from a session or change and saves them to memory. Edits no files.',
    whenToUse: 'A piece of work is finished and its decisions or pitfalls are worth keeping.',
    readOnly: true,
  },
}

export const STAGE_KEYS = Object.keys(STAGES)

// What a built-in preset is for (the stage it belongs to); nothing for a user preset.
export interface PresetInfo {
  stage: number
  description: string
  whenToUse: string
}

// The entry for a built-in key (an OpenCode copy shares its Claude entry); nothing for a user preset.
export function presetInfo(builtin: string | null): Partial<PresetInfo> {
  if (builtin == null) return {}
  const s = STAGES[builtin.replace(/-opencode$/, '')]
  return s ? { stage: s.stage, description: s.description, whenToUse: s.whenToUse } : {}
}

// Whether a preset's rules let it edit files: its tool list has an edit tool (an empty list means the default set,
// which has one) and it does not deny both Edit and Write.
export function canEditFiles(p: { tools: string; deny: string[] }): boolean {
  const hasEdit = p.tools.trim() === '' || /(^|,)\s*(Edit|Write|NotebookEdit)\s*(,|$)/.test(p.tools)
  const denied = p.deny.includes('Edit') && p.deny.includes('Write')
  return hasEdit && !denied
}
