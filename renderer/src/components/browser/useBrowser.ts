import { useEffect, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BrowserAction, BrowserCapture, BrowserConfirm, BrowserDevTools, BrowserFound, BrowserHistoryEntry, BrowserNav, BrowserState, BrowserZoom } from '@shared/browser'
import { DEFAULT_EMULATION, type Bookmark, type CookieDraft, type CookieInfo, type CookieKey, type Emulation, type InspectLogs } from '@shared/browser-inspect'
import { EMPTY_PROMPTS_STATE, type BrowserPromptAnswer, type BrowserPromptsState } from '@shared/browser-prompts'
import { bridge } from '@/lib/bridge'
import { call } from '@/lib/queries'

const key = (crewId: number) => ['browser', crewId] as const

// The project's browser state; main pushes 'browser:state' on every change and the query is refreshed from it.
export function useBrowserState(crewId: number) {
  const qc = useQueryClient()
  useEffect(
    () =>
      bridge().on('browser:state', (s) => {
        if (s.crewId === crewId) qc.setQueryData(key(crewId), s)
        else void qc.invalidateQueries({ queryKey: key(s.crewId) })
      }),
    [crewId, qc],
  )
  return useQuery({ queryKey: key(crewId), queryFn: () => call('browser:state', crewId) })
}

export function useBrowserActions(crewId: number) {
  const qc = useQueryClient()
  const sync = (s?: BrowserState | void) => {
    if (s) qc.setQueryData(key(crewId), s)
    else void qc.invalidateQueries({ queryKey: key(crewId) })
  }
  const open = useMutation({ mutationFn: (url?: string) => call('browser:open', crewId, url), onSuccess: sync })
  const close = useMutation({ mutationFn: () => call('browser:close', crewId), onSuccess: () => sync() })
  const navigate = useMutation({ mutationFn: (v: { tabId: number; input: string }) => call('browser:navigate', crewId, v.tabId, v.input) })
  const nav = useMutation({ mutationFn: (v: { tabId: number; action: BrowserNav }) => call('browser:nav', crewId, v.tabId, v.action) })
  const tabNew = useMutation({ mutationFn: (url?: string) => call('browser:tabNew', crewId, url) })
  const tabClose = useMutation({ mutationFn: (tabId: number) => call('browser:tabClose', crewId, tabId) })
  const tabSelect = useMutation({ mutationFn: (tabId: number) => call('browser:tabSelect', crewId, tabId) })
  const control = useMutation({ mutationFn: (who: 'user' | 'ai') => call('browser:control', crewId, who), onSuccess: sync })
  const tabMove = useMutation({ mutationFn: (v: { tabId: number; to: number }) => call('browser:tabMove', crewId, v.tabId, v.to) })
  const tabDuplicate = useMutation({ mutationFn: (tabId: number) => call('browser:tabDuplicate', crewId, tabId) })
  const devtools = useMutation({ mutationFn: (v: { tabId: number; mode: BrowserDevTools }) => call('browser:devtools', crewId, v.tabId, v.mode) })
  const zoom = useMutation({ mutationFn: (v: { tabId: number; action: BrowserZoom }) => call('browser:zoom', crewId, v.tabId, v.action) })
  const find = useMutation({ mutationFn: (v: { tabId: number; text: string; forward: boolean; next: boolean }) => call('browser:find', crewId, v.tabId, v.text, v.forward, v.next) })
  const findStop = useMutation({ mutationFn: (tabId: number) => call('browser:findStop', crewId, tabId) })
  const viewSource = useMutation({ mutationFn: (tabId: number) => call('browser:viewSource', crewId, tabId) })
  const print = useMutation({ mutationFn: (tabId: number) => call('browser:print', crewId, tabId) })
  const savePdf = useMutation({ mutationFn: (tabId: number) => call('browser:savePdf', crewId, tabId) })
  const capture = useMutation({ mutationFn: (v: { tabId: number; opts: BrowserCapture }) => call('browser:capture', crewId, v.tabId, v.opts) })
  const confirmAnswer = useMutation({ mutationFn: (v: { id: string; allow: boolean; all?: boolean }) => call('browser:confirmAnswer', v.id, v.allow, v.all) })
  const allowAllStop = useMutation({ mutationFn: () => call('browser:allowAllStop', crewId) })
  const promptAnswer = useMutation({ mutationFn: (v: { id: string; answer: BrowserPromptAnswer }) => call('browser:promptAnswer', v.id, v.answer) })
  const downloadCancel = useMutation({ mutationFn: (id: string) => call('browser:downloadCancel', id) })
  const downloadOpen = useMutation({ mutationFn: (id: string) => call('browser:downloadOpen', id) })
  const downloadShow = useMutation({ mutationFn: (id: string) => call('browser:downloadShow', id) })
  const inspectClear = useMutation({ mutationFn: (v: { tabId: number; which: 'console' | 'net' | 'both' }) => call('browser:inspectClear', crewId, v.tabId, v.which) })
  const historyClear = useMutation({ mutationFn: () => call('browser:historyClear', crewId) })
  const popOut = useMutation({ mutationFn: () => call('browser:popOut', crewId) })
  const popIn = useMutation({ mutationFn: () => call('browser:popIn', crewId) })
  return {
    open,
    close,
    navigate,
    nav,
    tabNew,
    tabClose,
    tabSelect,
    control,
    tabMove,
    tabDuplicate,
    devtools,
    zoom,
    find,
    findStop,
    viewSource,
    print,
    savePdf,
    capture,
    confirmAnswer,
    allowAllStop,
    promptAnswer,
    downloadCancel,
    downloadOpen,
    downloadShow,
    inspectClear,
    historyClear,
    popOut,
    popIn,
  }
}

