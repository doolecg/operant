import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import {
  cookieKey,
  cookiesForOrigin,
  CONSOLE_LEVELS,
  draftOfCookie,
  emptyCookieDraft,
  filterConsole,
  filterCookies,
  filterNet,
  formatDuration,
  formatSize,
  maskValue,
  originOf,
  siteCount,
  STATUS_FILTERS,
  statusClass,
  validateCookieDraft,
  type ConsoleEntry,
  type ConsoleLevel,
  type CookieDraft,
  type CookieInfo,
  type CookieKey,
  type NetEntry,
  type StatusFilter,
} from '@shared/browser-inspect'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export type InspectTab = 'console' | 'network' | 'cookies'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // The active tab's logs (main keeps the last 500 of each, even while this panel is closed).
  console: readonly ConsoleEntry[]
  net: readonly NetEntry[]
  // The project's cookies; the owner loads them while the Cookies tab is showing (see onTabChange).
  cookies: readonly CookieInfo[]
  // The active page's address, for "clear this site".
  currentUrl: string
  onTabChange?: (tab: InspectTab) => void
  onClearConsole: () => void
  onClearNet: () => void
  // Reject with the IPC error to show it in the editor.
  onSaveCookie: (draft: CookieDraft, replacing?: CookieKey) => Promise<unknown>
  onDeleteCookie: (key: CookieKey) => Promise<unknown>
  onClearSite: (origin: string) => Promise<unknown>
  onClearAll: () => Promise<unknown>
  // Panel body height in rem when open.
  heightRem?: number
}

const LEVEL_STYLE: Record<ConsoleLevel, string> = {
  debug: 'text-muted-foreground',
  log: '',
  info: 'text-sky-500',
  warn: 'text-amber-500',
  error: 'text-destructive',
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false })
const cell = 'h-7 text-xs'

// Console, network and cookies of the active tab in a collapsible bottom panel.
export function InspectPanel(p: Props) {
  const [tab, setTab] = useState<InspectTab>('console')
  const errors = useMemo(() => p.console.filter((e) => e.level === 'error').length, [p.console])
  const failed = useMemo(() => p.net.filter((e) => ['failed', '4xx', '5xx'].includes(statusClass(e))).length, [p.net])

  const pick = (t: string) => {
    setTab(t as InspectTab)
    p.onTabChange?.(t as InspectTab)
  }
  const toggle = () => {
    p.onOpenChange(!p.open)
    if (!p.open) p.onTabChange?.(tab)
  }

  return (
    <section aria-label="Inspector" className="bg-card/40 flex shrink-0 flex-col border-t">
      <button
        type="button"
        aria-expanded={p.open}
        aria-label={p.open ? 'Collapse inspector' : 'Expand inspector'}
        onClick={toggle}
        className="hover:bg-accent/40 flex h-7 w-full items-center gap-3 px-3 text-left text-xs outline-none"
      >
        {p.open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        <span className="font-medium">Inspector</span>
        <span className={cn('text-muted-foreground', errors > 0 && 'text-destructive')}>Console {p.console.length}{errors > 0 && ` (${String(errors)} error${errors === 1 ? '' : 's'})`}</span>
        <span className={cn('text-muted-foreground', failed > 0 && 'text-amber-500')}>Network {p.net.length}{failed > 0 && ` (${String(failed)} failed)`}</span>
      </button>
      {p.open && (
        <Tabs value={tab} onValueChange={pick} className="min-h-0 gap-0 px-2 pb-2" style={{ height: `${String(p.heightRem ?? 15)}rem` }}>
          <TabsList variant="line" className="h-8 shrink-0">
            <TabsTrigger value="console" className="h-7 text-xs">
              Console
            </TabsTrigger>
            <TabsTrigger value="network" className="h-7 text-xs">
              Network
            </TabsTrigger>
            <TabsTrigger value="cookies" className="h-7 text-xs">
              Cookies
            </TabsTrigger>
          </TabsList>
          <TabsContent value="console" className="flex min-h-0 flex-col">
            <ConsoleTab list={p.console} onClear={p.onClearConsole} />
          </TabsContent>
          <TabsContent value="network" className="flex min-h-0 flex-col">
            <NetworkTab list={p.net} onClear={p.onClearNet} />
          </TabsContent>
          <TabsContent value="cookies" className="flex min-h-0 flex-col">
            <CookiesTab {...p} />
          </TabsContent>
        </Tabs>
      )}
    </section>
  )
}

// Keeps a scroll box at the bottom while new rows arrive, unless the user scrolled up.
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [dep])
  const onScroll = () => {
    const el = ref.current
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  return { ref, onScroll }
}

