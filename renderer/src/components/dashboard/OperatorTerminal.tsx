import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { bridge } from '@/lib/bridge'

interface Props {
  // A session key: `operator:<id>` or `scratch:<id>`. A bare operator id (the drawer) is the same as `operator:<id>`.
  sessionKey?: string
  operatorId?: number
  // Tiles share the screen, so only the tile the user picks takes keyboard focus.
  autoFocus?: boolean
}

type Target = { kind: 'operator' | 'scratch'; id: number }

function parseKey(key: string): Target | null {
  const m = /^(operator|scratch):(\d+)$/.exec(key)
  return m ? { kind: m[1] as Target['kind'], id: Number(m[2]) } : null
}

// Attaches an xterm view to a running session: replays its buffer, then streams live output.
export function OperatorTerminal({ sessionKey, operatorId, autoFocus = true }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const key = sessionKey ?? (operatorId != null ? `operator:${operatorId}` : '')

  useEffect(() => {
    const el = host.current
    const target = parseKey(key)
    if (!el || !target) return
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

    const scratch = target.kind === 'scratch'
    let disposed = false
    let pending: string[] | null = []
    const onData = (id: number, data: string) => {
      if (id !== target.id) return
      if (pending) pending.push(data)
      else term.write(data)
    }
    const offData = scratch
      ? b.on('scratch:data', ({ scratchId, data }) => onData(scratchId, data))
      : b.on('operator:data', ({ operatorId: id, data }) => onData(id, data))
    // Live chunks that arrive before the replay finishes are written after it, so nothing is lost or reordered.
    const replay = scratch ? b.invoke('scratch:buffer', target.id) : b.invoke('operators:buffer', target.id)
    void replay.then((buf) => {
      if (disposed) return
      term.write(buf)
      for (const d of pending ?? []) term.write(d)
      pending = null
    })

    const input = term.onData((d) =>
      void (scratch ? b.invoke('scratch:write', target.id, d) : b.invoke('operators:write', target.id, d)),
    )
    const resize = () => {
      // A hidden or collapsed host measures zero; fitting then would shrink the PTY to nothing.
      if (el.clientWidth < 20 || el.clientHeight < 20) return
      fit.fit()
      void (scratch
        ? b.invoke('scratch:resize', target.id, term.cols, term.rows)
        : b.invoke('operators:resize', target.id, term.cols, term.rows))
    }
    const ro = new ResizeObserver(() => resize())
    ro.observe(el)
    resize()
    if (autoFocus) term.focus()

    return () => {
      disposed = true
      ro.disconnect()
      input.dispose()
      offData()
      term.dispose()
    }
  }, [key, autoFocus])

  return <div ref={host} className="h-full w-full bg-[#09090b] p-2" />
}
