// Project groups, IDE launching and git changes: what the project list and its menu need.

export interface ProjectGroup {
  id: number
  name: string
  sortOrder: number
  collapsed: boolean
}

export const IDE_IDS = ['code', 'cursor', 'windsurf', 'zed', 'idea', 'rider', 'sublime', 'custom'] as const
export type IdeId = (typeof IDE_IDS)[number]

export interface IdeInfo {
  id: IdeId
  name: string
  // Found on this computer (custom counts when a command is set).
  available: boolean
}

export interface GitChange {
  // The two status letters of `git status --short`, trimmed ("M", "??", "A", "D", "R" ...).
  status: string
  path: string
}

// The branch chip: where the project's git stands, in one cheap call.
export interface GitInfo {
  branch: string
  ahead: number
  behind: number
  // Changed and untracked files.
  changes: number
  // HEAD is not on a branch (branch then holds the short commit id).
  detached: boolean
}

export interface GitChanges {
  isRepo: boolean
  branch: string
  files: GitChange[]
  // More changed files than `files` holds.
  more: number
}
