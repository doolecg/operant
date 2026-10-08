// Pure helpers for the renderer's draft store (text typed but not yet submitted).
export type DraftKind = 'approve' | 'sendback' | 'answer' | 'newtask'

export const DRAFT_PREFIX = 'operant.draft.'

// For 'newtask' the id is the project id; for the others it is the run id.
export function draftKey(kind: DraftKind, id: number): string {
  return `${DRAFT_PREFIX}${kind}.${id}`
}

export function parseDraftKey(key: string): { kind: DraftKind; id: number } | null {
  const m = /^operant\.draft\.(approve|sendback|answer|newtask)\.(\d+)$/.exec(key)
  return m ? { kind: m[1] as DraftKind, id: Number(m[2]) } : null
}

// Returns the draft keys to delete: well-formed keys whose id is not live. Unknown keys are left alone.
// Callers pass run ids that are still open for run drafts and project ids for 'newtask'.
export function pruneDrafts(keys: string[], live: ReadonlySet<number>, liveProjects?: ReadonlySet<number>): string[] {
  return keys.filter((k) => {
    const p = parseDraftKey(k)
    if (!p) return false
    const set = p.kind === 'newtask' && liveProjects ? liveProjects : live
    return !set.has(p.id)
  })
}
