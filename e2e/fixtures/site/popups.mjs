// Fixture for the popup e2e: an opener page and a child that talks back to its opener.
import { createServer } from 'node:http'

const page = (title, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><a id="lnk" target="_blank" href="/child?via=link">link</a><script>${script}</script></body></html>`

const pages = {
  '/opener': page('Popup Opener', "window.msgs = []; window.addEventListener('message', (e) => window.msgs.push(String(e.data)))"),
  '/child': page('Popup Child', "if (window.opener) window.opener.postMessage('hello from child', '*')"),
}

export function startPopupSite() {
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url ?? '/', 'http://x').pathname]
    if (!body) return void (res.writeHead(404), res.end('missing'))
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', connection: 'close' })
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => (server.closeAllConnections(), server.close()) })))
}
