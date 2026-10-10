export type Phase = 'working' | 'waiting' | 'idle' | 'done'

export type TrackedFile = { path: string; at: number }

export type Tracker = {
  id: string
  cwd: string
  phase: Phase
  at: number
  files: TrackedFile[]
}
