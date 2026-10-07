import type { ReactNode } from 'react'
import { decodeIpcError } from '@shared/ipc'
import type { LearnStore, LessonKind, LessonStatus } from '@shared/learn'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export const STORE_LABEL: Record<LearnStore, string> = { hindsight: 'Hindsight', codegraph: 'CodeGraph notes', memory: 'Personal memory' }
export const STATUS_LABEL: Record<LessonStatus, string> = { active: 'Active', stale: 'Stale', pending: 'Pending review', deleted: 'Deleted' }
export const KIND_LABEL: Record<LessonKind, string> = { convention: 'Convention', pitfall: 'Pitfall', correction: 'Correction', procedure: 'Procedure' }

export const errorText = (e: unknown): string => decodeIpcError(e).message

export function ErrorLine({ error }: { error: unknown }) {
  if (error == null) return null
  return (
    <p role="alert" className="text-destructive text-xs">
      {errorText(error)}
    </p>
  )
}

export function StatusBadge({ status }: { status: LessonStatus }) {
  return (
    <Badge variant="outline" className={cn(status === 'stale' && 'text-amber-400', status === 'pending' && 'text-sky-400', status === 'deleted' && 'text-muted-foreground')}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">{children}</p>
}
