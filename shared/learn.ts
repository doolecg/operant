// The learning loop: lessons a finished job (or a Master conversation) taught, where they were written, and
// the drafts of skills built from repeated procedures.

export type LessonKind = 'convention' | 'pitfall' | 'correction' | 'procedure'
export type LessonStatus = 'active' | 'stale' | 'deleted' | 'pending'
export type LearnStore = 'hindsight' | 'codegraph' | 'memory'
export type LessonScope = 'project' | 'user'

export const LESSON_KINDS: LessonKind[] = ['convention', 'pitfall', 'correction', 'procedure']
export const LEARN_STORES: LearnStore[] = ['hindsight', 'codegraph', 'memory']

export interface Lesson {
  id: number
  crewId: number
  text: string
  kind: LessonKind
  // 'user' lessons are facts about the user, kept apart from the project's own in personal memory.
  scope: LessonScope
  files: string[]
  symbols: string[]
  // The jobs that taught it (the first one first); a merged duplicate adds its job here.
  sourceJobs: number[]
  // Stores the lesson was written to.
  stores: LearnStore[]
  status: LessonStatus
  hits: number
  createdAt: number
  updatedAt: number
}

export interface LessonFilter {
  crewId?: number
  kind?: LessonKind
  status?: LessonStatus
  // Only lessons written to this store.
  store?: LearnStore
  // Case-insensitive text, file or symbol match.
  search?: string
}

export interface LessonPatch {
  text?: string
  kind?: LessonKind
  files?: string[]
  symbols?: string[]
}

export type DraftStatus = 'pending' | 'approved' | 'rejected'

export interface SkillDraft {
  id: number
  crewId: number
  name: string
  body: string
  sourceJobs: number[]
  status: DraftStatus
  // Where an approved draft was installed.
  installedPath: string
  createdAt: number
  updatedAt: number
}

export interface LearnSkip {
  store: LearnStore
  reason: string
}

export interface LearnRunInfo {
  id: number
  crewId: number
  // The JOB#, or null for a Master conversation.
  runId: number | null
  source: 'job' | 'conversation'
  at: number
  extracted: number
  written: number
  merged: number
  staled: number
  queued: number
  skipped: LearnSkip[]
  // Why the whole step did nothing (model failed, learning off).
  error: string
  // The CLI and model the step asked ('' for a run recorded before this was kept).
  cli: string
  model: string
}

export interface LearnStoreStatus {
  store: LearnStore
  enabled: boolean
  up: boolean
  detail: string
  lessons: number
}

export interface LearnStatus {
  enabled: boolean
  review: LearnReview
  stores: LearnStoreStatus[]
  lastRun: LearnRunInfo | null
  pendingDrafts: number
  pendingLessons: number
  totals: { active: number; stale: number; pending: number; deleted: number; drafts: number }
}

export type LearnReview = 'auto' | 'queue'

export interface LearnSettings {
  enabled: boolean
  hindsight: boolean
  codegraph: boolean
  memory: boolean
  // 'queue' (the default) keeps new lessons pending (not written, not in briefs) until the user approves them.
  // Even 'auto' queues a lesson that mentions a command, a URL, or 'always' / 'never' (see lessonNeedsReview).
  review: LearnReview
  // The AI that reads the session. Empty model = a cheap default for the CLI (resolved when it runs); empty effort = the model's own.
  cli: LearnCli
  model: string
  effort: string
  // The local server (base URL; its API key lives in the secret store) and whether a plain-http host outside the LAN is confirmed.
  localUrl: string
  localInsecureOk: boolean
}

// 'local' is a model server on this PC or the LAN that speaks the OpenAI chat API (LM Studio, Ollama, llama.cpp).
export type LearnCli = 'claude' | 'opencode' | 'local'

// What the learn step will ask now: the settings, with an empty model replaced by the cheap default (null when OpenCode lists none).
export interface LearnAi {
  cli: LearnCli
  model: string | null
  effort: string
  // True when `model` is the cheap default rather than the owner's choice.
  isDefault: boolean
  error?: string
}

export interface LearnTestResult {
  ok: boolean
  cli: string
  model: string
  ms: number
  error: string
}

// Text a prompt-injected transcript could plant to steer later sessions: a command, a link, or a standing order.
const RISKY_LESSON = /https?:\/\/|www\.|`|^\s*\$ |\b(always|never)\b|\b(npm|npx|pnpm|yarn|pip|curl|wget|sudo|rm|bash|sh|powershell|cmd|git|node|python)\s+[-\w./]/i

export const lessonNeedsReview = (text: string): boolean => RISKY_LESSON.test(text)

export const DEFAULT_LEARN_SETTINGS: LearnSettings = { enabled: true, hindsight: true, codegraph: true, memory: true, review: 'queue', cli: 'claude', model: '', effort: '', localUrl: 'http://127.0.0.1:1234', localInsecureOk: false }

export interface MemoryFile {
  file: string
  name: string
  description: string
  type: string
  body: string
}
