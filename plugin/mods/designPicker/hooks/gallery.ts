import type { DesignOption, DesignQuestion } from '../types'

import { LOOKS, lookFor } from './styles'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

const escape = (text: string): string => text.replace(/[&<>"']/g, ch => ESCAPES[ch] ?? ch)

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:24px;font:16px/1.5 system-ui,sans-serif;background:#f3f4f6;color:#111827}
header h1{margin:0 0 4px;font-size:24px}
header p{margin:0 0 24px;color:#4b5563}
section{margin:0 0 32px}
section h2{margin:0 0 4px;font-size:18px}
section > p{margin:0 0 16px;color:#374151}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px}
.option{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px}
.option > h3{margin:10px 4px 2px;font-size:16px}
.option > p{margin:0 4px;font-size:13px;color:#4b5563}
.stage{--bg:#ffffff;--fg:#111111;--accent:#2563eb;--muted:#666666;--radius:6px;--font:system-ui,sans-serif;--border:1px dashed #9ca3af;--shadow:none;--btn-bg:#2563eb;--btn-fg:#ffffff;--btn-shadow:none;--card-bg:#f9fafb;--weight:500;
  background:var(--bg);color:var(--fg);font-family:var(--font);font-weight:var(--weight);border-radius:var(--radius);padding:16px;min-height:230px}
.stage h4{margin:0 0 6px;font-size:20px;font-weight:var(--weight);color:var(--fg)}
.stage p{margin:0 0 12px;font-size:13px;color:var(--muted)}
.stage .btn{display:inline-block;margin:0 8px 12px 0;padding:6px 12px;font:inherit;font-size:13px;background:var(--btn-bg);color:var(--btn-fg);border:var(--border);border-radius:var(--radius);box-shadow:var(--btn-shadow)}
.stage .btn.ghost{background:transparent;color:var(--accent)}
.stage .tile{padding:10px;font-size:13px;background:var(--card-bg);color:var(--fg);border:var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.stage .swatches{margin-top:12px;display:flex;gap:6px}
.stage .swatches span{width:22px;height:22px;border-radius:var(--radius);background:var(--accent);border:var(--border)}
.stage .swatches span:nth-child(2){background:var(--fg)}
.stage .swatches span:nth-child(3){background:var(--muted)}
`

function lookCss(): string {
  return LOOKS.map(look => {
    const vars = Object.entries(look.vars).map(([name, value]) => `--${name}:${value};`).join('')

    return `.look-${look.id} .stage{${vars}}${look.css ?? ''}`
  }).join('\n')
}

function optionCard(option: DesignOption): string {
  const look = lookFor(option.label)
  const kind = look ? `look-${look.id}` : 'look-neutral'

  return `<article class="option ${kind}">
<div class="stage"><h4>Heading in this style</h4><p>Body text, so you can judge type and spacing.</p><span class="btn">Primary</span><span class="btn ghost">Secondary</span><div class="tile">Card with content</div><div class="swatches"><span></span><span></span><span></span></div></div>
<h3>${escape(option.label)}</h3>${option.description ? `<p>${escape(option.description)}</p>` : ''}
</article>`
}

function section(question: DesignQuestion): string {
  const cards = question.options.map(optionCard).join('\n')

  return `<section>
<h2>${escape(question.header || 'Design')}</h2>
<p>${escape(question.question)}</p>
<div class="grid">
${cards}
</div>
</section>`
}

// A self-contained page: the styles of the known looks and the options,
// escaped. Nothing is fetched from the network.
export function renderGallery(questions: readonly DesignQuestion[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design picker</title>
<style>${BASE_CSS}
${lookCss()}</style>
</head>
<body>
<header>
<h1>Pick a design</h1>
<p>Claude asked you to choose. Look at each option here, then pick it in Claude's question.</p>
</header>
${questions.map(section).join('\n')}
</body>
</html>
`
}
