import { useState } from 'react'
import { Check, CircleAlert, ExternalLink, Inbox as InboxIcon, MessageCircleQuestion, ShieldQuestion, X } from 'lucide-react'
import type { InboxItem, InboxKind } from '@shared/board'
import { decodeIpcError } from '@shared/ipc'
import { markdownToPlain } from '@shared/markdown'
import type { Run } from '@shared/types'
import { Button } from '@/components/ui/button'
import { timeAgo } from '@/lib/format'
import { useAnswerRun } from '@/lib/queries'
import { cn } from '@/lib/utils'

const KIND: Record<InboxKind, { label: string; icon: typeof Check; tone: string }> = {
  question: { label: 'Question', icon: MessageCircleQuestion, tone: 'text-amber-500' },
  permission: { label: 'Permission', icon: ShieldQuestion, tone: 'text-amber-500' },
  master: { label: 'Master stopped', icon: CircleAlert, tone: 'text-amber-500' },
  review: { label: 'Review', icon: Check, tone: 'text-violet-500' },
  failed: { label: 'Failed', icon: CircleAlert, tone: 'text-destructive' },
}

function InboxRow({ item, run, onOpen, onDismiss }: { item: InboxItem; run: Run | undefined; onOpen: (runId: number) => void; onDismiss: (runId: number) => void }) {
  const answer = useAnswerRun()
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const { label, icon: Icon, tone } = KIND[item.kind]
  const options = item.kind === 'question' && sent == null ? (run?.questionOptions ?? []) : []
  return (
    <li data-inbox-item={item.runId} data-kind={item.kind} className="bg-card space-y-2.5 rounded-lg border p-3.5">
      <div className="flex items-center gap-2 text-xs">
        <Icon aria-hidden className={cn('size-4 shrink-0', tone)} />
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground font-mono">JOB#{item.runId}</span>
        <span className="text-muted-foreground ml-auto">{timeAgo(item.at)}</span>
      </div>
      <p className="text-sm leading-snug break-words">{markdownToPlain(item.text, 160)}</p>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Answer options for JOB#${item.runId}`}>
          {options.map((o) => (
            <Button
              key={o}
              size="sm"
              variant="outline"
              disabled={answer.isPending}
              onClick={() => {
                setError(null)
                answer.mutate([item.runId, o], { onSuccess: () => setSent(o), onError: (e) => setError(decodeIpcError(e).message) })
              }}
            >
              {o}
            </Button>
          ))}
        </div>
      )}
      {sent != null && (
        <p data-answer-sent className="text-muted-foreground text-xs">
          Answered with {sent}. It leaves the inbox when the Master picks it up.
        </p>
      )}
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" aria-label={`Open JOB#${item.runId} from the inbox`} onClick={() => onOpen(item.runId)}>
          <ExternalLink /> Open
        </Button>
        {item.kind === 'failed' && (
          <Button size="sm" variant="ghost" aria-label={`Dismiss JOB#${item.runId}`} onClick={() => onDismiss(item.runId)}>
            <X /> Dismiss
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </li>
  )
}

// The rail of things that need the owner, oldest first. Open shows the task modal; failures leave once opened or dismissed.
export function Inbox({ items, runs, onOpen, onDismiss }: { items: InboxItem[]; runs: Run[]; onOpen: (runId: number) => void; onDismiss: (runId: number) => void }) {
  return (
    <aside aria-label="Inbox" className="bg-background flex w-[22rem] shrink-0 flex-col border-l">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <InboxIcon aria-hidden className="text-muted-foreground size-4" />
        <h2 className="text-sm font-medium">Inbox</h2>
        <span data-inbox-count className={cn('ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', items.length > 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
          {items.length}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {items.length === 0 ? (
          <p className="text-muted-foreground px-2 py-8 text-center text-sm">Nothing needs you right now</p>
        ) : (
          <ul className="space-y-3">
            {items.map((i) => (
              <InboxRow key={`${i.runId}:${i.kind}`} item={i} run={runs.find((r) => r.id === i.runId)} onOpen={onOpen} onDismiss={onDismiss} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
