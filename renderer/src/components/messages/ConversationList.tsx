import { Crown, MessageSquare } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Conversation } from './model'

export function UnreadPill({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null
  return (
    <span
      aria-label={label}
      className="bg-primary text-primary-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

export function ConversationList({ items, onOpen }: { items: Conversation[]; onOpen: (c: Conversation) => void }) {
  return (
    <ScrollArea className="h-full">
      <nav aria-label="Conversations" className="space-y-0.5 p-2">
        {items.map((c) => {
          const Icon = c.key === 'master' ? Crown : MessageSquare
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onOpen(c)}
              aria-label={`Open conversation with ${c.title}${c.unread ? `, ${c.unread} unread` : ''}`}
              className={cn(
                'hover:bg-accent/50 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
                c.key.startsWith('op:') && 'pl-6',
              )}
            >
              <Icon className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate', c.unread > 0 && 'font-semibold')}>{c.title}</span>
                <span className="text-muted-foreground block truncate text-[11px]">{c.subtitle}</span>
              </span>
              <UnreadPill count={c.unread} label={`${c.unread} unread`} />
            </button>
          )
        })}
      </nav>
    </ScrollArea>
  )
}
