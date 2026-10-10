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
  // A fix: the installed skill file it rewrites. '' for a new skill.
  targetPath: string
  // A fix's file before it was rewritten, so rolling it back restores the text. Set on approval.
  previousBody: string
  // The lesson the draft came from (0 for a draft that predates this, or none): a procedure is drafted once.
  lessonId: number
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
  // A learn step is running now.
  running: boolean
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
  // off: nothing runs. suggest (default): every lesson and draft waits for review. controlled: low-risk lessons apply
  // themselves, reversibly. advanced: also skill drafts that pass validation apply themselves.
  mode: LearnMode
  // Budgets per learn run (one session end). Calls include validation retries.
  maxCallsPerReview: number
  maxTokensPerReview: number
  maxChangesPerReview: number
  validationRetries: number
  // Spend cap per day in USD across learn calls; 0 means no cap.
  dailyUsdBudget: number
  // What a hit budget does: stop the run, or stop and wait for a confirm (learn:runNow with confirm).
  onLimit: LearnOnLimit
  // Trivial-session gate, checked in code before any model call.
  minUserTurns: number
  minTokens: number
}

export type LearnMode = 'off' | 'suggest' | 'controlled' | 'advanced'
export type LearnOnLimit = 'stop' | 'confirm'
export const LEARN_MODES: LearnMode[] = ['off', 'suggest', 'controlled', 'advanced']

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

export const DEFAULT_LEARN_SETTINGS: LearnSettings = {
  enabled: true,
  hindsight: true,
  codegraph: true,
  memory: true,
  review: 'queue',
  cli: 'claude',
  model: '',
  effort: '',
  localUrl: 'http://127.0.0.1:1234',
  localInsecureOk: false,
  mode: 'suggest',
  maxCallsPerReview: 3,
  maxTokensPerReview: 60_000,
  maxChangesPerReview: 5,
  validationRetries: 1,
  dailyUsdBudget: 0,
  onLimit: 'stop',
  minUserTurns: 3,
  minTokens: 2000,
}

// A recorded automatic change (or a proposal waiting for review): what it was, what it became, and why.
export type LearnChangeKind = 'lesson' | 'skill' | 'preset' | 'team'
export type LearnChangeStatus = 'proposed' | 'applied' | 'rejected' | 'rolledBack' | 'failed'

export interface LearnChange {
  id: number
  at: number
  crewId: number | null
  kind: LearnChangeKind
  // The lesson, draft, preset or team the change touches (0 when none exists yet).
  targetId: number
  proposal: string
  evidence: string
  filesAffected: string[]
  cli: string
  model: string
  tokens: number
  usd: number
  validation: string
  status: LearnChangeStatus
  // The text before and after the change: rollback puts `previous` back.
  previous: string
  next: string
  rolledBackAt: number | null
}

export interface MemoryFile {
  file: string
  name: string
  description: string
  type: string
  body: string
}
