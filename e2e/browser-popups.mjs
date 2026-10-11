// Popup e2e for the embedded browser: window.open and target=_blank become panel tabs in the hub state, the opener keeps a
// working window reference, closing a tab closes the window for the opener, and window.close() removes the tab. No AI.
// Usage: node e2e/browser-popups.mjs  (needs npm run build first)
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { claudeHome, e2eEnv } from './fixtures/real-claude.mjs'
import { startPopupSite } from './fixtures/site/popups.mjs'

const root = mkdtempSync(join(tmpdir(), 'operant-popups-e2e-'))
const dataDir = join(root, 'data')
const proj = join(root, 'proj')
for (const d of [dataDir, proj]) mkdirSync(d, { recursive: true })
const site = await startPopupSite()
const base = `http://127.0.0.1:${site.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (c, m) => {
  if (!c) throw new Error(m)
}
const poll = async (label, fn, timeout = 15_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    const v = await fn().catch(() => false)
    if (v) return v
  }
  throw new Error(`timed out waiting for ${label}`)
}

let app = null
let failed = false
try {
  app = await electron.launch({ args: ['.'], env: e2eEnv({ dataDir, claudeDir: claudeHome(root) }) })
  let output = ''
  for (const st of [app.process().stdout, app.process().stderr]) st?.on('data', (c) => (output += String(c)))
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
  const inv = (c, ...a) => page.evaluate(([ch, args]) => window.operant.invoke(ch, ...args), [c, a])
  const contents = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ id: w.id, url: w.getURL() })))
  const run = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c, true), [id, code])
  const idOf = async (part) => (await contents()).find((c) => c.url.startsWith(base) && c.url.includes(part))?.id
  const tabs = async () => (await inv('browser:state', crew)).tabs

  const crew = (await inv('crews:create', { name: 'popups', folder: realpathSync.native(proj) })).id
  await inv('browser:open', crew, `${base}/opener`)
  const opener = await poll('opener page', () => idOf('/opener'))
  await poll('opener tab', async () => (await tabs()).length === 1)

  // window.open(url): a hub tab, and a round trip through the opener reference.
  await run(opener, "window.w1 = window.open('/child?via=open', 'c1'); 0")
  await poll('popup tab in hub state', async () => (await tabs()).some((t) => t.url.includes('via=open')))
  await poll('postMessage from the popup', () => run(opener, "window.msgs.includes('hello from child')"))
  ok(await run(opener, 'window.w1 !== null && window.w1.closed === false'), 'window.open returned no live window')

  // The AI's browser endpoint only sees hub targets: every tab here has one.
  ok((await tabs()).length === 2, 'expected two tabs')

  // window.open() with no URL: a blank window the opener can write into.
  await run(opener, "window.w2 = window.open(); window.w2.document.write('<title>blank-ok</title>'); window.w2.document.close(); 0")
  await poll('blank popup tab', async () => (await tabs()).length === 3)
  ok(await run(opener, "window.w2.document.title === 'blank-ok'"), 'opener cannot reach the blank popup')

  // target=_blank link.
  await run(opener, "document.getElementById('lnk').click(); 0")
  await poll('target=_blank tab', async () => (await tabs()).some((t) => t.url.includes('via=link')))

  // Closing a tab from the panel closes the window for the opener.
  const before = await tabs()
  const openTab = before.find((t) => t.url.includes('via=open'))
  await inv('browser:tabClose', crew, openTab.id)
  await poll('tab gone from the hub', async () => !(await tabs()).some((t) => t.id === openTab.id))
  await poll('popup.closed after closing the tab', () => run(opener, 'window.w1.closed === true'))

  // The popup's own window.close() removes its tab.
  const blank = (await tabs()).find((t) => t.url === 'about:blank' || t.url === '')
  ok(blank, 'blank tab not found')
  await run(opener, 'window.w2.close(); 0')
  await poll('tab removed after window.close()', async () => !(await tabs()).some((t) => t.id === blank.id))

  // A popup closing itself.
  await run(opener, "window.w3 = window.open('/child?via=self', 'c3'); 0")
  const selfId = await poll('third popup page', () => idOf('via=self'))
  await poll('third popup tab', async () => (await tabs()).some((t) => t.url.includes('via=self')))
  await run(selfId, 'window.close(); 0')
  await poll('self-closed tab removed', async () => !(await tabs()).some((t) => t.url.includes('via=self')))
  await poll('opener sees it closed', () => run(opener, 'window.w3.closed === true'))

  // Non-web URLs stay refused.
  ok((await run(opener, "window.open('file:///c:/') === null")), 'file: popup was not refused')
  await sleep(500)
  ok(!/Uncaught|TypeError/.test(output), 'the main process reported an uncaught exception')
  console.log('popup e2e ok')
} catch (e) {
  failed = true
  console.log(`FAIL ${e instanceof Error ? e.message : e}`)
} finally {
  await app?.close().catch(() => undefined)
  site.close()
  rmSync(root, { recursive: true, force: true })
}
if (failed) process.exit(1)
