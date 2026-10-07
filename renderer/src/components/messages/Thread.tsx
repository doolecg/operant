import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, Pencil, Send, Trash2, X } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { Message } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAnswerMessage, useDeleteMessage, useEditMessage, useMarkRead, useSendMessage } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { Conversation, Entry } from './model'

const errorText = (e: unknown) => decodeIpcError(e).message

const clock = (at: number) =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

interface Sender {
  kind: string
  label: string
}

// Who the message is from, as a label the user cannot mistake. Agent text itself is rendered as plain text.
function senderOf(m: Message): Sender {
  if (m.fromKind === 'user') return { kind: 'user', label: 'You' }
  if (m.fromKind === 'master') return { kind: 'Master Terminal', label: m.fromLabel }
  if (m.fromId == null) return { kind: 'Operant', label: '' }
  return { kind: 'operator', label: m.fromLabel }
}

export function Thread({
  crewId,
  conversation,
  entries,
  onBack,
}: {
  crewId: number
  conversation: Conversation
  entries: Entry[]
  onBack: () => void
}) {
  const markRead = useMarkRead()
  const endRef = useRef<HTMLDivElement>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)

  const unreadIds = entries
    .filter((e) => e.message.toKind === 'user' && e.message.kind !== 'ask' && e.message.readAt == null)
    .flatMap((e) => e.ids)
  const unreadKey = unreadIds.join(',')
  useEffect(() => {
    if (unreadIds.length > 0) markRead.mutate([crewId, unreadIds])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crewId, unreadKey])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries.length])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-7" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{conversation.title}</div>
          <div className="text-muted-foreground truncate text-[11px]">{conversation.subtitle}</div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {entries.length === 0 && <p className="text-muted-foreground text-xs">No messages yet.</p>}
          {entries.map((e) => (
            <Bubble key={e.ids[0]} entry={e} onDelete={() => setDeleting(e)} />
          ))}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      {conversation.to != null ? (
        <Composer crewId={crewId} conversation={conversation} />
      ) : (
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">Operant notices cannot be replied to.</p>
      )}

      <DeleteDialog entry={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}

function Bubble({ entry, onDelete }: { entry: Entry; onDelete: () => void }) {
  const m = entry.message
  const sender = senderOf(m)
  const mine = m.fromKind === 'user'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.body)
  const edit = useEditMessage()
  const editable = mine && m.readAt == null && m.kind === 'message'

  if (m.kind === 'ask' && m.toKind === 'user') return <ConsentCard entry={entry} sender={sender} onDelete={onDelete} />

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    try {
      for (const id of entry.ids) await edit.mutateAsync([id, draft])
      setEditing(false)
    } catch {
      // shown from edit.error
    }
  }

  return (
    <div className={cn('group flex flex-col gap-1', mine && 'items-end')}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge variant={mine ? 'secondary' : 'outline'} className="px-1.5 py-0 text-[10px]">
          {sender.kind}
        </Badge>
        {sender.label && <span className="max-w-40 truncate">{sender.label}</span>}
        <span>{clock(m.createdAt)}</span>
        {mine && entry.copies > 1 && <span>to {entry.copies} operators</span>}
        {mine && <span>{m.readAt != null ? 'read' : 'unread'}</span>}
        {m.jobId != null && <span>job {m.jobId}</span>}
      </div>
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="flex w-full gap-1">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8" aria-label="Edit message" autoFocus />
          <Button size="icon" className="size-8 shrink-0" type="submit" aria-label="Save edit" disabled={edit.isPending}>
            <Check />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            type="button"
            aria-label="Cancel edit"
            onClick={() => {
              setEditing(false)
              setDraft(m.body)
            }}
          >
            <X />
          </Button>
        </form>
      ) : (
        <div
          className={cn(
            'max-w-[92%] rounded-lg border px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap',
            mine ? 'bg-primary/10' : 'bg-card',
          )}
        >
          {m.body}
        </div>
      )}
      {edit.error && (
        <p role="alert" className="text-destructive text-xs">
          {errorText(edit.error)}
        </p>
      )}
      {!editing && (
        <div className="flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {editable && (
            <Button variant="ghost" size="icon" className="size-6" aria-label="Edit message" onClick={() => setEditing(true)}>
              <Pencil className="size-3" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-6" aria-label="Delete message" onClick={onDelete}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

function ConsentCard({ entry, sender, onDelete }: { entry: Entry; sender: Sender; onDelete: () => void }) {
  const m = entry.message
  const answer = useAnswerMessage()
  const [note, setNote] = useState('')
  const open = m.readAt == null
  const respond = (approved: boolean) => answer.mutate([m.id, approved, note.trim() || undefined])
  return (
    <div className={cn('bg-card space-y-2 rounded-lg border p-3', open && 'border-primary/60')}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {sender.kind}
        </Badge>
        <span className="max-w-40 truncate">{sender.label}</span>
        <span>{clock(m.createdAt)}</span>
        {m.jobId != null && <span>job {m.jobId}</span>}
      </div>
      <p className="text-xs font-medium">Permission request</p>
      <p className="text-sm break-words whitespace-pre-wrap">{m.body}</p>
      {open ? (
        <>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
            className="h-8"
            aria-label="Note with your answer"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => respond(true)} disabled={answer.isPending} aria-label="Approve request">
              <Check /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => respond(false)} disabled={answer.isPending} aria-label="Decline request">
              <X /> Decline
            </Button>
            <Button size="icon" variant="ghost" className="ml-auto size-8" onClick={onDelete} aria-label="Delete message">
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center">
          <span className="text-muted-foreground text-xs">Answered</span>
          <Button size="icon" variant="ghost" className="ml-auto size-6" onClick={onDelete} aria-label="Delete message">
            <Trash2 className="size-3" />
          </Button>
        </div>
      )}
      {answer.error && (
        <p role="alert" className="text-destructive text-xs">
          {errorText(answer.error)}
        </p>
      )}
    </div>
  )
}

function Composer({ crewId, conversation }: { crewId: number; conversation: Conversation }) {
  const [body, setBody] = useState('')
  const send = useSendMessage()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim() || conversation.to == null) return
    send.mutate([{ crewId, to: conversation.to, body }], { onSuccess: () => setBody('') })
  }
  return (
    <form onSubmit={submit} className="space-y-1 border-t p-2">
      <div className="flex gap-2">
        <Input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Message ${conversation.title}`}
          className="h-8"
          aria-label={`Message ${conversation.title}`}
        />
        <Button size="icon" className="size-8 shrink-0" type="submit" aria-label="Send message" disabled={send.isPending || !body.trim()}>
          <Send />
        </Button>
      </div>
      {send.error && (
        <p role="alert" className="text-destructive text-xs">
          {errorText(send.error)}
        </p>
      )}
    </form>
  )
}

function DeleteDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const del = useDeleteMessage()
  const [error, setError] = useState<string | null>(null)
  const unread = entry != null && entry.message.readAt == null && entry.message.fromKind === 'user'
  const copies = entry?.ids.length ?? 0
  const close = () => {
    setError(null)
    onClose()
  }
  const run = async () => {
    if (!entry) return
    try {
      for (const id of entry.ids) await del.mutateAsync([id])
      close()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Dialog open={entry != null} onOpenChange={(o) => !o && close()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete {copies > 1 ? `${copies} messages` : 'message'}?</DialogTitle>
          <DialogDescription>
            {copies > 1
              ? `This message was delivered to ${copies} operators; all ${copies} copies are removed.`
              : 'The message is removed from the conversation.'}
            {unread && ' It has not been read yet, so the recipient will never see it.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void run()} disabled={del.isPending}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