const actionsKey = (crewId: number) => ['browser-actions', crewId] as const

// What the AI did in the browser (oldest first): seeded once, then replaced by every browser:actions push.
export function useBrowserActionLog(crewId: number): readonly BrowserAction[] {
  const qc = useQueryClient()
  useEffect(
    () =>
      bridge().on('browser:actions', (a) => {
        if (a.crewId === crewId) qc.setQueryData(actionsKey(crewId), a.actions)
      }),
    [crewId, qc],
  )
  return useQuery({ queryKey: actionsKey(crewId), queryFn: () => call('browser:actions', crewId) }).data ?? NONE
}

const confirmsKey = (crewId: number) => ['browser-confirms', crewId] as const

// The AI's pending yes/no requests: seeded from main, added on browser:confirm, dropped on browser:confirmEnd.
export function useBrowserConfirms(crewId: number): readonly BrowserConfirm[] {
  const qc = useQueryClient()
  useEffect(() => {
    const k = confirmsKey(crewId)
    const offAdd = bridge().on('browser:confirm', (c) => {
      if (c.crewId !== crewId) return
      qc.setQueryData<BrowserConfirm[]>(k, (cur) => (cur?.some((x) => x.id === c.id) ? cur : [...(cur ?? []), c]))
    })
    const offEnd = bridge().on('browser:confirmEnd', (e) => {
      if (e.crewId === crewId) qc.setQueryData<BrowserConfirm[]>(k, (cur) => cur?.filter((x) => x.id !== e.id))
    })
    return () => {
      offAdd()
      offEnd()
    }
  }, [crewId, qc])
  return useQuery({ queryKey: confirmsKey(crewId), queryFn: () => call('browser:confirms', crewId) }).data ?? NONE
}

const promptsKey = (crewId: number) => ['browser-prompts', crewId] as const

// Page and network prompts (dialogs, permissions, logins, certificates) and the downloads, pushed on every change.
export function useBrowserPrompts(crewId: number): BrowserPromptsState {
  const qc = useQueryClient()
  useEffect(
    () =>
      bridge().on('browser:prompts', (s) => {
        if (s.crewId === crewId) qc.setQueryData(promptsKey(crewId), s)
      }),
    [crewId, qc],
  )
  return useQuery({ queryKey: promptsKey(crewId), queryFn: () => call('browser:promptsState', crewId) }).data ?? EMPTY_PROMPTS_STATE(crewId)
}

