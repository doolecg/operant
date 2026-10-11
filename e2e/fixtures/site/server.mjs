// Tiny local site for the browser e2e: a home page with a login form, a form, a console.error, a failing request,
// a target=_blank link and a cookie. `seen` records the Cookie header of every /whoami request (by ?who=).
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

export const COOKIE_VALUE = 'e2e-session-cookie-7f3a9c'

const page = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}<script>${script}</script></body></html>`

const pages = {
  '/': page(
    'Fixture Home',
    `<p><a id="two" href="/page2">Go to page two</a> <a id="blank" target="_blank" href="/blank">Open in a new tab</a></p>
     <form method="post" action="/login"><label>Username <input name="user" aria-label="Username"></label>
     <label>Password <input name="pass" type="password" aria-label="Password"></label><button type="submit">Log in</button></form>
     <form method="post" action="/form"><label>Email <input name="email" aria-label="Email"></label><button type="submit">Send form</button></form>`,
    `console.error('fixture-console-error'); fetch('/missing-resource').catch(() => {})`,
  ),
  '/page2': page('Fixture Page Two', '<p>Second page</p><a href="/">Home</a>'),
  '/blank': page('Fixture Blank Tab', '<p>Opened by target=_blank</p>'),
  '/welcome': page('Fixture Welcome', '<p>Logged in</p>'),
  '/done': page('Fixture Form Done', '<p>Form received</p>'),
  // Tall page with five "needle" words, for find in page and full-page screenshots.
  '/long': page('Fixture Long', `${Array.from({ length: 5 }, (_, i) => `<p style="height:600px">needle ${i + 1}</p>`).join('')}`),
  // Cross-origin fetch of ?t=<url>; the title says whether the browser let the page read the answer.
  '/corstest': page('Fixture Cors Pending', '', "fetch(new URLSearchParams(location.search).get('t')).then((r) => r.text()).then(() => (document.title = 'Fixture Cors OK'), () => (document.title = 'Fixture Cors Blocked'))"),
}

// Options: { tls: { key, cert } } serves https; the same pages either way.
export function startSite(opts = {}) {
  const seen = []
  // Cache-Control header of every request, by path (a hard reload sends no-cache).
  const hits = []
  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push({ path: url.pathname, cache: String(req.headers['cache-control'] ?? '') })
    // No CORS headers on purpose: only a relaxed-CORS session can read this from another origin.
    if (url.pathname === '/nocors') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', connection: 'close' })
      res.end('secret-ish payload')
      return
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      req.resume()
      req.on('end', () => {
        res.writeHead(302, { location: '/welcome', 'set-cookie': `session=${COOKIE_VALUE}; Max-Age=86400; Path=/` })
        res.end()
      })
      return
    }
    if (url.pathname === '/form' && req.method === 'POST') {
      req.resume()
      req.on('end', () => (res.writeHead(302, { location: '/done' }), res.end()))
      return
    }
    if (url.pathname === '/whoami') {
      seen.push({ who: url.searchParams.get('who'), cookie: req.headers.cookie ?? '' })
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(`Fixture Whoami ${url.searchParams.get('who')}`, '<p>whoami</p>'))
      return
    }
    if (url.pathname === '/slow') {
      setTimeout(() => (res.writeHead(200, { 'content-type': 'text/html' }), res.end(pages['/page2'])), Number(url.searchParams.get('ms') ?? 3000))
      return
    }
    const body = pages[url.pathname]
    if (!body) return void (res.writeHead(404, { 'content-type': 'text/plain' }), res.end('missing'))
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=3600', connection: 'close' })
    res.end(body)
  }
  const server = opts.tls ? createHttpsServer(opts.tls, handler) : createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, hits, close: () => (server.closeAllConnections(), server.close()) }))
  })
}
