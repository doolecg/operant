import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { KeepWarmLine } from './KeepWarmLine'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Check, ChevronDown, Command, CornerDownLeft, Loader2, Plus, Sparkles, Square, Undo2, X } from 'lucide-react'
import type { ChatState } from '@shared/claude-chat'
import { describeEnhanceContext } from '@shared/prompt-enhance'
import { bridge } from '@/lib/bridge'
import { useSettings } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { applySuggestion, currentModel, filterCommands, highlightParts, modeLabel, modeOptions, nextMode, triggerAt, withLocalCommands, type Trigger } from './chatHelpers'
import { EffortPopover } from './EffortPopover'
import { setActivity } from './activityStore'
import { CommandMenu } from './CommandMenu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { chatActions } from './useChat'

interface Attachment {
  mediaType: string
  base64: string
  preview: string
}

// The box starts as one line and grows up to this share of the tile's height, then scrolls.
const MAX_SHARE = 0.4
// Kept while the app runs so a chat bar keeps its text (and the last enhanced prompt) across project, Settings and Memory switches.
const drafts = new Map<number, string>()
const lastEnhanced = new Map<number, string>()
const toolbarBtn ='text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-[26px] items-center gap-1 rounded-[7px] px-2 text-[13px] disabled:opacity-50'

const readImage = (file: File): Promise<Attachment | null> =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      const comma = url.indexOf(',')
      resolve(comma < 0 ? null : { mediaType: file.type || 'image/png', base64: url.slice(comma + 1), preview: url })
    }
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })

