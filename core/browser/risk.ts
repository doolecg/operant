// Which AI browser calls need the user's approval in "confirm" autonomy. Pure: no state, no Electron.
// Summaries shown to the user never hold typed text, password values, cookie values or URL queries.

export interface RiskCall {
  name: string
  args: Record<string, unknown>
}

export interface Risk {
  risk: 'allow' | 'confirm'
  reason?: string
}

const SCRIPT_TOOLS = new Set(['browser_evaluate', 'browser_run_code_unsafe', 'browser_run_playwright_script'])

// Element descriptions of things that spend money, send, or cannot be undone.
const RISKY_LABEL =
  /\b(pay|payment|pay\s*now|buy|buy\s*now|purchase|check\s*out|checkout|place\s+(?:the\s+|your\s+)?order|order\s+now|complete\s+(?:the\s+|your\s+)?order|confirm\s+(?:the\s+|your\s+)?(?:order|purchase|payment)|submit|delete|erase|destroy|remove\s+(?:account|all|permanently)|close\s+account|deactivate|(?:cancel|end)\s+(?:my\s+|your\s+|the\s+)?(?:subscription|account|plan|membership)|unsubscribe|subscribe|transfer|send\s+money|wire|withdraw|donate|upgrade|download|install)\b/i

// Fields that hold secrets: passwords and payment card data.
const SECRET_LABEL = /\b(pass(?:word|code|wd)?|pwd|pin|cvv|cvc|security\s+code|card\s+(?:number|no)|credit\s+card|debit\s+card)\b/i

const PAYMENT_HOST = /(?:^|\.)(?:paypal\.com|paypal\.me|checkout\.stripe\.com|buy\.stripe\.com|pay\.google\.com|pay\.amazon\.com|checkout\.shopify\.com|payments?\.[^.]+\.[^.]+)$/i
const PAYMENT_PATH = /(?:^|\/)(?:checkout|payment|payments|pay|billing|purchase|buy|order[_-]confirm(?:ation)?|place[_-]order)(?:\/|\.(?:html?|php|aspx?)$|$)/i
const DOWNLOAD_PATH = /\.(?:exe|msi|dmg|pkg|iso|apk|deb|rpm|zip|7z|rar|tar|gz|tgz|bat|cmd|ps1|sh|jar|appimage)$/i

const REF = /^(?:f\d+)?e\d+$/

function parseUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function isPaymentUrl(url: string): boolean {
  const u = parseUrl(url)
  if (!u) return false
  return PAYMENT_HOST.test(u.hostname) || PAYMENT_PATH.test(u.pathname)
}

export function isDownloadUrl(url: string): boolean {
  const u = parseUrl(url)
  return u !== null && DOWNLOAD_PATH.test(u.pathname)
}

// A bare snapshot ref ("e12") says nothing about the element; a selector does.
const isRef = (s: string): boolean => REF.test(s)

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// The words that describe the thing a call acts on: the human-readable description, and the selector when it is one.
function labelOf(a: Record<string, unknown>, element = 'element', target = 'target'): string {
  const t = str(a[target]) || str(a['ref'])
  return `${str(a[element])} ${t && !isRef(t) ? t : ''}`.trim()
}

export function isSecretLabel(label: string): boolean {
  return SECRET_LABEL.test(label)
}

export function isRiskyLabel(label: string): boolean {
  return RISKY_LABEL.test(label)
}

export function assessCall(call: RiskCall): Risk {
  const a = call.args
  const go = (reason: string): Risk => ({ risk: 'confirm', reason })
  const name = call.name
  if (SCRIPT_TOOLS.has(name)) return go('runs a script on the page')
  switch (name) {
    case 'browser_click': {
      const label = labelOf(a)
      return isRiskyLabel(label) ? go('may submit, pay, delete or download') : { risk: 'allow' }
    }
    case 'browser_type': {
      if (isSecretLabel(labelOf(a))) return go('types into a password or card field')
      return { risk: 'allow' }
    }
    case 'browser_fill_form': {
      const fields = Array.isArray(a['fields']) ? (a['fields'] as unknown[]) : []
      for (const f of fields) {
        if (!f || typeof f !== 'object') continue
        const o = f as Record<string, unknown>
        if (isSecretLabel(`${labelOf(o)} ${str(o['name'])}`)) return go('fills in a password or card field')
      }
      return { risk: 'allow' }
    }
    case 'browser_navigate': {
      const url = str(a['url'])
      if (isPaymentUrl(url)) return go('opens a payment or checkout page')
      if (isDownloadUrl(url)) return go('downloads a file')
      return { risk: 'allow' }
    }
    case 'browser_tabs': {
      const url = str(a['url'])
      if (a['action'] === 'new' && url) {
        if (isPaymentUrl(url)) return go('opens a payment or checkout page')
        if (isDownloadUrl(url)) return go('downloads a file')
      }
      return { risk: 'allow' }
    }
    case 'browser_file_upload':
      return Array.isArray(a['paths']) && a['paths'].length > 0 ? go('uploads local files') : { risk: 'allow' }
    case 'browser_mouse_click_xy':
    case 'browser_mouse_up':
      return go('clicks at screen coordinates, so what it hits is unknown')
    case 'browser_set_cookies':
      return go('changes the browser session cookies')
    case 'browser_clear_storage':
      return go('clears stored data and may log the user out')
    case 'browser_grant_permissions':
      return a['reset'] === true ? { risk: 'allow' } : go('grants site permissions without asking you')
    case 'browser_set_compat':
      if (a['relaxCors'] === true) return go('turns on relaxed CORS for every site')
      return a['ignoreCertErrors'] === 'on' ? go('accepts invalid certificates for every site') : { risk: 'allow' }
    case 'browser_get_cookies':
      return a['includeValues'] === true ? go('reads cookie values') : { risk: 'allow' }
    default:
      return { risk: 'allow' }
  }
}

