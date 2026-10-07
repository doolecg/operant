import { GitBranch } from 'lucide-react'
import type { GitInfo } from '@shared/projects'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGitInfo } from '@/lib/queries'
import { pillBtn } from './pill'

export function gitSummary(g: GitInfo): string {
  const parts = [g.detached ? `Detached at ${g.branch}` : `Branch ${g.branch}`]
  parts.push(g.changes > 0 ? `${g.changes} changed ${g.changes === 1 ? 'file' : 'files'}` : 'no changes')
  if (g.ahead > 0) parts.push(`${g.ahead} ahead`)
  if (g.behind > 0) parts.push(`${g.behind} behind`)
  return parts.join(', ')
}

// The open project's git branch with its changed-file count; nothing for a folder that is not a git repository.
// Clicking it shows the changes.
export function GitChip({ crewId, onOpen }: { crewId: number | null; onOpen: () => void }) {
  const git = useGitInfo(crewId, true).data
  if (!git) return null
  const text = gitSummary(git)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={pillBtn} aria-label={`Git: ${text}. Show changes`} onClick={onOpen}>
          <GitBranch aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <span className="max-w-[140px] truncate font-mono text-[11px]">{git.branch}</span>
          {git.ahead > 0 && <span className="text-muted-foreground font-mono text-[10px]">{`↑${git.ahead}`}</span>}
          {git.behind > 0 && <span className="text-muted-foreground font-mono text-[10px]">{`↓${git.behind}`}</span>}
          {git.changes > 0 && <span className="rounded-full bg-amber-400/15 px-1.5 font-mono text-[10px] font-medium text-amber-400">{git.changes}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}
