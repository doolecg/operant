// Known design styles, each drawn as a CSS sample on the preview page.
// `vars` set the sample's tokens; `css` adds what the tokens cannot say.

export type Look = {
  id: string
  pattern: RegExp
  vars: Record<string, string>
  css?: string
}

export const LOOKS: readonly Look[] = [
  {
    id: 'minimal',
    pattern: /minimal/i,
    vars: { bg: '#ffffff', fg: '#111111', accent: '#111111', muted: '#777777', radius: '2px', font: 'system-ui, sans-serif', border: '1px solid #e5e5e5', shadow: 'none', 'btn-bg': '#111111', 'btn-fg': '#ffffff', 'card-bg': '#ffffff', weight: '300' },
  },
  {
    id: 'brutalist',
    pattern: /brutal/i,
    vars: { bg: '#fff3b0', fg: '#000000', accent: '#ff3b3b', muted: '#333333', radius: '0', font: '"Courier New", monospace', border: '3px solid #000000', shadow: '6px 6px 0 #000000', 'btn-bg': '#ff3b3b', 'btn-fg': '#000000', 'btn-shadow': '3px 3px 0 #000000', 'card-bg': '#ffffff', weight: '700' },
  },
  {
    id: 'glassmorphism',
    pattern: /glass/i,
    vars: { bg: 'linear-gradient(135deg, #667eea, #764ba2)', fg: '#ffffff', accent: '#ffffff', muted: 'rgba(255,255,255,0.8)', radius: '16px', font: 'system-ui, sans-serif', border: '1px solid rgba(255,255,255,0.35)', shadow: '0 8px 32px rgba(0,0,0,0.2)', 'btn-bg': 'rgba(255,255,255,0.25)', 'btn-fg': '#ffffff', 'card-bg': 'rgba(255,255,255,0.18)', weight: '500' },
    css: '.look-glassmorphism .tile{backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
  },
  {
    id: 'neumorphism',
    pattern: /neumorph/i,
    vars: { bg: '#e0e5ec', fg: '#44476a', accent: '#44476a', muted: '#6b6f8f', radius: '20px', font: 'system-ui, sans-serif', border: 'none', shadow: '8px 8px 16px #b8bec7, -8px -8px 16px #ffffff', 'btn-bg': '#e0e5ec', 'btn-fg': '#44476a', 'btn-shadow': '4px 4px 8px #b8bec7, -4px -4px 8px #ffffff', 'card-bg': '#e0e5ec', weight: '600' },
  },
  {
    id: 'material',
    pattern: /material/i,
    vars: { bg: '#ffffff', fg: '#1c1b1f', accent: '#6750a4', muted: '#49454f', radius: '4px', font: 'Roboto, "Segoe UI", system-ui, sans-serif', border: 'none', shadow: '0 1px 3px rgba(0,0,0,0.25)', 'btn-bg': '#6750a4', 'btn-fg': '#ffffff', 'card-bg': '#f3edf7', weight: '500' },
  },
  {
    id: 'flat',
    pattern: /\bflat\b/i,
    vars: { bg: '#f4f1de', fg: '#3d405b', accent: '#e07a5f', muted: '#6d6f84', radius: '0', font: 'system-ui, sans-serif', border: 'none', shadow: 'none', 'btn-bg': '#e07a5f', 'btn-fg': '#ffffff', 'card-bg': '#81b29a', weight: '600' },
  },
  {
    id: 'skeuomorphic',
    pattern: /skeuomorph/i,
    vars: { bg: 'linear-gradient(#f0f0f0, #cfcfcf)', fg: '#333333', accent: '#3a7bd5', muted: '#555555', radius: '6px', font: 'Georgia, serif', border: '1px solid #9a9a9a', shadow: 'inset 0 1px 0 #ffffff, 0 2px 3px rgba(0,0,0,0.4)', 'btn-bg': 'linear-gradient(#ffffff, #d8d8d8)', 'btn-fg': '#333333', 'btn-shadow': 'inset 0 1px 0 #ffffff, 0 1px 2px rgba(0,0,0,0.4)', 'card-bg': '#fafafa', weight: '700' },
  },
  {
    id: 'dark',
    pattern: /\bdark\b/i,
    vars: { bg: '#0d1117', fg: '#e6edf3', accent: '#58a6ff', muted: '#8b949e', radius: '8px', font: 'system-ui, sans-serif', border: '1px solid #30363d', shadow: 'none', 'btn-bg': '#58a6ff', 'btn-fg': '#0d1117', 'card-bg': '#161b22', weight: '500' },
  },
  {
    id: 'light',
    pattern: /\blight\b/i,
    vars: { bg: '#fafafa', fg: '#1a1a1a', accent: '#2563eb', muted: '#666666', radius: '8px', font: 'system-ui, sans-serif', border: '1px solid #dddddd', shadow: '0 1px 2px rgba(0,0,0,0.08)', 'btn-bg': '#2563eb', 'btn-fg': '#ffffff', 'card-bg': '#ffffff', weight: '500' },
  },
  {
    id: 'retro',
    pattern: /retro|vintage|synthwave|80s/i,
    vars: { bg: '#1a0b2e', fg: '#ff6ad5', accent: '#ffd319', muted: '#c792ea', radius: '0', font: '"Courier New", monospace', border: '2px solid #ff6ad5', shadow: '4px 4px 0 #ffd319', 'btn-bg': '#ffd319', 'btn-fg': '#1a0b2e', 'card-bg': '#2a1248', weight: '700' },
  },
  {
    id: 'editorial',
    pattern: /editorial|magazine|serif/i,
    vars: { bg: '#f7f3ea', fg: '#111111', accent: '#8b0000', muted: '#555555', radius: '0', font: 'Georgia, "Times New Roman", serif', border: 'none', shadow: 'none', 'btn-bg': '#111111', 'btn-fg': '#f7f3ea', 'card-bg': '#f7f3ea', weight: '400' },
    css: '.look-editorial .tile{border-top:2px solid #111111;border-bottom:1px solid #111111;background:none}',
  },
  {
    id: 'bento',
    pattern: /bento/i,
    vars: { bg: '#eef1f5', fg: '#1d2433', accent: '#3b82f6', muted: '#5b6478', radius: '18px', font: 'system-ui, sans-serif', border: 'none', shadow: '0 1px 2px rgba(0,0,0,0.06)', 'btn-bg': '#3b82f6', 'btn-fg': '#ffffff', 'card-bg': '#ffffff', weight: '600' },
  },
  {
    id: 'corporate',
    pattern: /corporate|enterprise|professional/i,
    vars: { bg: '#f5f7fa', fg: '#0b2545', accent: '#13315c', muted: '#4a5a70', radius: '4px', font: '"Segoe UI", system-ui, sans-serif', border: '1px solid #cfd8e3', shadow: 'none', 'btn-bg': '#13315c', 'btn-fg': '#ffffff', 'card-bg': '#ffffff', weight: '600' },
  },
]

export function lookFor(label: string): Look | undefined {
  return LOOKS.find(look => look.pattern.test(label))
}