function ConsoleTab({ list, onClear }: { list: readonly ConsoleEntry[]; onClear: () => void }) {
  const [text, setText] = useState('')
  const [levels, setLevels] = useState<ConsoleLevel[]>([])
  const shown = useMemo(() => filterConsole(list, { text, levels }), [list, text, levels])
  const scroll = useStickToBottom(shown.length)
  const toggle = (l: ConsoleLevel) => setLevels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 py-1">
        <Input aria-label="Filter console" placeholder="Filter" spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} className={cn(cell, 'max-w-60 flex-1')} />
        {CONSOLE_LEVELS.map((l) => (
          <Button key={l} type="button" size="xs" variant={levels.includes(l) ? 'secondary' : 'ghost'} aria-pressed={levels.includes(l)} aria-label={`Show ${l} messages`} onClick={() => toggle(l)}>
            {l}
          </Button>
        ))}
        <span className="flex-1" />
        <span className="text-muted-foreground text-xs">{shown.length === list.length ? list.length : `${String(shown.length)} of ${String(list.length)}`}</span>
        <Button type="button" size="xs" variant="outline" aria-label="Clear console" disabled={list.length === 0} onClick={onClear}>
          Clear
        </Button>
      </div>
      <div ref={scroll.ref} onScroll={scroll.onScroll} role="log" aria-label="Console messages" className="min-h-0 flex-1 overflow-y-auto rounded-md border font-mono text-xs">
        {shown.length === 0 && <p className="text-muted-foreground p-2 font-sans">{list.length === 0 ? 'Nothing logged on this page yet.' : 'No message matches the filter.'}</p>}
        {shown.map((e, i) => (
          <div key={`${String(e.at)}-${String(i)}`} className={cn('flex gap-2 border-b px-2 py-0.5 last:border-b-0', LEVEL_STYLE[e.level], e.level === 'error' && 'bg-destructive/5', e.level === 'warn' && 'bg-amber-500/5')}>
            <span className="text-muted-foreground shrink-0">{time(e.at)}</span>
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{e.text}</span>
            {e.url && (
              <span className="text-muted-foreground max-w-[30%] shrink-0 truncate" title={`${e.url}${e.line ? `:${String(e.line)}` : ''}`}>
                {e.url.split('/').pop() || e.url}
                {e.line ? `:${String(e.line)}` : ''}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function NetworkTab({ list, onClear }: { list: readonly NetEntry[]; onClear: () => void }) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const shown = useMemo(() => filterNet(list, { text, status }), [list, text, status])
  const scroll = useStickToBottom(shown.length)
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 py-1">
        <Input aria-label="Filter requests" placeholder="Filter by URL, method or type" spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} className={cn(cell, 'max-w-60 flex-1')} />
        {STATUS_FILTERS.map((s) => (
          <Button key={s} type="button" size="xs" variant={status === s ? 'secondary' : 'ghost'} aria-pressed={status === s} aria-label={`Show ${s === 'all' ? 'all' : s} requests`} onClick={() => setStatus(s)}>
            {s}
          </Button>
        ))}
        <span className="flex-1" />
        <span className="text-muted-foreground text-xs">{shown.length === list.length ? list.length : `${String(shown.length)} of ${String(list.length)}`}</span>
        <Button type="button" size="xs" variant="outline" aria-label="Clear network log" disabled={list.length === 0} onClick={onClear}>
          Clear
        </Button>
      </div>
      <div ref={scroll.ref} onScroll={scroll.onScroll} role="table" aria-label="Network requests" className="min-h-0 flex-1 overflow-y-auto rounded-md border text-xs">
        {shown.length === 0 && <p className="text-muted-foreground p-2">{list.length === 0 ? 'No requests on this page yet.' : 'No request matches the filter.'}</p>}
        {shown.map((e) => {
          const c = statusClass(e)
          return (
            <div key={e.id} role="row" className="hover:bg-accent/30 flex items-center gap-2 border-b px-2 py-0.5 last:border-b-0">
              <span role="cell" className="w-12 shrink-0 font-mono">
                {e.method}
              </span>
              <span role="cell" className={cn('w-14 shrink-0 font-mono', (c === 'failed' || c === '4xx' || c === '5xx') && 'text-destructive', c === '3xx' && 'text-amber-500', c === 'pending' && 'text-muted-foreground')}>
                {e.error ? 'failed' : (e.status ?? '...')}
              </span>
              <span role="cell" className="text-muted-foreground w-16 shrink-0 truncate">
                {e.type}
              </span>
              <span role="cell" className="min-w-0 flex-1 truncate font-mono" title={e.error ? `${e.url} (${e.error})` : e.url}>
                {e.url}
              </span>
              <span role="cell" className="text-muted-foreground w-16 shrink-0 text-right">
                {formatSize(e.size)}
              </span>
              <span role="cell" className="text-muted-foreground w-16 shrink-0 text-right">
                {formatDuration(e.durationMs)}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

type CookiePending = { kind: 'one'; cookie: CookieInfo } | { kind: 'site'; origin: string; count: number } | { kind: 'all' } | null

function CookiesTab(p: Props) {
  const [text, setText] = useState('')
  const [shownValues, setShownValues] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{ draft: CookieDraft; replacing?: CookieKey } | null>(null)
  const [pending, setPending] = useState<CookiePending>(null)
  const [error, setError] = useState<string | null>(null)

  const origin = originOf(p.currentUrl)
  const mine = useMemo(() => (origin ? cookiesForOrigin(p.cookies, origin) : []), [p.cookies, origin])
  const shown = useMemo(() => filterCookies(p.cookies, text), [p.cookies, text])
  const flip = (k: string) =>
    setShownValues((cur) => {
      const next = new Set(cur)
      if (!next.delete(k)) next.add(k)
      return next
    })
  const run = (job: Promise<unknown>) => {
    setError(null)
    job.catch((e) => setError(decodeIpcError(e).message))
  }
  const confirm = () => {
    const what = pending
    setPending(null)
    if (!what) return
    if (what.kind === 'one') run(p.onDeleteCookie(what.cookie))
    else if (what.kind === 'site') run(p.onClearSite(what.origin))
    else run(p.onClearAll())
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 py-1">
        <Input aria-label="Filter cookies" placeholder="Filter by name or domain" spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} className={cn(cell, 'max-w-60 flex-1')} />
        <Button type="button" size="xs" variant="outline" aria-label="Add cookie" onClick={() => setEditing({ draft: emptyCookieDraft(origin ? new URL(origin).hostname : '') })}>
          <Plus /> Add
        </Button>
        <span className="flex-1" />
        <span className="text-muted-foreground text-xs">
          {p.cookies.length} cookie{p.cookies.length === 1 ? '' : 's'} on {siteCount(p.cookies)} site{siteCount(p.cookies) === 1 ? '' : 's'}
        </span>
        <Button type="button" size="xs" variant="outline" aria-label="Clear data for this site" disabled={!origin} onClick={() => origin && setPending({ kind: 'site', origin, count: mine.length })}>
          Clear this site
        </Button>
        <Button type="button" size="xs" variant="outline" aria-label="Clear all site data" onClick={() => setPending({ kind: 'all' })}>
          Clear all
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive shrink-0 pb-1 text-xs">
          {error}
        </p>
      )}
      <div role="table" aria-label="Cookies" className="min-h-0 flex-1 overflow-y-auto rounded-md border text-xs">
        {shown.length === 0 && <p className="text-muted-foreground p-2">{p.cookies.length === 0 ? 'This project has no cookies.' : 'No cookie matches the filter.'}</p>}
        {shown.map((c) => {
          const k = cookieKey(c)
          const reveal = shownValues.has(k)
          return (
            <div key={k} role="row" className="hover:bg-accent/30 flex items-center gap-2 border-b px-2 py-0.5 last:border-b-0">
              <span role="cell" className="w-32 shrink-0 truncate font-mono" title={c.name}>
                {c.name}
              </span>
              <span role="cell" className="flex min-w-0 flex-1 items-center gap-1">
                <span className="min-w-0 truncate font-mono" title={reveal ? c.value : undefined}>
                  {maskValue(c.value, reveal) || <span className="text-muted-foreground">(empty)</span>}
                </span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={reveal ? `Hide value of ${c.name}` : `Show value of ${c.name}`} aria-pressed={reveal} title={reveal ? 'Hide value' : 'Show value'} onClick={() => flip(k)}>
                  {reveal ? <EyeOff /> : <Eye />}
                </Button>
              </span>
              <span role="cell" className="text-muted-foreground w-40 shrink-0 truncate" title={`${c.domain}${c.path}`}>
                {c.domain}
                {c.path}
              </span>
              <span role="cell" className="text-muted-foreground w-36 shrink-0 truncate">
                {c.expires === undefined ? 'Session' : new Date(c.expires * 1000).toLocaleString()}
              </span>
              <span role="cell" className="text-muted-foreground w-20 shrink-0 truncate" title={[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite !== 'unspecified' && `SameSite ${c.sameSite}`].filter(Boolean).join(', ')}>
                {[c.secure && 'S', c.httpOnly && 'H', c.sameSite === 'strict' ? 'strict' : c.sameSite === 'lax' ? 'lax' : c.sameSite === 'no_restriction' ? 'none' : ''].filter(Boolean).join(' ')}
              </span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Edit cookie ${c.name}`} title="Edit" onClick={() => setEditing({ draft: draftOfCookie(c), replacing: { name: c.name, domain: c.domain, path: c.path, secure: c.secure } })}>
                <Pencil />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete cookie ${c.name}`} title="Delete" onClick={() => setPending({ kind: 'one', cookie: c })}>
                <Trash2 />
              </Button>
            </div>
          )
        })}
      </div>

      {editing && <CookieDialog initial={editing.draft} replacing={editing.replacing} onClose={() => setEditing(null)} onSave={p.onSaveCookie} />}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'one' ? 'Delete cookie' : pending?.kind === 'site' ? 'Clear data for this site' : 'Clear all site data'}
        description={
          pending?.kind === 'one'
            ? `Delete 1 cookie: ${pending.cookie.name} (${pending.cookie.domain}${pending.cookie.path})?`
            : pending?.kind === 'site'
              ? `Delete ${String(pending.count)} cookie${pending.count === 1 ? '' : 's'} and the stored data of ${pending.origin}? You will be signed out of it.\nThe page cache is emptied for every site.`
              : `Delete ${String(p.cookies.length)} cookie${p.cookies.length === 1 ? '' : 's'} on ${String(siteCount(p.cookies))} site${siteCount(p.cookies) === 1 ? '' : 's'}, plus all stored site data and the cache of this project? Bookmarks and history are kept.`
        }
        confirmLabel={pending?.kind === 'one' ? 'Delete' : 'Clear'}
        danger
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (sec: number) => {
  const d = new Date(sec * 1000)
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function CookieDialog({ initial, replacing, onClose, onSave }: { initial: CookieDraft; replacing?: CookieKey; onClose: () => void; onSave: Props['onSaveCookie'] }) {
  const [d, setD] = useState<CookieDraft>(initial)
  const [showValue, setShowValue] = useState(replacing === undefined)
  const [session, setSession] = useState(initial.expires == null)
  const [when, setWhen] = useState(initial.expires != null ? toLocalInput(initial.expires) : toLocalInput(Date.now() / 1000 + 86_400))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const draft: CookieDraft = { ...d, expires: session ? null : Math.floor(new Date(when).getTime() / 1000) }
  const bad = validateCookieDraft(draft)
  const set = (patch: Partial<CookieDraft>) => setD((cur) => ({ ...cur, ...patch }))
  const save = () => {
    if (bad || busy) return
    setBusy(true)
    setError(null)
    onSave(draft, replacing).then(onClose, (e) => {
      setBusy(false)
      setError(decodeIpcError(e).message)
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') {
            e.preventDefault()
            save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{replacing ? 'Edit cookie' : 'Add cookie'}</DialogTitle>
          <DialogDescription>Changes apply to this project's browser straight away.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6">
          <div className="grid gap-1.5">
            <Label htmlFor="ck-name">Name</Label>
            <Input id="ck-name" autoFocus={!replacing} spellCheck={false} value={d.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ck-value">Value</Label>
            <div className="flex items-center gap-1">
              <Input id="ck-value" type={showValue ? 'text' : 'password'} spellCheck={false} autoComplete="off" value={d.value} onChange={(e) => set({ value: e.target.value })} />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={showValue ? 'Hide value' : 'Show value'} aria-pressed={showValue} onClick={() => setShowValue((v) => !v)}>
                {showValue ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ck-domain">Domain</Label>
              <Input id="ck-domain" spellCheck={false} value={d.domain} onChange={(e) => set({ domain: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ck-path">Path</Label>
              <Input id="ck-path" spellCheck={false} value={d.path} onChange={(e) => set({ path: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-primary size-4" checked={d.secure} onChange={(e) => set({ secure: e.target.checked })} />
              Secure
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-primary size-4" checked={d.httpOnly} onChange={(e) => set({ httpOnly: e.target.checked })} />
              HttpOnly
            </label>
            <label className="flex items-center gap-2">
              SameSite
              <select
                aria-label="SameSite"
                value={d.sameSite}
                onChange={(e) => set({ sameSite: e.target.value as CookieDraft['sameSite'] })}
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
              >
                <option value="unspecified">Not set</option>
                <option value="lax">Lax</option>
                <option value="strict">Strict</option>
                <option value="no_restriction">None</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-primary size-4" checked={session} onChange={(e) => setSession(e.target.checked)} />
              Session cookie
            </label>
            {!session && <Input aria-label="Expires" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 w-auto text-sm" />}
          </div>
          {(error ?? bad) && (
            <p role="alert" className="text-destructive text-xs">
              {error ?? bad}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={bad !== null || busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
