import { GitBranch } from 'lucide-react'
import type { Crew } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useGitChanges } from '@/lib/queries'
import { errorText } from './Dialogs'

// What `git status` says about the project, read only.
export function GitChangesDialog({ crew, onClose }: { crew: Crew; onClose: () => void }) {
  const q = useGitChanges(crew.id)
  const r = q.data
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="git-changes">
        <DialogHeader>
          <DialogTitle>Changes in {crew.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{crew.folder}</DialogDescription>
        </DialogHeader>
        {q.error ? (
          <p className="text-destructive text-sm">{errorText(q.error)}</p>
        ) : !r ? (
          <p className="text-muted-foreground text-sm">Reading git status…</p>
        ) : !r.isRepo ? (
          <p className="text-muted-foreground text-sm">This folder is not a git repository.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-1.5">
              <GitBranch className="size-4" /> {r.branch || 'detached HEAD'}
              <span className="text-muted-foreground">
                · {r.files.length + r.more === 0 ? 'no changes' : `${r.files.length + r.more} changed ${r.files.length + r.more === 1 ? 'file' : 'files'}`}
              </span>
            </p>
            {r.files.length > 0 && (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border p-2 font-mono text-xs">
                {r.files.map((f) => (
                  <li key={f.path} className="flex gap-2">
                    <span className="text-muted-foreground w-6 shrink-0">{f.status}</span>
                    <span className="min-w-0 break-all">{f.path}</span>
                  </li>
                ))}
                {r.more > 0 && <li className="text-muted-foreground">and {r.more} more</li>}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