const inspectKey = (crewId: number, tabId: number | undefined) => ['browser-inspect', crewId, tabId] as const

// Console and network log of one tab. Main keeps them whether or not anyone looks; this only loads while `enabled`
// (the inspector is shown) and refreshes on the coalesced browser:inspectLogs push.
export function useInspectLogs(crewId: number, tabId: number | undefined, enabled: boolean): InspectLogs {
  const qc = useQueryClient()
  const on = enabled && tabId != null
  useEffect(() => {
    if (!on) return
    return bridge().on('browser:inspectLogs', (c) => {
      if (c.crewId === crewId && c.tabId === tabId) void qc.invalidateQueries({ queryKey: inspectKey(crewId, tabId) })
    })
  }, [on, crewId, tabId, qc])
  const q = useQuery({
    queryKey: inspectKey(crewId, tabId),
    queryFn: () => call('browser:inspectLogs', crewId, tabId as number),
    enabled: on,
    retry: false,
  })
  return q.data ?? NO_LOGS
}

const cookiesKey = (crewId: number) => ['browser-cookies', crewId] as const

// The project's cookies, loaded only while `enabled` (the Cookies tab shows; values never sit in the cache otherwise)
// and reloaded after each change made here.
export function useCookies(crewId: number, enabled: boolean) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: cookiesKey(crewId) })
  const list = useQuery({ queryKey: cookiesKey(crewId), queryFn: () => call('browser:cookies', crewId), enabled, staleTime: 0, gcTime: 0 })
  const save = useMutation({ mutationFn: (v: { draft: CookieDraft; replacing?: CookieKey }) => call('browser:cookieSet', crewId, v.draft, v.replacing), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (key: CookieKey) => call('browser:cookieRemove', crewId, key), onSuccess: refresh })
  const clearSite = useMutation({ mutationFn: (origin: string) => call('browser:clearSite', crewId, origin), onSuccess: refresh })
  const clearAll = useMutation({ mutationFn: () => call('browser:clearAll', crewId), onSuccess: refresh })
  return { cookies: list.data ?? NO_COOKIES, save, remove, clearSite, clearAll }
}

const emulationKey = (crewId: number, tabId: number | undefined) => ['browser-emulation', crewId, tabId] as const

// A tab's device emulation: seeded from main, and replaced by what main reports back after a change.
export function useEmulation(crewId: number, tabId: number | undefined) {
  const qc = useQueryClient()
  const get = useQuery({ queryKey: emulationKey(crewId, tabId), queryFn: () => call('browser:emulationGet', crewId, tabId as number), enabled: tabId != null, retry: false })
  const set = useMutation({
    mutationFn: (e: Emulation) => call('browser:emulationSet', crewId, tabId as number, e),
    onSuccess: (e) => qc.setQueryData(emulationKey(crewId, tabId), e),
  })
  return { emulation: get.data ?? DEFAULT_EMULATION, set }
}

const bookmarksKey = (crewId: number) => ['browser-bookmarks', crewId] as const

// The project's bookmarks: seeded from main, replaced by browser:bookmarks pushes and by each change's result.
export function useBookmarks(crewId: number) {
  const qc = useQueryClient()
  useEffect(
    () =>
      bridge().on('browser:bookmarks', (b) => {
        if (b.crewId === crewId) qc.setQueryData(bookmarksKey(crewId), b.entries)
      }),
    [crewId, qc],
  )
  const keep = (list: Bookmark[]) => qc.setQueryData(bookmarksKey(crewId), list)
  const list = useQuery({ queryKey: bookmarksKey(crewId), queryFn: () => call('browser:bookmarks', crewId) })
  const add = useMutation({ mutationFn: (v: { url: string; title: string }) => call('browser:bookmarkAdd', crewId, v.url, v.title), onSuccess: keep })
  const edit = useMutation({ mutationFn: (v: { id: string; patch: { url?: string; title?: string } }) => call('browser:bookmarkEdit', crewId, v.id, v.patch), onSuccess: keep })
  const remove = useMutation({ mutationFn: (id: string) => call('browser:bookmarkRemove', crewId, id), onSuccess: keep })
  return { bookmarks: list.data ?? NO_BOOKMARKS, add, edit, remove }
}

