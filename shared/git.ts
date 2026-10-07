// The Git page: what the project's repository looks like and the actions on it. Every path is relative to the
// repository folder with "/" separators.

export interface GitFileEntry {
  path: string
  // Where a rename or copy came from.
  orig?: string
  // Porcelain letters of the index (staged) and the working tree; "." means unchanged there.
  x: string
  y: string
  untracked: boolean
  conflicted: boolean
}

export interface GitStatus {
  // The repository folder (the project may be a folder inside it).
  root: string
  // Branch name, or the short commit id when detached; empty before the first commit on an unborn branch is still the branch name.
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileEntry[]
  // More changed files than `files` holds.
  more: number
}

export interface GitDiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface GitHunk {
  header: string
  oldStart: number
  newStart: number
  lines: GitDiffLine[]
}

export interface GitDiff {
  path: string
  renamedFrom?: string
  isNew: boolean
  isDeleted: boolean
  binary: boolean
  // A reason the content is not shown (too large, cut short, unreadable).
  note?: string
  additions: number
  deletions: number
  hunks: GitHunk[]
}

export interface GitDiffRequest {
  path: string
  orig?: string
  // Which side: the staged changes, the working tree's, an untracked file, or a commit's.
  side: 'staged' | 'unstaged' | 'untracked' | 'commit'
  commit?: string
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  // ISO 8601.
  date: string
  subject: string
  refs: string[]
  body: string
}

export interface GitCommitDetails {
  commit: GitCommit
  files: GitCommitFile[]
}

export interface GitCommitFile {
  status: string
  path: string
  orig?: string
}

export interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
}

export interface GitBranches {
  current: string
  detached: boolean
  branches: GitBranch[]
}

// The outcome of an action that runs git: its own words, success or not.
export interface GitResult {
  ok: boolean
  output: string
}

export interface GitCommitResult extends GitResult {
  hash?: string
}

export interface GitHunkRef {
  path: string
  // The hunk's index in the file's current diff, and its header line to be sure the file did not change meanwhile.
  index: number
  header: string
}
