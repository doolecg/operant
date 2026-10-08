import { memo, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy } from 'lucide-react'
import { parseMarkdown, sectionize, type Align, type Block, type Inline, type MdSection } from '@shared/markdown'
import { bridge } from '@/lib/bridge'
import { cn } from '@/lib/utils'

// Renders Markdown as React elements only (nothing is injected as HTML). Links open through the app's external-link
// call and never navigate this window; images are not loaded.

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      rel="noreferrer noopener"
      title={href}
      className="text-link underline underline-offset-2 break-all"
      onClick={(e) => {
        e.preventDefault()
        void bridge().invoke('app:openExternal', href)
      }}
    >
      {children}
    </a>
  )
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return n.v
          case 'br':
            return <br key={i} />
          case 'code':
            return (
              <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em] break-words">
                {n.v}
              </code>
            )
          case 'strong':
            return (
              <strong key={i} className="font-semibold">
                <Inlines nodes={n.c} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            )
          case 'del':
            return (
              <del key={i} className="opacity-70">
                <Inlines nodes={n.c} />
              </del>
            )
          case 'link':
            return (
              <Link key={i} href={n.href}>
                <Inlines nodes={n.c} />
              </Link>
            )
        }
      })}
    </>
  )
}

// A small copy button that flips to "Copied" for a moment.
export function CopyTextButton({ text, label = 'Copy', ariaLabel, className }: { text: string; label?: string; ariaLabel?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      onClick={copy}
      className={cn('hover:bg-accent hover:text-foreground flex items-center gap-1 rounded px-1.5 py-0.5', className)}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

function CodeBlock({ lang, v, doc }: { lang: string; v: string; doc: boolean }) {
  return (
    <div className="bg-muted/60 group relative rounded-md border" data-md="code">
      <div className="text-muted-foreground flex items-center justify-between px-2 pt-1 text-[10px]">
        <span className="font-mono">{lang}</span>
        <CopyTextButton text={v} ariaLabel="Copy code" />
      </div>
      <pre tabIndex={0} className={cn('overflow-x-auto px-3 pt-1 pb-2 font-mono leading-relaxed whitespace-pre', doc ? 'text-[13px]' : 'text-xs')}>
        {v}
      </pre>
    </div>
  )
}

const alignClass = (a: Align) => (a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left')
const headingClass = ['', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs', 'text-xs']
// Document variant: h1 22, h2 18, h3 16, with room above.
const docHeadingClass = ['', 'mt-8 border-b pb-1.5 text-[22px] leading-tight', 'mt-7 text-[18px] leading-snug', 'mt-5 text-base', 'mt-4 text-[15px]', 'mt-4 text-sm', 'mt-4 text-sm']

function Blocks({ blocks, doc = false, flat = false }: { blocks: Block[]; doc?: boolean; flat?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'heading': {
            const H = `h${Math.min(b.level + 2, 6)}` as 'h3'
            return (
              <H key={i} className={cn('font-semibold break-words', doc ? docHeadingClass[b.level] : headingClass[b.level], doc && (flat || i === 0) && 'mt-0')}>
                <Inlines nodes={b.c} />
              </H>
            )
          }
          case 'p':
            return (
              <p key={i} className="break-words">
                <Inlines nodes={b.c} />
              </p>
            )
          case 'code':
            return <CodeBlock key={i} lang={b.lang} v={b.v} doc={doc} />
          case 'quote':
            return (
              <blockquote key={i} className={cn('text-muted-foreground space-y-2 border-l-2 pl-3', doc && 'bg-muted/30 rounded-r-md border-l-4 py-2 pr-3 pl-4')}>
                <Blocks blocks={b.c} doc={doc} />
              </blockquote>
            )
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul'
            return (
              <L
                key={i}
                start={b.ordered ? b.start : undefined}
                className={cn(doc ? 'marker:text-muted-foreground space-y-1.5 pl-6' : 'space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}
              >
                {b.items.map((it, k) => (
                  <li key={k} className={cn('space-y-1 break-words', it.task !== null && 'flex list-none items-baseline gap-2 space-y-0')}>
                    {it.task !== null && (
                      <input
                        type="checkbox"
                        checked={it.task}
                        readOnly
                        disabled
                        aria-label={it.task ? 'Done' : 'Not done'}
                        className="shrink-0"
                      />
                    )}
                    {it.task !== null ? (
                      <div className="min-w-0 flex-1 space-y-1">
                        <Blocks blocks={it.blocks} doc={doc} />
                      </div>
                    ) : (
                      <Blocks blocks={it.blocks} doc={doc} />
                    )}
                  </li>
                ))}
              </L>
            )
          }
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-md border" data-md="table">
                <table className={cn('w-full border-collapse', doc ? 'text-sm' : 'text-xs')}>
                  <thead className={doc ? 'bg-muted' : 'bg-muted/60'}>
                    <tr>
                      {b.head.map((c, k) => (
                        <th key={k} className={cn('border-b font-semibold', doc ? 'px-3 py-2' : 'px-2 py-1', alignClass(b.align[k] ?? null))}>
                          <Inlines nodes={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, k) => (
                      <tr key={k} className={cn('border-t', doc && 'even:bg-muted/40')}>
                        {r.map((c, m) => (
                          <td key={m} className={cn('align-top', doc ? 'px-3 py-2' : 'px-2 py-1', alignClass(b.align[m] ?? null))}>
                            <Inlines nodes={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'hr':
            return <hr key={i} className={cn('border-border', doc && 'my-6')} />
        }
      })}
    </>
  )
}

// Sections longer than this many rendered lines fold away; the first two stay open.
export const LONG_SECTION_LINES = 40
const OPEN_BY_DEFAULT = 2

const foldButton = 'hover:bg-accent text-muted-foreground hover:text-foreground flex items-center gap-1 rounded px-1.5 py-0.5 text-xs'

function DocumentBody({ blocks }: { blocks: Block[] }) {
  const sections = useMemo(() => sectionize(blocks, 3), [blocks])
  const folds = (s: MdSection) => s.heading != null && s.lines > LONG_SECTION_LINES
  const longIdx = sections.flatMap((s, i) => (folds(s) ? [i] : []))
  const [overrides, setOverrides] = useState<Record<number, boolean>>({})
  const isOpen = (i: number) => overrides[i] ?? i < OPEN_BY_DEFAULT
  const setAll = (open: boolean) => setOverrides(Object.fromEntries(longIdx.map((i) => [i, open])))
  return (
    <>
      {longIdx.length > 0 && (
        <div className="flex justify-end gap-1" data-md="fold-controls">
          <button type="button" className={foldButton} onClick={() => setAll(true)}>
            <ChevronsUpDown className="size-3" /> Expand all
          </button>
          <button type="button" className={foldButton} onClick={() => setAll(false)}>
            <ChevronsDownUp className="size-3" /> Collapse all
          </button>
        </div>
      )}
      {sections.map((s, i) =>
        folds(s) ? (
          <details
            key={i}
            open={isOpen(i)}
            onToggle={(e) => {
              const open = e.currentTarget.open
              if (open !== isOpen(i)) setOverrides((o) => ({ ...o, [i]: open }))
            }}
            className="group mt-6 first:mt-0"
            data-md="section"
          >
            <summary className="hover:bg-accent/40 -mx-2 flex cursor-pointer list-none items-center gap-2 rounded px-2 py-1 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
              <div className="min-w-0 flex-1">
                <Blocks blocks={[s.heading!]} doc flat />
              </div>
              <span className="text-muted-foreground shrink-0 text-xs">{s.lines} lines</span>
            </summary>
            <div className="space-y-3 pt-2">
              <Blocks blocks={s.blocks} doc />
            </div>
          </details>
        ) : (
          <div key={i} className="space-y-3">
            <Blocks blocks={s.heading ? [s.heading, ...s.blocks] : s.blocks} doc />
          </div>
        ),
      )}
    </>
  )
}

interface Props {
  source: string
  className?: string
  // "document" is the roomy reading style for outcomes and summaries: bigger type, spacious headings, tables and code,
  // and long sections fold away.
  variant?: 'compact' | 'document'
}

export const Markdown = memo(function Markdown({ source, className, variant = 'compact' }: Props) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  if (variant === 'document') {
    return (
      <div data-markdown="document" className={cn('min-w-0 space-y-3 text-[15px] leading-[1.65] [&_ol_ol]:mt-1.5 [&_ul_ul]:mt-1.5', className)}>
        <DocumentBody key={source} blocks={blocks} />
      </div>
    )
  }
  return (
    <div data-markdown className={cn('min-w-0 space-y-2 text-sm [&_ol_ol]:mt-1 [&_ul_ul]:mt-1', className)}>
      <Blocks blocks={blocks} />
    </div>
  )
})
