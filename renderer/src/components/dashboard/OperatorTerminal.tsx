import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { bridge } from '@/lib/bridge'
import { matches } from '@/lib/keys'
import { useSettings } from '@/lib/queries'
import { useTerminalColors } from '@/lib/theme'
import { toast } from '@/lib/toast'
import { decideTermKey, dropText, findFileLinks, imagePasteBytes } from '@shared/terminal-keys'

interface Props {
  // A session key: `operator:<id>` or `scratch:<id>`. A bare operator id (the drawer) is the same as `operator:<id>`.
  sessionKey?: string
  operatorId?: number
  // Tiles share the screen, so only the tile the user picks takes keyboard focus.
  autoFocus?: boolean
  // The project, for opening file paths from the output (Ctrl+click); without it paths are not links.
  crewId?: number
  // The agent CLI in this terminal; Claude Code reads Alt+V for a pasted image.
  cli?: string
}

type Target = { kind: 'operator' | 'scratch'; id: number }

function parseKey(key: string): Target | null {
  const m = /^(operator|scratch):(\d+)$/.exec(key)
  return m ? { kind: m[1] as Target['kind'], id: Number(m[2]) } : null
}

// Attaches an xterm view to a running session: replays its buffer, then streams live output.
export function OperatorTerminal({ sessionKey, operatorId, autoFocus = true, crewId, cli = 'claude' }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const colors = useTerminalColors()
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const settings = useSettings().data
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const propsRef = useRef({ crewId, cli })
  propsRef.current = { crewId, cli }
  const key = sessionKey ?? (operatorId != null ? `operator:${operatorId}` : '')

  useEffect(() => {
    const el = host.current
    const target = parseKey(key)
    if (!el || !target) return
    const b = bridge()
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace",
      fontSize: settingsRef.current?.terminal.fontSize ?? 13,
      scrollback: settingsRef.current?.terminal.scrollback ?? 5000,
      theme: colorsRef.current,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    fitRef.current = fit
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
    const send = (d: string) =>
      void (scratch ? b.invoke('scratch:write', target.id, d) : b.invoke('operators:write', target.id, d))
    const isMac = b.platform === 'darwin'
    // An image on the clipboard (and no text) goes through as the CLI's image-paste key, so the agent reads it itself.
    const pasteClipboard = async () => {
      let text = ''
      try {
        text = await navigator.clipboard.readText()
      } catch {
        /* clipboard not readable as text */
      }
      if (text) return term.paste(text)
      let img = false
      try {
        img = (await b.invoke('clipboard:hasImage')) as boolean
      } catch {
        /* no image */
      }
      if (img) send(imagePasteBytes(isMac, propsRef.current.cli === 'claude'))
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const binds = settingsRef.current?.keybinds
      const action = decideTermKey({
        mac: isMac,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        code: e.code,
        hasSelection: term.hasSelection(),
        live: true,
        bound: !!binds && Object.values(binds).some((a) => matches(e, a)),
      })
      if (action === 'copy') {
        void navigator.clipboard.writeText(term.getSelection())
        if (!isMac) term.clearSelection()
        return false
      }
      if (action === 'paste') {
        e.preventDefault()
        void pasteClipboard()
        return false
      }
      return action !== 'app'
    })
    // Copy once when the drag ends, not on every selection tick.
    const onUp = () => {
      if (settingsRef.current?.terminal.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
    }
    el.addEventListener('mouseup', onUp)
    // A file path in the output is a link: Ctrl+click (Cmd on macOS) opens it, inside the project folder only.
    const links = term.registerLinkProvider({
      provideLinks(y, done) {
        const id = propsRef.current.crewId
        if (id == null || !settingsRef.current?.terminal.fileLinks) return done(undefined)
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const found = findFileLinks(text)
        done(
          found.length
            ? found.map((l) => ({
                text: l.text,
                range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
                decorations: { underline: true, pointerCursor: true },
                activate: (ev: MouseEvent) => {
                  if (!(isMac ? ev.metaKey : ev.ctrlKey)) return
                  b.invoke('shell:openPath', id, l.path).catch((err: unknown) => toast(err instanceof Error ? err.message : 'Could not open it', true))
                },
              }))
            : undefined,
        )
      },
    })
    // Dropping files (from Explorer or the sidebar) types their paths into this terminal.
    const onOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      if (!settingsRef.current?.terminal.dropPaths) return
      const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => b.filePath(f))
      const text = dropText(paths)
      if (text) term.paste(text)
    }
    el.addEventListener('dragover', onOver)
    el.addEventListener('drop', onDrop)
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
      links.dispose()
      el.removeEventListener('mouseup', onUp)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('drop', onDrop)
      offData()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [key, autoFocus])

  // A theme change restyles the open terminal; its text and scrollback stay.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = colors
  }, [colors])

  // Font size and scrollback apply live to the open terminal.
  const fontSize = settings?.terminal.fontSize
  const scrollback = settings?.terminal.scrollback
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (fontSize) term.options.fontSize = fontSize
    if (scrollback) term.options.scrollback = scrollback
    try {
      fitRef.current?.fit()
    } catch {
      /* hidden host */
    }
  }, [fontSize, scrollback])

  return <div ref={host} className="h-full w-full p-2" style={{ backgroundColor: colors.background }} />
}
