import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Hand, Laptop, Lock, MoreVertical, Plus, RotateCw, Sparkles, TriangleAlert, X } from 'lucide-react'
import { matchHistory, type BrowserCapture, type BrowserTab } from '@shared/browser'
import { compatWarnings, DEFAULT_CREW_BROWSER } from '@shared/browser-compat'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { promptForTab } from '@shared/browser-prompts'
import { ActionTimeline } from './ActionTimeline'
import { BookmarksMenu } from './BookmarksMenu'
import { PoppedOutNotice } from './BrowserPopout'
import { ConfirmBar } from './ConfirmBar'
import { DownloadsMenu } from './DownloadsMenu'
import { EmulationMenu } from './EmulationMenu'
import { InspectPanel, type InspectTab } from './InspectPanel'
import { PromptBar } from './PromptBar'
import {
  useBookmarks,
  useBrowserActionLog,
  useBrowserActions,
  useAllowAll,
  useBrowserConfirms,
  useBrowserFound,
  useBrowserHistory,
  useBrowserPrompts,
  useBrowserState,
  useCookies,
  useEmulation,
  useInspectLogs,
  useViewBounds,
} from './useBrowser'

const tabTitle = (t: BrowserTab) => t.title || t.url || 'New tab'
const iconBtn = 'size-7 shrink-0'
const indicator = 'pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2'

