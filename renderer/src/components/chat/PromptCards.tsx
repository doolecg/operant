import { memo, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { PermissionItem, PlanItem, QuestionItem } from '@shared/claude-chat'
import { Markdown } from '@/components/ui/markdown'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { chatActions } from './useChat'
import { DiffBlock } from './ItemViews'

// The prompt cards are the only bordered element of the conversation: 1 px border, radius 14, page background.
const card = 'border-border bg-background rounded-[14px] border px-4 py-3.5'
const btn = 'rounded-[9px] border px-3 py-[5px] text-[13px] transition-colors'
const primary = `${btn} bg-foreground text-background border-foreground font-semibold hover:opacity-90`
const outline = `${btn} border-border hover:bg-accent`
const textBtn = `${btn} text-muted-foreground hover:text-foreground border-transparent`

const ANSWER_LABEL = { once: 'Allowed once', always: 'Always allowed', denied: 'Denied', expired: 'Expired' } as const

function Answered({ children }: { children: string }) {
  return <div className="text-muted-foreground text-[13px]">{children}</div>
}

export const PermissionCard = memo(function PermissionCard({ scratchId, item }: { scratchId: number; item: PermissionItem }) {
  const [denying, setDenying] = useState(false)
  const [why, setWhy] = useState('')
  if (item.answer !== null) {
    const extra = item.answer === 'denied' && item.denyMessage ? `: ${item.denyMessage}` : ''
    return <Answered>{`${ANSWER_LABEL[item.answer]} · ${item.displayName}${item.summary ? ` ${item.summary}` : ''}${extra}`}</Answered>
  }
  const send = (d: Parameters<typeof chatActions.permission>[2]) => chatActions.permission(scratchId, item.requestId, d)
  const first = item.options[0]
  const onKey = (e: KeyboardEvent) => {
    if (denying || (e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === '1') send({ kind: 'allow' })
    else if (e.key === '2' && first) send({ kind: 'always', index: first.index })
    else if (e.key === '3') setDenying(true)
  }
  return (
    <div role="alertdialog" aria-label={`Permission: ${item.displayName}`} data-pending="permission" tabIndex={-1} onKeyDown={onKey} className={cn(card, item.parent && 'ml-5')}>
      <div className="text-[13px] font-semibold">Claude wants to use {item.displayName}</div>
      {item.description && <div className="text-muted-foreground mt-0.5 text-xs">{item.description}</div>}
      {item.diff ? (
        <div className="my-2.5">
          <DiffBlock diff={item.diff} />
        </div>
      ) : (
        item.summary && <pre className="bg-code mt-2.5 mb-3 max-h-40 overflow-auto rounded-lg px-2.5 py-2 font-mono text-[12.5px] whitespace-pre-wrap break-words">{item.summary}</pre>
      )}
      {item.reason && <div className="text-muted-foreground mb-2.5 text-xs">{item.reason}</div>}
      {denying ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send({ kind: 'deny', ...(why.trim() ? { message: why.trim() } : {}) })
          }}
        >
          <input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setDenying(false))}
            placeholder="Tell Claude why (optional)"
            className="border-border bg-background focus-visible:ring-ring/50 min-w-0 flex-1 rounded-[9px] border px-2.5 py-[5px] text-[13px] outline-none focus-visible:ring-2"
          />
          <button type="submit" className={primary}>
            Deny
          </button>
          <button type="button" className={textBtn} onClick={() => setDenying(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primary} title="Key 1" onClick={() => send({ kind: 'allow' })}>
            Allow once
          </button>
          {first &&
            (item.options.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger className={cn(outline, 'inline-flex items-center gap-1')} title="Key 2">
                  Always allow <ChevronDown className="size-3" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {item.options.map((o) => (
                    <DropdownMenuItem key={o.index} onSelect={() => send({ kind: 'always', index: o.index })}>
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button type="button" className={outline} title={`Key 2 · ${first.label}`} onClick={() => send({ kind: 'always', index: first.index })}>
                {first.label}
              </button>
            ))}
          <button type="button" className={textBtn} title="Key 3" onClick={() => setDenying(true)}>
            Deny
          </button>
        </div>
      )}
    </div>
  )
})