// The words of `text` that contain what the owner typed sit in a soft green chip.
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.hit ? (
          <mark key={i} className="bg-success/20 text-foreground rounded-md px-1 py-px">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

interface Props {
  scratchId: number
  state: ChatState
  // The effort the tile was launched with (shown as "Default" in the effort popover).
  launchEffort: string | null
  // The tile's saved model: shown (and its efforts offered) before Claude has reported one, i.e. before the first message.
  tileModel: string | null
  disabled?: boolean
  onSent: () => void
}

export function Composer({ scratchId, state, launchEffort, tileModel, disabled, onSent }: Props) {
  const qc = useQueryClient()
  const [text, setTextState] = useState(() => drafts.get(scratchId) ?? '')
  const setText = (v: string | ((t: string) => string)) =>
    setTextState((t) => {
      const next = typeof v === 'function' ? v(t) : v
      if (next) drafts.set(scratchId, next)
      else drafts.delete(scratchId)
      return next
    })
  const [caret, setCaret] = useState(0)
  const [images, setImages] = useState<Attachment[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [recall, setRecall] = useState(-1)
  const keepWarmOn = useSettings().data?.claudeMods.keepWarm ?? true
  const commandMenuOn = useSettings().data?.claudeMods.commandMenu ?? true
  const allCommands = withLocalCommands(state.commands, keepWarmOn)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPick, setMenuPick] = useState<string | null>(null)
  const [enhancing, setEnhancing] = useState(false)
  const [undo, setUndo] = useState<string | null>(null)
  const [phase, setPhase] = useState<'context' | 'rewrite'>('context')
  const [usedNote, setUsedNote] = useState('')
  const enhanceRun = useRef(0)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const running = state.turn.phase === 'working' || state.turn.phase === 'waiting'
  const model = currentModel(state, tileModel)
  const modelName = state.modelDisplayName ?? model?.displayName ?? state.model
  const history = useMemo(() => state.items.filter((i) => i.kind === 'user' && i.parent === null).map((i) => (i.kind === 'user' ? i.text : '')).reverse(), [state.items])

  // Auto-grow from one line to 40% of the tile's height; shrinks back when the text goes. It is measured again when
  // the box's width changes: measured while the tile was still laying out (width near 0) the placeholder wraps a
  // word per line and the box opened at full height.
  const [areaWidth, setAreaWidth] = useState(0)
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setAreaWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    const tile = el.closest<HTMLElement>('[data-chat="view"]')?.clientHeight ?? 0
    const max = tile > 0 ? Math.max(23, Math.round(tile * MAX_SHARE)) : 230
    const wanted = text === '' || areaWidth < 40 ? 23 : el.scrollHeight
    el.style.height = `${Math.min(Math.max(wanted, 23), max)}px`
    el.style.overflowY = wanted > max ? 'auto' : 'hidden'
  }, [text, areaWidth])

  const trigger: Trigger | null = useMemo(() => triggerAt(text, caret), [text, caret])
  const dismissKey = trigger ? `${trigger.kind}${trigger.start}` : null
  const commandHits = trigger?.kind === '/' ? filterCommands(withLocalCommands(state.commands, keepWarmOn), trigger.query) : []
  useEffect(() => {
    if (trigger?.kind !== '@') return setFiles([])
    let live = true
    const t = setTimeout(() => {
      bridge()
        .invoke('chat:files', scratchId, trigger.query)
        .then((r) => live && setFiles(r))
        .catch(() => live && setFiles([]))
    }, 80)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [trigger?.kind, trigger?.query, scratchId])
  const hits: Array<{ key: string; insert: string; label: string; hint: string }> =
    trigger?.kind === '/'
      ? commandHits.map((c) => ({ key: c.name, insert: c.name, label: `/${c.name}`, hint: c.terminalOnly ? `Opens in Terminal · ${c.description}` : c.description }))
      : trigger?.kind === '@'
        ? files.map((f) => ({ key: f, insert: f, label: f, hint: '' }))
        : []
  const suggesting = hits.length > 0 && dismissKey !== dismissed
  useEffect(() => setSel(0), [trigger?.query, trigger?.kind])

  const addFiles = async (list: File[]) => {
    const insert: string[] = []
    for (const f of list) {
      if (f.type.startsWith('image/')) {
        const a = await readImage(f)
        if (a) setImages((x) => [...x, a])
      } else {
        const p = bridge().filePath(f)
        if (p) insert.push(`@${p}`)
        else toast(`Could not attach ${f.name}`, true)
      }
    }
    if (insert.length) setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${insert.join(' ')} `)
    area.current?.focus()
  }

  const onPaste = (e: ClipboardEvent) => {
    const imgs = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (imgs.length === 0) return
    e.preventDefault()
    void addFiles(imgs)
  }
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    void addFiles([...e.dataTransfer.files])
  }

  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), [])

  // Rewrites the box with a cheap one-shot model call made by Operant. The result replaces the text (editable, never sent).
  const enhance = async () => {
    const original = text
    if (!original.trim() || running || enhancing) return
    const run = ++enhanceRun.current
    setEnhancing(true)
    setPhase('context')
    setActivity(scratchId, { phase: 'context' })
    try {
      const commands = state.commands.map((c) => ({ name: c.name, description: c.description }))
      const context = await bridge().invoke('aux:enhanceContext', original, scratchId).catch(() => undefined)
      if (run !== enhanceRun.current) return
      setPhase('rewrite')
      setActivity(scratchId, { phase: 'rewrite', context: context ?? null })
      const out = await bridge().invoke('aux:enhancePrompt', original, commands, context)
      if (run !== enhanceRun.current) return
      setUsedNote(describeEnhanceContext(context))
      setText(out)
      lastEnhanced.set(scratchId, out)
      setUndo(original)
      if (undoTimer.current) clearTimeout(undoTimer.current)
      undoTimer.current = setTimeout(() => setUndo(null), 15_000)
      area.current?.focus()
    } catch (e) {
      if (run === enhanceRun.current) toast(`Could not enhance the prompt: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e)}`, true)
    } finally {
      if (run === enhanceRun.current) (setEnhancing(false), setActivity(scratchId, { phase: 'idle' }))
    }
  }
  const cancelEnhance = () => {
    enhanceRun.current++
    setEnhancing(false)
    setActivity(scratchId, { phase: 'idle' })
  }
  const undoEnhance = () => {
    if (undo !== null) setText(undo)
    setUndo(null)
  }

  const submit = async () => {
    const body = text.trim()
    if ((!body && images.length === 0) || disabled) return
    // A command that runs only on Claude Code's screen opens the Commands menu on it instead of going to Claude.
    const name = images.length === 0 ? /^\/([^\s/]+)/.exec(body)?.[1] : undefined
    if (name && commandMenuOn && allCommands.some((c) => c.name === name && c.terminalOnly)) {
      setText('')
      setRecall(-1)
      setMenuPick(name)
      setMenuOpen(true)
      return
    }
    const ok = await chatActions.send(scratchId, body, images.map(({ mediaType, base64 }) => ({ mediaType, base64 })))
    if (!ok) return
    setText('')
    setImages([])
    setRecall(-1)
    onSent()
  }

  const accept = (i: number) => {
    const h = hits[i]
    if (!h || !trigger) return
    const next = applySuggestion(text, trigger, caret, h.insert)
    setText(next.text)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (suggesting) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setSel((s) => (s + 1) % hits.length))
      if (e.key === 'ArrowUp') return (e.preventDefault(), setSel((s) => (s - 1 + hits.length) % hits.length))
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) return (e.preventDefault(), accept(sel))
      if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), setDismissed(dismissKey))
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      chatActions.setMode(scratchId, nextMode(state))
    } else if (e.key === 'ArrowUp' && (text === '' || recall >= 0) && history.length > 0 && !e.shiftKey) {
      const i = Math.min(history.length - 1, recall + 1)
      e.preventDefault()
      setRecall(i)
      setText(history[i]!)
    } else if (e.key === 'ArrowDown' && recall >= 0) {
      e.preventDefault()
      const i = recall - 1
      setRecall(i)
      setText(i >= 0 ? history[i]! : '')
    }
  }

  const blocked = state.process === 'blocked'
  const placeholder = state.process === 'starting' ? 'Starting Claude Code…' : 'Type / for commands'
  const canSend = (text.trim() !== '' || images.length > 0) && !disabled

  return (
    <div className="shrink-0 px-4 pt-1.5 pb-3.5" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="mx-auto mb-1.5 flex max-w-[720px] items-center gap-2 px-1">
        {enhancing ? (
          <button type="button" onClick={cancelEnhance} title="Cancel" aria-label="Cancel enhancing" className="bg-accent text-foreground inline-flex h-[26px] items-center gap-1.5 rounded-full px-3 text-[13px]">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> {phase === 'context' ? 'Gathering context…' : 'Enhancing…'}
          </button>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => void enhance()}
                disabled={!text.trim() || running}
                title={running ? 'Wait for Claude to finish' : !text.trim() ? 'Write a prompt first, then enhance it' : 'Rewrite this prompt with the skills to load, what to ask first and when it is done. Right-click to recover the last enhanced prompt'}
                className="bg-accent/60 text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-[26px] items-center gap-1.5 rounded-full px-3 text-[13px] disabled:opacity-50 disabled:hover:bg-accent/60"
              >
                <Sparkles className="size-3.5" aria-hidden /> Enhance prompt
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem disabled={!lastEnhanced.has(scratchId)} onSelect={() => (setText(lastEnhanced.get(scratchId) ?? ''), area.current?.focus())}>
                Recover last enhanced prompt
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
        {undo !== null && !enhancing && (
          <button type="button" onClick={undoEnhance} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px] underline-offset-2 hover:underline">
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
        )}
        {undo !== null && !enhancing && usedNote && <span className="text-muted-foreground/70 text-[11px]">{usedNote}</span>}
        <KeepWarmLine state={state} />
      </div>
      <div className="relative mx-auto max-w-[720px]">
        {suggesting && (
          <div role="listbox" aria-label={trigger?.kind === '/' ? 'Commands' : 'Files'} className="bg-popover border-border absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-[18px] border p-1.5 shadow-[0_10px_30px_rgba(0,0,0,.18)] dark:shadow-[0_10px_30px_rgba(0,0,0,.45)]">
            {hits.map((h, i) => (
              <button
                key={h.key}
                ref={i === sel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                type="button"
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => (e.preventDefault(), accept(i))}
                onMouseEnter={() => setSel(i)}
                className={cn('flex w-full items-baseline gap-3.5 rounded-xl px-3 py-2 text-left', i === sel && 'bg-foreground/[0.07]')}
              >
                <span className={cn('shrink-0 text-[15px] font-bold', trigger?.kind === '@' && 'min-w-0 truncate font-mono text-[13px] font-semibold')}>
                  {trigger?.kind === '@' ? <Highlighted text={h.label} query={trigger.query} /> : h.label}
                </span>
                {h.hint && (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">
                    <Highlighted text={h.hint} query={trigger?.query ?? ''} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="border-border bg-popover rounded-[18px] border py-1.5 pr-2 pl-[18px] shadow-[0_10px_30px_rgba(0,0,0,.18)] dark:shadow-[0_10px_30px_rgba(0,0,0,.45)]">
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {images.map((im, i) => (
                <span key={i} className="relative">
                  <img src={im.preview} alt="Attachment" className="size-14 rounded-lg object-cover" />
                  <button type="button" aria-label="Remove image" onClick={() => setImages((x) => x.filter((_, k) => k !== i))} className="bg-foreground text-background absolute -top-1 -right-1 grid size-4 place-items-center rounded-full">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2.5">
            <textarea
              ref={area}
              data-chat-composer
              aria-label="Message Claude"
              rows={1}
              value={text}
              disabled={blocked}
              placeholder={blocked ? 'Claude Code is unavailable' : placeholder}
              onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart), setRecall(-1))}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className="placeholder:text-muted-foreground/70 min-h-[23px] flex-1 resize-none self-center border-0 bg-transparent p-0 text-[15px] leading-[23px] outline-none"
            />
            {running ? (
              <button type="button" aria-label="Stop" title="Stop (Esc)" onClick={() => chatActions.interrupt(scratchId)} className="bg-foreground text-background grid size-[30px] shrink-0 place-items-center rounded-full hover:opacity-90">
                <Square className="size-[9px] fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                title="Send (Enter)"
                disabled={!canSend}
                onClick={() => void submit()}
                className={cn('grid size-[30px] shrink-0 place-items-center hover:opacity-90', canSend ? 'bg-primary text-primary-foreground rounded-[10px]' : 'bg-foreground text-background rounded-full opacity-40')}
              >
                {canSend ? <ArrowUp className="size-4" strokeWidth={2.5} aria-hidden /> : <CornerDownLeft className="size-[15px]" aria-hidden />}
              </button>
            )}
          </div>
        </div>
        <div className="text-muted-foreground mt-1.5 flex items-center gap-0.5 px-1">
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(toolbarBtn, 'w-[26px] justify-center px-0')} aria-label="Attach">
              <Plus className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              <DropdownMenuItem onSelect={() => picker.current?.click()}>Upload file or image</DropdownMenuItem>
              <div className="text-muted-foreground px-2 py-1 text-xs">Paste an image with Ctrl+V</div>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={picker} type="file" multiple hidden onChange={(e) => (void addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />

          {commandMenuOn && (
            <Popover
              open={menuOpen}
              onOpenChange={(open) => {
                setMenuOpen(open)
                if (!open) setMenuPick(null)
              }}
            >
              <PopoverTrigger className={cn(toolbarBtn, 'w-[26px] justify-center px-0')} aria-label="Claude commands" title="Claude Code commands">
                <Command className="size-3.5" aria-hidden />
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-96 p-0">
                <CommandMenu
                  commands={allCommands}
                  state={state}
                  initial={menuPick}
                  onInsert={(name) => {
                    setText(`/${name} `)
                    setMenuOpen(false)
                    area.current?.focus()
                  }}
                />
              </PopoverContent>
            </Popover>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger className={toolbarBtn} aria-label={`Permission mode: ${modeLabel(state.permissionMode)}`} title="Permission mode (Shift+Tab)">
              {modeLabel(state.permissionMode)}
              <ChevronDown className="size-3" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              {modeOptions(state).map((m) => (
                <DropdownMenuItem key={m} onSelect={() => chatActions.setMode(scratchId, m)}>
                  <span className="flex-1">{modeLabel(m)}</span>
                  {m === state.permissionMode && <Check className="size-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="flex-1" />

          <DropdownMenu>
            <DropdownMenuTrigger className={toolbarBtn} aria-label={`Model: ${modelName ?? 'unknown'}`} disabled={state.models.length === 0}>
              {modelName ?? 'Model'}
              <ChevronDown className="size-3" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-72">
              {state.models.map((m) => (
                <DropdownMenuItem key={m.value} onSelect={() => void chatActions.setModel(scratchId, m.value).then(() => qc.invalidateQueries({ queryKey: ['scratchViews'] }))} className="items-start">
                  <span className="min-w-0 flex-1">
                    <span className="block">{m.displayName}</span>
                    {m.description && <span className="text-muted-foreground block text-xs">{m.description}</span>}
                  </span>
                  {model?.value === m.value && <Check className="mt-0.5 size-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <EffortPopover model={model} modelName={modelName} effort={state.effort} defaultLevel={launchEffort} onChange={(l) => chatActions.setEffort(scratchId, l)} triggerClass={toolbarBtn} />
        </div>
      </div>
    </div>
  )
}
