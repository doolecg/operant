import { memo, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseMarkdown, type Align, type Block, type Inline } from '@shared/markdown'
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

function CodeBlock({ lang, v }: { lang: string; v: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard
      ?.writeText(v)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div className="bg-muted/60 group relative rounded-md border" data-md="code">
      <div className="text-muted-foreground flex items-center justify-between px-2 pt-1 text-[10px]">
        <span className="font-mono">{lang}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={copy}
          className="hover:bg-accent hover:text-foreground flex items-center gap-1 rounded px-1.5 py-0.5"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre tabIndex={0} className="overflow-x-auto px-3 pt-1 pb-2 font-mono text-xs leading-relaxed whitespace-pre">
        {v}
      </pre>
    </div>
  )
}

const alignClass = (a: Align) => (a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left')
const headingClass = ['', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs', 'text-xs']

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'heading': {
            const H = `h${Math.min(b.level + 2, 6)}` as 'h3'
            return (
              <H key={i} className={cn('font-semibold break-words', headingClass[b.level])}>
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
            return <CodeBlock key={i} lang={b.lang} v={b.v} />
          case 'quote':
            return (
              <blockquote key={i} className="text-muted-foreground space-y-2 border-l-2 pl-3">
                <Blocks blocks={b.c} />
              </blockquote>
            )
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul'
            return (
              <L key={i} start={b.ordered ? b.start : undefined} className={cn('space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}>
                {b.items.map((it, k) => (
                  <li key={k} className={cn('space-y-1 break-words', it.task !== null && 'list-none')}>
                    {it.task !== null && (
                      <input type="checkbox" checked={it.task} readOnly disabled aria-label={it.task ? 'Done' : 'Not done'} className="mr-1.5 -ml-5 align-middle" />
                    )}
                    <Blocks blocks={it.blocks} />
                  </li>
                ))}
              </L>
            )
          }
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-md border" data-md="table">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-muted/60">
                    <tr>
                      {b.head.map((c, k) => (
                        <th key={k} className={cn('border-b px-2 py-1 font-semibold', alignClass(b.align[k] ?? null))}>
                          <Inlines nodes={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, k) => (
                      <tr key={k} className="border-t">
                        {r.map((c, m) => (
                          <td key={m} className={cn('px-2 py-1 align-top', alignClass(b.align[m] ?? null))}>
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
            return <hr key={i} className="border-border" />
        }
      })}
    </>
  )
}

interface Props {
  source: string
  className?: string
}

export const Markdown = memo(function Markdown({ source, className }: Props) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div data-markdown className={cn('min-w-0 space-y-2 text-sm [&_ol_ol]:mt-1 [&_ul_ul]:mt-1', className)}>
      <Blocks blocks={blocks} />
    </div>
  )
})