// The project's browser: tabs, back/forward/reload, the address bar, and a placeholder that the native view (made in
// main) is laid over. The AI pill shows while an AI tool drives the page; Take control pauses it. `popout` is set in the
// pop-out window itself, where the page is shown even though the browser counts as popped out.
export function BrowserTile({ crewId, popout = false }: { crewId: number; popout?: boolean }) {
  const state = useBrowserState(crewId).data
  const act = useBrowserActions(crewId)
  const holder = useRef<HTMLDivElement>(null)
  const history = useBrowserHistory(crewId)
  const actions = useBrowserActionLog(crewId)
  const confirms = useBrowserConfirms(crewId)
  const allowAll = useAllowAll(crewId)
  const prompts = useBrowserPrompts(crewId)
  const bm = useBookmarks(crewId)
  const warn = compatWarnings(useSettings().data?.browser.perCrew[String(crewId)] ?? DEFAULT_CREW_BROWSER)

  const tab = state?.tabs.find((t) => t.id === state.activeTabId) ?? state?.tabs[0]
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState(-1)
  const [dragId, setDragId] = useState<number | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const found = useBrowserFound(crewId, tab?.id)
  // The inspector: `inspect` mounts it, `inspectOpen` expands it, and the cookies load only on its Cookies tab.
  const [inspect, setInspect] = useState(false)
  const [inspectOpen, setInspectOpen] = useState(true)
  const [inspectTab, setInspectTab] = useState<InspectTab>('console')
  const logs = useInspectLogs(crewId, tab?.id, inspect)
  const ck = useCookies(crewId, inspect && inspectOpen && inspectTab === 'cookies')
  const emu = useEmulation(crewId, tab?.id)
  useEffect(() => {
    setDraft(null)
    setPick(-1)
  }, [tab?.id, tab?.url])
  useEffect(() => {
    setFindOpen(false)
    setFindText('')
  }, [tab?.id])

  // The suggestions are drawn over the page area, so the native view steps aside while they show.
  const suggestions = draft != null && draft.trim() !== '' ? matchHistory(history, draft) : []
  const away = state?.poppedOut === true && !popout
  useViewBounds(crewId, holder, state?.open === true && !away && suggestions.length === 0)

  const run = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e) => setError(decodeIpcError(e).message))
  }

  const ai = state?.ai
  const paused = ai?.paused === true
  const aiBusy = ai?.active === true && !paused
  const showPill = state?.aiAllowed === true && (aiBusy || paused)

  const submit = (input?: string) => {
    const text = input ?? draft
    if (!tab || text == null) return
    run(act.navigate.mutateAsync({ tabId: tab.id, input: text }))
    setDraft(null)
  }
  // The menu closing hands the area back to the native view a moment later; actions that read the view wait for it.
  const afterMenu = (fn: () => Promise<unknown>) => void setTimeout(() => run(fn()), 250)
  const capture = (opts: BrowserCapture) => tab && afterMenu(() => act.capture.mutateAsync({ tabId: tab.id, opts }))
  const closeFind = () => {
    setFindOpen(false)
    if (tab) run(act.findStop.mutateAsync(tab.id))
  }
  const doFind = (text: string, forward: boolean, next: boolean) => {
    if (tab) run(act.find.mutateAsync({ tabId: tab.id, text, forward, next }))
  }
  const zoom = tab?.zoom ?? 100
  const secure = tab?.secure
  const shown = draft ?? tab?.url ?? ''

  return (
    <div className={cn('flex h-full min-h-0 flex-col rounded-2xl', aiBusy && 'ring-primary/60 ring-2 ring-inset')}>
      <div role="tablist" aria-label="Browser tabs" className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1">
        {state?.tabs.map((t) => {
          const active = t.id === tab?.id
          return (
            <div
              key={t.id}
              draggable
              onDragStart={(e) => {
                setDragId(t.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', String(t.id))
              }}
              onDragOver={(e) => {
                if (dragId != null) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                const to = state.tabs.findIndex((x) => x.id === t.id)
                if (dragId != null && to >= 0 && dragId !== t.id) run(act.tabMove.mutateAsync({ tabId: dragId, to }))
                setDragId(null)
              }}
              onDragEnd={() => setDragId(null)}
              className={cn(
                'group flex h-7 max-w-44 min-w-24 items-center rounded-md border text-xs transition-colors',
                dragId === t.id && 'opacity-50',
                active ? 'bg-accent text-accent-foreground border-transparent' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground border-transparent',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={t.url}
                onClick={() => run(act.tabSelect.mutateAsync(t.id))}
                className="min-w-0 flex-1 truncate py-1 pr-1 pl-2 text-left outline-none"
              >
                {tabTitle(t)}
              </button>
              <button
                type="button"
                aria-label={`Close tab ${tabTitle(t)}`}
                title="Close tab"
                onClick={() => run(act.tabClose.mutateAsync(t.id))}
                className="hover:bg-foreground/10 mr-1 grid size-5 shrink-0 place-items-center rounded-full"
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
        <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="New tab" title="New tab" onClick={() => run(act.tabNew.mutateAsync(undefined))}>
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div
        className="flex shrink-0 items-center gap-1 px-2 pb-1.5"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && aiBusy) {
            e.preventDefault()
            run(act.control.mutateAsync('user'))
          }
        }}
      >
        <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="Back" title="Back" disabled={!tab?.canGoBack} onClick={() => tab && run(act.nav.mutateAsync({ tabId: tab.id, action: 'back' }))}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="Forward" title="Forward" disabled={!tab?.canGoForward} onClick={() => tab && run(act.nav.mutateAsync({ tabId: tab.id, action: 'forward' }))}>
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={iconBtn}
          aria-label="Reload"
          title={tab?.loading ? 'Stop' : 'Reload (Shift: hard reload)'}
          disabled={!tab}
          onClick={(e) => tab && run(act.nav.mutateAsync({ tabId: tab.id, action: tab.loading ? 'stop' : e.shiftKey ? 'hardReload' : 'reload' }))}
        >
          {tab?.loading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
        </Button>
        {(warn.relaxCors || warn.ignoreCerts) && (
          <span
            role="status"
            aria-label="Site safety relaxed"
            title={[warn.relaxCors && 'Relax CORS is on', warn.ignoreCerts && 'Certificate errors are ignored on every site'].filter(Boolean).join('. ')}
            className="text-destructive border-destructive/40 flex shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] leading-6"
          >
            <TriangleAlert className="size-3" />
            {[warn.relaxCors && 'CORS relaxed', warn.ignoreCerts && 'Certs ignored'].filter(Boolean).join(', ')}
          </span>
        )}
        <div className="relative min-w-0 flex-1">
          {secure === 'secure' && <Lock role="img" aria-label="Secure connection" className={cn(indicator, 'text-muted-foreground')} />}
          {secure === 'insecure' && <TriangleAlert role="img" aria-label="Not secure" className={cn(indicator, 'text-destructive')} />}
          {secure === 'local' && <Laptop role="img" aria-label="Local site" className={cn(indicator, 'text-muted-foreground')} />}
          <Input
            aria-label="Address"
            spellCheck={false}
            autoComplete="off"
            placeholder="Search or enter an address"
            value={shown}
            disabled={!tab}
            onChange={(e) => {
              setDraft(e.target.value)
              setPick(-1)
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit(pick >= 0 ? suggestions[pick]?.url : undefined)
              else if (e.key === 'ArrowDown' && suggestions.length > 0) {
                e.preventDefault()
                setPick((pick + 1) % suggestions.length)
              } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
                e.preventDefault()
                setPick(pick <= 0 ? suggestions.length - 1 : pick - 1)
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                setDraft(null)
              }
            }}
            className={cn('h-7 text-xs', secure && secure !== 'unknown' && 'pl-6')}
          />
          {suggestions.length > 0 && (
            <div role="group" aria-label="Address suggestions" className="bg-popover text-popover-foreground absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-xl border p-1 shadow-md">
              {suggestions.map((h, i) => (
                <button
                  key={h.url}
                  type="button"
                  aria-label={`Open ${h.title || h.url}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    submit(h.url)
                  }}
                  className={cn('flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs', i === pick ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50')}
                >
                  <span className="max-w-[45%] shrink-0 truncate">{h.title || h.url}</span>
                  <span className="text-muted-foreground min-w-0 truncate">{h.url}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {zoom !== 100 && tab && (
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" aria-label="Reset zoom" title="Reset zoom" onClick={() => run(act.zoom.mutateAsync({ tabId: tab.id, action: 'reset' }))}>
            {zoom}%
          </Button>
        )}
        <EmulationMenu emulation={emu.emulation} disabled={!tab} onChange={(e) => run(emu.set.mutateAsync(e))} />
        <BookmarksMenu
          currentUrl={tab?.url ?? ''}
          currentTitle={tab?.title ?? ''}
          bookmarks={bm.bookmarks}
          history={history}
          disabled={!tab}
          onOpen={(url) => tab && run(act.navigate.mutateAsync({ tabId: tab.id, input: url }))}
          onAdd={(url, title) => run(bm.add.mutateAsync({ url, title }))}
          onEdit={(id, patch) => run(bm.edit.mutateAsync({ id, patch }))}
          onRemove={(id) => run(bm.remove.mutateAsync(id))}
          onClearHistory={() => run(act.historyClear.mutateAsync())}
        />
        <DownloadsMenu
          downloads={prompts.downloads}
          onOpen={(id) => run(act.downloadOpen.mutateAsync(id))}
          onShowInFolder={(id) => run(act.downloadShow.mutateAsync(id))}
          onCancel={(id) => run(act.downloadCancel.mutateAsync(id))}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="Browser menu" title="More" disabled={!tab}>
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          {tab && (
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onSelect={() => run(act.tabDuplicate.mutateAsync(tab.id))}>Duplicate tab</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(act.nav.mutateAsync({ tabId: tab.id, action: 'hardReload' }))}>Hard reload</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(navigator.clipboard.writeText(tab.url))}>Copy URL</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs">Zoom {zoom}%</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => run(act.zoom.mutateAsync({ tabId: tab.id, action: 'in' }))}>Zoom in</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(act.zoom.mutateAsync({ tabId: tab.id, action: 'out' }))}>Zoom out</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(act.zoom.mutateAsync({ tabId: tab.id, action: 'reset' }))}>Reset zoom</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setFindOpen(true)}>Find in page</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(act.viewSource.mutateAsync(tab.id))}>View source</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => afterMenu(() => act.print.mutateAsync(tab.id))}>Print</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => afterMenu(() => act.savePdf.mutateAsync(tab.id))}>Save as PDF</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Screenshot</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => capture({ fullPage: false, to: 'clipboard' })}>Visible area to clipboard</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => capture({ fullPage: false, to: 'file' })}>Visible area to file</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => capture({ fullPage: true, to: 'clipboard' })}>Full page to clipboard</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => capture({ fullPage: true, to: 'file' })}>Full page to file</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuCheckboxItem
                checked={inspect}
                onCheckedChange={(on) => {
                  setInspect(on)
                  if (on) setInspectOpen(true)
                  setInspectTab('console')
                }}
              >
                Inspect
              </DropdownMenuCheckboxItem>
              {!popout && <DropdownMenuItem onSelect={() => run(act.popOut.mutateAsync())}>Pop out</DropdownMenuItem>}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Developer tools</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => run(act.devtools.mutateAsync({ tabId: tab.id, mode: 'dock' }))}>Docked</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => run(act.devtools.mutateAsync({ tabId: tab.id, mode: 'detach' }))}>Separate window</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => run(act.devtools.mutateAsync({ tabId: tab.id, mode: 'close' }))}>Close</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          )}
        </DropdownMenu>
        {showPill && (
          <div
            role="status"
            className={cn('flex h-7 max-w-[55%] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs', paused ? 'text-muted-foreground' : 'border-primary/60 bg-primary/10 text-foreground')}
          >
            {paused ? <Hand aria-hidden className="size-3 shrink-0" /> : <Sparkles aria-hidden className="text-primary size-3 shrink-0" />}
            <span className="min-w-0 truncate">{paused ? 'You have control' : `AI is controlling${ai?.lastAction ? ` · ${ai.lastAction}` : ''}`}</span>
            {paused ? (
              <Button type="button" size="sm" className="h-5 rounded-full px-2 text-xs" aria-label="Let AI continue" onClick={() => run(act.control.mutateAsync('ai'))}>
                Let AI continue
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" className="h-5 rounded-full px-2 text-xs" aria-label="Take control" onClick={() => run(act.control.mutateAsync('user'))}>
                Take control
              </Button>
            )}
          </div>
        )}
      </div>

      {findOpen && tab && (
        <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
          <Input
            aria-label="Find in page"
            placeholder="Find in page"
            spellCheck={false}
            autoComplete="off"
            value={findText}
            autoFocus
            onChange={(e) => {
              setFindText(e.target.value)
              doFind(e.target.value, true, false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doFind(findText, !e.shiftKey, true)
              else if (e.key === 'Escape') {
                e.stopPropagation()
                closeFind()
              }
            }}
            className="h-7 flex-1 text-xs"
          />
          <span aria-live="polite" className="text-muted-foreground w-14 shrink-0 text-center text-xs">
            {findText ? `${found?.active ?? 0}/${found?.matches ?? 0}` : ''}
          </span>
          <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="Previous match" title="Previous match" disabled={!findText} onClick={() => doFind(findText, false, true)}>
            <ChevronUp className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="Next match" title="Next match" disabled={!findText} onClick={() => doFind(findText, true, true)}>
            <ChevronDown className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className={iconBtn} aria-label="Close find" title="Close find" onClick={closeFind}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-destructive shrink-0 px-3 pb-1 text-xs">
          {error}
        </p>
      )}
      <ConfirmBar requests={confirms} allowAll={allowAll} onAnswer={(id, allow, all) => run(act.confirmAnswer.mutateAsync({ id, allow, all }))} onStopAllowAll={() => run(act.allowAllStop.mutateAsync())} />
      <PromptBar
        prompt={promptForTab(prompts.prompts, tab?.id)}
        more={Math.max(0, prompts.prompts.filter((p) => p.tabId === tab?.id).length - 1)}
        onAnswer={(id, answer) => run(act.promptAnswer.mutateAsync({ id, answer }))}
      />
      <ActionTimeline actions={actions} />
      <div ref={holder} data-testid="browser-view" className="min-h-0 flex-1">
        {away && <PoppedOutNotice onPopIn={() => run(act.popIn.mutateAsync())} />}
      </div>
      {inspect && tab && (
        <InspectPanel
          open={inspectOpen}
          onOpenChange={setInspectOpen}
          console={logs.console}
          net={logs.net}
          cookies={ck.cookies}
          currentUrl={tab.url}
          onTabChange={setInspectTab}
          onClearConsole={() => run(act.inspectClear.mutateAsync({ tabId: tab.id, which: 'console' }))}
          onClearNet={() => run(act.inspectClear.mutateAsync({ tabId: tab.id, which: 'net' }))}
          onSaveCookie={(draft, replacing) => ck.save.mutateAsync({ draft, replacing })}
          onDeleteCookie={(key) => ck.remove.mutateAsync(key)}
          onClearSite={(origin) => ck.clearSite.mutateAsync(origin)}
          onClearAll={() => ck.clearAll.mutateAsync()}
        />
      )}
    </div>
  )
}
