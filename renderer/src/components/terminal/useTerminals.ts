import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeIpcError } from '@shared/ipc'
import type { Crew } from '@shared/types'
import { bridge } from '@/lib/bridge'
import { toast } from '@/lib/toast'

export interface TerminalTab {
  scratchId: number
  crewId: number
  title: string
  kind: 'shell' | 'agent'
  exited: boolean
}

// The tabs of the terminal drawer. Each is a scratch terminal of its project (cwd = the project folder), so the
// session, its output buffer and its resize all use the existing scratch:* calls.
export function useTerminals(crews: Crew[] | undefined, defaultModel: string) {
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [active, setActive] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const swept = useRef(false)

  // Shell tiles left behind by an earlier run have no session any more; drop them once.
  useEffect(() => {
    if (!crews || swept.current) return
    swept.current = true
    const b = bridge()
    void Promise.all(
      crews.map(async (c) => {
        for (const s of await b.invoke('scratch:list', c.id)) {
          if (s.agent === 'shell' && !(await b.invoke('scratch:status', s.id)).running) await b.invoke('scratch:delete', s.id)
        }
      }),
    ).catch(() => {})
  }, [crews])

  useEffect(
    () =>
      bridge().on('scratch:exit', ({ scratchId }) =>
        setTabs((t) => t.map((x) => (x.scratchId === scratchId ? { ...x, exited: true } : x))),
      ),
    [],
  )

  const openTab = useCallback(
    async (crew: Crew, kind: 'shell' | 'agent') => {
      const b = bridge()
      let scratchId: number | null = null
      try {
        const title = kind === 'shell' ? `Shell: ${crew.name}` : `Claude: ${crew.name}`
        const row = await b.invoke('scratch:create', {
          crewId: crew.id,
          title,
          agent: kind === 'shell' ? 'shell' : 'claude',
          ...(kind === 'agent' ? { model: defaultModel } : {}),
        })
        scratchId = row.id
        await b.invoke('scratch:start', row.id)
        setTabs((t) => [...t, { scratchId: row.id, crewId: crew.id, title, kind, exited: false }])
        setActive(row.id)
        setOpen(true)
      } catch (e) {
        if (scratchId != null) void b.invoke('scratch:delete', scratchId).catch(() => {})
        toast(`Could not open the terminal: ${decodeIpcError(e).message}`, true)
      }
    },
    [defaultModel],
  )

  const closeTab = useCallback((scratchId: number) => {
    void bridge().invoke('scratch:delete', scratchId).catch(() => {})
    setTabs((t) => {
      const next = t.filter((x) => x.scratchId !== scratchId)
      setActive((a) => (a === scratchId ? (next.at(-1)?.scratchId ?? null) : a))
      if (next.length === 0) setOpen(false)
      return next
    })
  }, [])

  // A deleted project takes its tiles with it (the main process stops them).
  const dropCrew = useCallback((crewId: number) => {
    setTabs((t) => {
      const next = t.filter((x) => x.crewId !== crewId)
      setActive((a) => (next.some((x) => x.scratchId === a) ? a : (next.at(-1)?.scratchId ?? null)))
      if (next.length === 0) setOpen(false)
      return next
    })
  }, [])

  return { tabs, active, setActive, open, setOpen, openTab, closeTab, dropCrew }
}
