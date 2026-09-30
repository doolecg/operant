import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { bridge } from '@/lib/bridge'

// Attaches an xterm view to a running operator: replays its buffer, then streams live output.
export function OperatorTerminal({ operatorId }: { operatorId: number }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const b = bridge()
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#3f3f46' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    let disposed = false
    let pending: string[] | null = []
    const offData = b.on('operator:data', ({ operatorId: id, data }) => {
      if (id !== operatorId) return
      if (pending) pending.push(data)
      else term.write(data)
    })
    // Live chunks that arrive before the replay finishes are written after it, so nothing is lost or reordered.
    void b.invoke('operators:buffer', operatorId).then((buf) => {
      if (disposed) return
      term.write(buf)
      for (const d of pending ?? []) term.write(d)
      pending = null
    })

    const input = term.onData((d) => void b.invoke('operators:write', operatorId, d))
    const resize = () => {
      fit.fit()
      void b.invoke('operators:resize', operatorId, term.cols, term.rows)
    }
    const ro = new ResizeObserver(() => resize())
    ro.observe(el)
    resize()
    term.focus()

    return () => {
      disposed = true
      ro.disconnect()
      input.dispose()
      offData()
      term.dispose()
    }
  }, [operatorId])

  return <div ref={host} className="h-full w-full bg-[#09090b] p-2" />
}