export const QuestionCard = memo(function QuestionCard({ scratchId, item }: { scratchId: number; item: QuestionItem }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string | null>>({})
  const answered = item.answers !== null
  const locked = answered || item.expired || item.requestId === null
  const send = (answers: Record<string, string>) => item.requestId && chatActions.permission(scratchId, item.requestId, { kind: 'answer', answers })
  const single = item.questions.length === 1 && !item.questions[0]!.multiSelect

  const valueOf = (qi: number): string | null => {
    const o = other[qi]
    if (o != null && o.trim()) return o.trim()
    const p = picked[qi]
    return p && p.length ? p.join(', ') : null
  }
  const ready = item.questions.every((_, qi) => valueOf(qi) !== null)
  const submit = () => ready && send(Object.fromEntries(item.questions.map((q, qi) => [q.question, valueOf(qi)!])))

  return (
    <div role="alertdialog" aria-label="Question from Claude" data-pending={locked ? undefined : 'question'} className={cn(card, item.parent && 'ml-5')}>
      <div className="space-y-4">
        {item.questions.map((q, qi) => {
          const chosen = locked ? (item.answers?.[q.question]?.split(', ') ?? []) : (picked[qi] ?? [])
          return (
            <div key={qi}>
              {q.header && <div className="text-muted-foreground mb-0.5 text-xs">{q.header}</div>}
              <div className="mb-2 text-[13px] font-semibold">{q.question}</div>
              <div className="flex flex-wrap gap-2">
                {q.options.map((o) => {
                  const on = chosen.includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      disabled={locked}
                      aria-pressed={on}
                      title={o.description}
                      className={cn(on ? primary : outline, 'max-w-full text-left disabled:opacity-60', on && 'disabled:opacity-100')}
                      onClick={() => {
                        if (single) return send({ [q.question]: o.label })
                        setOther((x) => ({ ...x, [qi]: null }))
                        setPicked((p) => {
                          const cur = p[qi] ?? []
                          return { ...p, [qi]: q.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label] }
                        })
                      }}
                    >
                      <span className="block">{o.label}</span>
                      {o.description && <span className={cn('block text-xs font-normal', on ? 'opacity-70' : 'text-muted-foreground')}>{o.description}</span>}
                    </button>
                  )
                })}
                {!locked && other[qi] === undefined && (
                  <button type="button" className={textBtn} onClick={() => setOther((x) => ({ ...x, [qi]: '' }))}>
                    Other…
                  </button>
                )}
              </div>
              {!locked && other[qi] !== undefined && other[qi] !== null && (
                <input
                  autoFocus
                  value={other[qi] ?? ''}
                  onChange={(e) => setOther((x) => ({ ...x, [qi]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (single && e.currentTarget.value.trim()) send({ [q.question]: e.currentTarget.value.trim() })
                    else submit()
                  }}
                  placeholder="Type your answer"
                  className="border-border bg-background focus-visible:ring-ring/50 mt-2 w-full rounded-[9px] border px-2.5 py-[5px] text-[13px] outline-none focus-visible:ring-2"
                />
              )}
            </div>
          )
        })}
      </div>
      {!locked && (!single || Object.values(other).some((v) => v != null)) && (
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className={cn(primary, !ready && 'opacity-50')} disabled={!ready} onClick={submit}>
            Send answer
          </button>
        </div>
      )}
      {item.expired && <div className="text-muted-foreground mt-2 text-xs">This question can no longer be answered.</div>}
    </div>
  )
})

const PLAN_LABEL = { approved: 'Plan approved', 'approved-edits': 'Plan approved, edits accepted', kept: 'Plan denied', expired: 'Plan expired' } as const

export const PlanCard = memo(function PlanCard({ scratchId, item }: { scratchId: number; item: PlanItem }) {
  const [keeping, setKeeping] = useState(false)
  const [msg, setMsg] = useState('')
  const send = (approve: 'approve' | 'approve-edits' | 'keep', message?: string) =>
    item.requestId && chatActions.permission(scratchId, item.requestId, { kind: 'plan', approve, ...(message ? { message } : {}) })
  const pending = item.answer === null && item.requestId !== null
  return (
    <div role="alertdialog" aria-label="Plan approval" data-pending={pending ? 'plan' : undefined} className={cn(card, item.parent && 'ml-5')}>
      <div className="mb-2 text-[13px] font-semibold">Claude has a plan</div>
      <div className="max-h-96 overflow-y-auto pr-1">
        <Markdown variant="chat" source={item.plan} className="text-[14px] leading-[1.6]" />
      </div>
      {pending ? (
        keeping ? (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              send('keep', msg.trim() || undefined)
            }}
          >
            <input
              autoFocus
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="Why deny it? What should change?"
              className="border-border bg-background focus-visible:ring-ring/50 min-w-0 flex-1 rounded-[9px] border px-2.5 py-[5px] text-[13px] outline-none focus-visible:ring-2"
            />
            <button type="submit" className={primary}>
              Deny plan
            </button>
            <button type="button" className={textBtn} onClick={() => setKeeping(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={primary} onClick={() => send('approve-edits')}>
              Approve and accept edits
            </button>
            <button type="button" className={outline} onClick={() => send('approve')}>
              Approve
            </button>
            <button type="button" className={outline} onClick={() => setKeeping(true)}>
              Deny with comment
            </button>
            <button type="button" className={textBtn} onClick={() => send('keep')}>
              Deny
            </button>
          </div>
        )
      ) : (
        <div className="text-muted-foreground mt-2 text-[13px]">{item.answer ? PLAN_LABEL[item.answer] : PLAN_LABEL.expired}</div>
      )}
    </div>
  )
})