const NONE: never[] = []
const NO_COOKIES: CookieInfo[] = []
const NO_BOOKMARKS: Bookmark[] = []
const NO_LOGS: InspectLogs = { console: [], net: [] }

const historyKey = (crewId: number) => ['browser-history', crewId] as const

// The project's visited pages for address bar suggestions; main pushes the list after every visit.
export function useBrowserHistory(crewId: number): BrowserHistoryEntry[] {
  const qc = useQueryClient()
  useEffect(
    () =>
      bridge().on('browser:history', (h) => {
        if (h.crewId === crewId) qc.setQueryData(historyKey(crewId), h.entries)
      }),
    [crewId, qc],
  )
  return useQuery({ queryKey: historyKey(crewId), queryFn: () => call('browser:history', crewId) }).data ?? []
}

// Find in page result of one tab, pushed by main while the user types in the find bar.
export function useBrowserFound(crewId: number, tabId: number | undefined): BrowserFound | null {
  const [found, setFound] = useState<BrowserFound | null>(null)
  useEffect(() => {
    setFound(null)
    return bridge().on('browser:found', (f) => {
      if (f.crewId === crewId && f.tabId === tabId) setFound(f)
    })
  }, [crewId, tabId])
  return found
}

// Opens a project's browser tile (the sidebar button).
export const openBrowser = (crewId: number) => call('browser:open', crewId)

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
const overlayOpen = () => document.querySelector(OVERLAY) != null

// True while a dialog, menu or listbox is on screen: the native view would draw over it. Radix renders these in
// portals that are direct children of <body>, so watching its children is enough.
export function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(overlayOpen)
  useEffect(() => {
    const update = () => setOpen(overlayOpen())
    update()
    const mo = new MutationObserver(update)
    mo.observe(document.body, { childList: true })
    return () => mo.disconnect()
  }, [])
  return open
}

// Reports where the placeholder sits to main (browser:layout), and null while it must not show: an overlay is open,
// or the tile is hidden (another tile fullscreen, another view or page). Changes of size, position and visibility are
// pushed by observers, nothing polls.
export function useViewBounds(crewId: number, ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const overlay = useOverlayOpen()
  const show = enabled && !overlay
  useEffect(() => {
    const el = ref.current
    if (!el || !show) {
      void call('browser:layout', crewId, null).catch(() => undefined)
      return
    }
    let last = ''
    let frame = 0
    const send = () => {
      frame = 0
      const visible = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      const r = el.getBoundingClientRect()
      const rect = visible && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
      const sig = rect ? `${rect.x},${rect.y},${rect.w},${rect.h}` : 'null'
      if (sig === last) return
      last = sig
      void call('browser:layout', crewId, rect).catch(() => undefined)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send)
    }
    send()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    ro.observe(document.documentElement)
    // The frame slides into place with a transition, and a hidden tile gets the "invisible" class.
    const tile = el.closest<HTMLElement>('[data-tile]')
    const mo = new MutationObserver(schedule)
    if (tile) mo.observe(tile, { attributes: true, attributeFilter: ['class', 'style', 'data-fullscreen'] })
    tile?.addEventListener('transitionend', schedule)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      tile?.removeEventListener('transitionend', schedule)
      window.removeEventListener('resize', schedule)
      void call('browser:layout', crewId, null).catch(() => undefined)
    }
  }, [crewId, ref, show])
}

const allowAllKey = (crewId: number) => ['browser-allow-all', crewId] as const

// Whether "Allow all" is active for the project: seeded from main, then follows browser:allowAllChanged.
export function useAllowAll(crewId: number): boolean {
  const qc = useQueryClient()
  useEffect(
    () =>
      bridge().on('browser:allowAllChanged', (e) => {
        if (e.crewId === crewId) qc.setQueryData<boolean>(allowAllKey(crewId), e.active)
      }),
    [crewId, qc],
  )
  return useQuery({ queryKey: allowAllKey(crewId), queryFn: () => call('browser:allowAll', crewId) }).data ?? false
}
