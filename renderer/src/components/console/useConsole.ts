import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsoleLine, ConsoleProcess } from '@shared/console'
import { bridge } from '@/lib/bridge'

const KEEP = 2000

// The console feed: kept lines, the running background processes, and how many error lines arrived since it was last looked at.
export function useConsole(open: boolean) {
  const [lines, setLines] = useState<ConsoleLine[]>([])
  const [processes, setProcesses] = useState<ConsoleProcess[]>([])
  const [seenId, setSeenId] = useState(0)
  const lastId = useRef(0)
  const openRef = useRef(open)
  openRef.current = open

  const refreshProcesses = useCallback(() => {
    bridge()
      .invoke('console:processes')
      .then(setProcesses)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let live = true
    const b = bridge()
    let pending: ConsoleLine[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const batch = pending
      pending = []
      if (batch.length) setLines((prev) => [...prev, ...batch.filter((l) => l.id > (prev[prev.length - 1]?.id ?? 0))].slice(-KEEP))
      refreshProcesses()
    }
    const off = b.on('console:line', (l) => {
      pending.push(l)
      lastId.current = Math.max(lastId.current, l.id)
      timer ??= setTimeout(flush, 100)
    })
    b.invoke('console:list')
      .then((list) => {
        if (!live) return
        setLines((prev) => {
          const known = new Set(list.map((l) => l.id))
          return [...list, ...prev.filter((l) => !known.has(l.id))].slice(-KEEP)
        })
        if (list.length) lastId.current = Math.max(lastId.current, list[list.length - 1]!.id)
      })
      .catch(() => undefined)
    refreshProcesses()
    return () => {
      live = false
      off()
      if (timer) clearTimeout(timer)
    }
  }, [refreshProcesses])

  // While open everything counts as seen.
  useEffect(() => {
    if (open) setSeenId(lines[lines.length - 1]?.id ?? 0)
  }, [open, lines])

  const clear = useCallback((source?: ConsoleLine['source']) => {
    void bridge().invoke('console:clear', source)
    setLines((prev) => (source ? prev.filter((l) => l.source !== source) : []))
  }, [])

  const stop = useCallback(
    (pid: number) => {
      void bridge()
        .invoke('console:stop', pid)
        .then(refreshProcesses)
        .catch(() => undefined)
    },
    [refreshProcesses],
  )

  const errors = lines.reduce((n, l) => (l.error && l.id > seenId ? n + 1 : n), 0)
  return { lines, processes, errors, clear, stop, refreshProcesses }
}
