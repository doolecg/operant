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
  // A session key: `scratch:<id>`.
  sessionKey: string
  // Tiles share the screen, so only the tile the user picks takes keyboard focus.
  autoFocus?: boolean
  // The project, for opening file paths from the output (Ctrl+click); without it paths are not links.
  crewId?: number
  // The agent CLI in this terminal; Claude Code reads Alt+V for a pasted image.
  cli?: string
}

function parseKey(key: string): number | null {
  const m = /^scratch:(\d+)$/.exec(key)
  return m ? Number(m[1]) : null
}

// Attaches an xterm view to a running session: replays its buffer, then streams live output.
export function OperatorTerminal({ sessionKey, autoFocus = true, crewId, cli = 'claude' }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const colors = useTerminalColors()
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const termRef = useRef<Terminal | null>(null)
  // Fits the open terminal to its host and sends the new size to the PTY (set while a session is attached).
  const refitRef = useRef<(() => void) | null>(null)
  const settings = useSettings().data
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const propsRef = useRef({ crewId, cli })
  propsRef.current = { crewId, cli }
  const key = sessionKey

  useEffect(() => {
    const el = host.current
    const scratchId = parseKey(key)
    if (!el || scratchId == null) return
    const b = bridge()
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
      lineHeight: 1.2,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      fontSize: settingsRef.current?.terminal.fontSize ?? 13,
      scrollback: settingsRef.current?.terminal.scrollback ?? 5000,
      theme: colorsRef.current,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    let disposed = false
    let pending: string[] | null = []
    const offData = b.on('scratch:data', ({ scratchId: id, data }) => {
      if (id !== scratchId) return
      if (pending) pending.push(data)
      else term.write(data)
    })
    // Live chunks that arrive before the replay finishes are written after it, so nothing is lost or reordered.
    const replay = b.invoke('scratch:buffer', scratchId)
    void replay.then((buf) => {
      if (disposed) return
      term.write(buf)
      for (const d of pending ?? []) term.write(d)
      pending = null
    })

    const input = term.onData((d) => void b.invoke('scratch:write', scratchId, d))
    const send = (d: string) => void b.invoke('scratch:write', scratchId, d)
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
    // Any change to the host's box (a tile move or resize, the info bar, the Mods panel, the zoom) refits it, once per
    // frame, and the PTY gets the new rows and columns whenever they change. A hidden or collapsed host measures zero;
    // fitting then would shrink the PTY to nothing.
    let frame = 0
    let sent = ''
    const sync = () => {
      frame = 0
      if (disposed || el.clientWidth < 20 || el.clientHeight < 20) return
      fit.fit()
      const size = `${term.cols}x${term.rows}`
      if (size === sent) return
      sent = size
      void b.invoke('scratch:resize', scratchId, term.cols, term.rows)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync)
    }
    refitRef.current = schedule
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    sync()
    if (autoFocus) term.focus()

    return () => {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      refitRef.current = null
      ro.disconnect()
      input.dispose()
      links.dispose()
      el.removeEventListener('mouseup', onUp)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('drop', onDrop)
      offData()
      term.dispose()
      termRef.current = null
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
    refitRef.current?.()
  }, [fontSize, scrollback])

  // The padding sits on the wrapper, not on the host xterm fits: FitAddon measures the host's full height, so padding on
  // it made the terminal one or two rows taller than its box and the last row was clipped at the tile's edge. The wrapper
  // pads 12px at the sides and 8px above and below; the host itself must stay unpadded.
  return (
    <div className="flex h-full w-full flex-col" style={{ backgroundColor: colors.background }}>
      <div className="op-term min-h-0 w-full flex-1 px-3 py-2" style={{ backgroundColor: colors.background }}>
        <div ref={host} className="h-full w-full" />
      </div>
    </div>
  )
}