// Blanks the value of anything that looks like a secret in a script, so approving it does not leak a password
// into the prompt: quoted strings on a line that names a password, token or key.
export function redactCode(code: string): string {
  return code
    .split('\n')
    .map((line) => (/pass(?:word|wd|code)?|\bpw\b|pwd|secret|token|api[_-]?key|cvv|card/i.test(line) ? line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '$1***$1') : line))
    .join('\n')
}

function hostPath(url: string): string {
  const u = parseUrl(url)
  return u ? `${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 120) : 'a page'
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}...` : one
}

// One line for the approval prompt: what the AI is about to do and why it asks.
export function confirmSummary(call: RiskCall): string {
  const a = call.args
  const reason = assessCall(call).reason
  const why = reason ? ` (${reason})` : ''
  const el = clip(str(a['element']) || (str(a['target']) && !isRef(str(a['target'])) ? str(a['target']) : ''), 80)
  switch (call.name) {
    case 'browser_click':
      return `Click ${el ? `"${el}"` : 'an element'}${why}`
    case 'browser_type':
      return `Type into ${el ? `"${el}"` : 'a field'}${why}`
    case 'browser_fill_form': {
      const n = Array.isArray(a['fields']) ? a['fields'].length : 0
      return `Fill in ${n} form field${n === 1 ? '' : 's'}${why}`
    }
    case 'browser_navigate':
      return `Open ${hostPath(str(a['url']))}${why}`
    case 'browser_tabs':
      return `Open ${hostPath(str(a['url']))} in a new tab${why}`
    case 'browser_file_upload': {
      const n = Array.isArray(a['paths']) ? a['paths'].length : 0
      return `Upload ${n} file${n === 1 ? '' : 's'}${why}`
    }
    case 'browser_evaluate':
      return `Run JavaScript on the page: ${clip(redactCode(str(a['function'])), 160)}`
    case 'browser_run_code_unsafe':
      return `Run Playwright code: ${clip(redactCode(str(a['code'])), 160)}`
    case 'browser_run_playwright_script':
      return `Run a Playwright script: ${clip(redactCode(str(a['script'])), 160)}`
    case 'browser_mouse_click_xy':
    case 'browser_mouse_up':
      return `Click at screen position (${String(a['x'] ?? '?')}, ${String(a['y'] ?? '?')})${why}`
    case 'browser_set_cookies': {
      const n = Array.isArray(a['cookies']) ? a['cookies'].length : 0
      return `Set ${n} cookie${n === 1 ? '' : 's'}`
    }
    case 'browser_clear_storage':
      return `Clear browser data: ${clip(Array.isArray(a['what']) ? a['what'].filter((x) => typeof x === 'string').join(', ') : 'all', 80)}`
    case 'browser_get_cookies':
      return 'Read cookie values'
    case 'browser_set_compat': {
      const parts = [a['relaxCors'] === true ? 'relaxed CORS' : '', a['ignoreCertErrors'] === 'on' ? 'ignore certificate errors' : ''].filter(Boolean)
      return `Turn on ${parts.join(' and ') || 'compatibility options'}${why}`
    }
    case 'browser_grant_permissions': {
      const names = Array.isArray(a['permissions']) ? a['permissions'].filter((x) => typeof x === 'string').join(', ') : ''
      return `Grant ${clip(names || 'permissions', 80)} to ${str(a['origin']) ? (parseUrl(a['origin'])?.host ?? 'a site') : 'the current site'}`
    }
    default:
      return `${call.name}${why}`
  }
}
