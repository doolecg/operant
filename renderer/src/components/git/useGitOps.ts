import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { GitHunkRef, GitResult } from '@shared/git'
import { decodeIpcError } from '@shared/ipc'
import { call, refreshGit } from '@/lib/queries'

export interface Notice {
  ok: boolean
  title: string
  text: string
}

// Every action on the repository runs from a click on the page: one at a time, its outcome (git's own words) kept as a notice.
export function useGitOps(crewId: number) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  async function run<T extends GitResult>(title: string, fn: () => Promise<T>, quietOk = false): Promise<T | null> {
    if (busy) return null
    setBusy(title)
    try {
      const r = await fn()
      setNotice(r.ok && quietOk ? null : { ok: r.ok, title: r.ok ? title : `${title} failed`, text: r.output })
      return r
    } catch (e) {
      setNotice({ ok: false, title: `${title} failed`, text: decodeIpcError(e).message })
      return null
    } finally {
      setBusy(null)
      void refreshGit(qc)
    }
  }

  return {
    busy,
    notice,
    setNotice,
    stage: (paths: string[]) => run('Stage', () => call('git:stage', crewId, paths), true),
    unstage: (paths: string[]) => run('Unstage', () => call('git:unstage', crewId, paths), true),
    discard: (paths: string[]) => run('Discard', () => call('git:discard', crewId, paths), true),
    stageHunk: (ref: GitHunkRef, stage: boolean) => run(stage ? 'Stage hunk' : 'Unstage hunk', () => call('git:stageHunk', crewId, ref, stage), true),
    commit: (message: string, amend: boolean) =>
      run('Commit', async () => {
        const r = await call('git:commit', crewId, message, amend)
        return { ...r, output: r.ok ? `${amend ? 'Amended' : 'Committed'} ${r.hash ?? ''}\n${r.output}`.trim() : r.output }
      }),
    checkout: (name: string) => run(`Switch to ${name}`, () => call('git:checkout', crewId, name)),
    createBranch: (name: string) => run(`Create ${name}`, () => call('git:createBranch', crewId, name)),
    fetch: () => run('Fetch', () => call('git:fetch', crewId)),
    pull: () => run('Pull', () => call('git:pull', crewId)),
    push: () => run('Push', () => call('git:push', crewId)),
  }
}

export type GitOps = ReturnType<typeof useGitOps>
