// Embedded browser e2e. No fake claude: the AI path uses the REAL claude (Haiku, forced by the app under OPERANT_E2E) for
// one short turn, everything else is driven without an AI. Covers: the browser MCP through the real agent and target
// filtering (A), security (B), persistence across a restart (C), the human browser controls (D) and site compatibility (E).
// Take control with a real agent lives in e2e/browser-real.mjs.
// Usage: node e2e/browser.mjs [outDir]  (default docs/specs/screenshots)
// A throwaway OPERANT_DATA_DIR and CLAUDE_CONFIG_DIR (a copy of the login, deleted at the end, never printed).
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { MODEL, claudeHome, e2eEnv } from './fixtures/real-claude.mjs'
import { COOKIE_VALUE, startSite } from './fixtures/site/server.mjs'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'operant-browser-e2e-'))
const dataDir = join(root, 'data')
const alphaRaw = join(root, 'alpha')
const beta = join(root, 'beta')
for (const d of [dataDir, beta, join(alphaRaw, '.claude')]) mkdirSync(d, { recursive: true })
const alpha = realpathSync.native(alphaRaw)
const claudeDir = claudeHome(root)
// The browser tools are allowed for this throwaway project so the run does not stop on permission prompts.
writeFileSync(join(alphaRaw, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__operant-browser'] } }))
// A SessionStart hook (user settings of the throwaway config dir) saves the tile's OPERANT_TOKEN to a file in the throwaway
// root, so the security checks can call the MCP endpoint. The token is never printed.
const fwd = (p) => p.replaceAll('\\', '/')
writeFileSync(join(root, 'dump-env.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify({ token: process.env.OPERANT_TOKEN ?? '' }))\n")
writeFileSync(
  join(claudeDir, 'settings.json'),
  JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${fwd(join(root, 'dump-env.mjs'))}" "${fwd(join(root, 'conn.json'))}"` }] }] } }),
)

const site = await startSite()
const site2 = await startSite()
const base = `http://127.0.0.1:${site.port}`
const base2 = `http://127.0.0.1:${site2.port}`

const results = []
const bugs = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push([name, 'pass'])
    console.log(`PASS ${name}`)
  } catch (e) {
    results.push([name, 'FAIL'])
    bugs.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}
const skip = (name, why) => {
  results.push([name, 'skip'])
  console.log(`SKIP ${name}: ${why}`)
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const packaged = process.env.OPERANT_E2E_EXE
let app = null
let page = null
let output = ''
const launch = async () => {
  const env = e2eEnv({ dataDir, claudeDir })
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  const grab = (c) => (output += String(c))
  app.process().stdout?.on('data', grab)
  app.process().stderr?.on('data', grab)
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForFunction(() => !!window.operant)
}
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const poll = async (label, fn, timeout = 15_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(150)) {
    const v = await fn().catch(() => false)
    if (v) return v
  }
  throw new Error(`timed out waiting for ${label}`)
}
const shot = async (name) => (await sleep(400), page.screenshot({ path: join(outDir, `browser-${name}.png`) }))
// Read-only look at the app's web contents from main: the app UI and the browser panel views.
const contents = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ id: w.id, url: w.getURL(), title: w.getTitle() })))
const panelRun = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c, true), [id, code])
const bstate = (crewId) => inv('browser:state', crewId)
const waitState = (label, crewId, pred, timeout) => poll(label, async () => pred(await bstate(crewId)), timeout)
const panelId = async (urlPart, origin = base) => (await contents()).find((c) => c.url.includes(urlPart) && c.url.startsWith(origin))?.id
const address = () => page.getByLabel('Address', { exact: true })

// ---- MCP client over plain HTTP (Streamable HTTP; replies are JSON or SSE) ----
const rpcText = async (res) => {
  const text = await res.text()
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const datas = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    return datas.length ? JSON.parse(datas.at(-1)) : null
  }
  return text ? JSON.parse(text) : null
}
class Mcp {
  constructor(conn) {
    this.conn = conn
    this.id = 0
    this.sid = null
  }
  headers() {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.conn.headers, ...(this.sid ? { 'mcp-session-id': this.sid, 'mcp-protocol-version': '2025-06-18' } : {}) }
  }
  async post(body) {
    return fetch(this.conn.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) })
  }
  async init() {
    const res = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })
    if (res.status !== 200) throw new Error(`initialize answered ${res.status}`)
    this.sid = res.headers.get('mcp-session-id')
    await rpcText(res)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then((r) => r.text())
  }
  async call(method, params) {
    const res = await this.post({ jsonrpc: '2.0', id: ++this.id, method, params })
    const msg = await rpcText(res)
    if (msg?.error) throw new Error(`${method}: ${msg.error.message}`)
    return msg?.result
  }
  async tool(name, args = {}) {
    const r = await this.call('tools/call', { name, arguments: args })
    return { ...r, text: (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') }
  }
}

const pngSize = (file) => {
  const b = readFileSync(file)
  ok(b.subarray(1, 4).toString() === 'PNG', `${file} is not a PNG`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}
const APP_UI = /file:\/\/|renderer\/index\.html|localhost:5199|127\.0\.0\.1:5199/

let aiConn = null
let crewA = 0
let crewB = 0

try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('settings:set', { mainCli: 'claude', browser: { homeUrl: `${base}/`, autonomy: 'full' } })
  crewA = (await inv('crews:create', { name: 'alpha', folder: alpha })).id
  crewB = (await inv('crews:create', { name: 'beta', folder: beta })).id
  await page.locator('[data-crew-row]').getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'alpha', level: 1 }).waitFor()
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  const uiStart = page.url()

  // ---------------- No AI: basic browsing ----------------
  await check('2 open browser shows the fixture', async () => {
    const row = page.locator('[data-crew-row]', { hasText: 'alpha' })
    await row.getByText('alpha', { exact: true }).hover()
    const opened = await row.getByRole('button', { name: 'Open browser in alpha' }).click({ timeout: 8000 }).then(() => true, () => false)
    if (!opened) {
      console.log('  NOTE: the sidebar "Open browser in alpha" button was not reachable; opening through browser:open')
      await inv('browser:open', crewA)
    }
    await address().waitFor({ timeout: 10_000 })
    await waitState('home page loaded', crewA, (s) => s.open && s.tabs.length === 1 && s.tabs[0].url === `${base}/` && !s.tabs[0].loading)
    await shot('open')
  })

  // The real claude tile (Haiku) starts now and warms up while the no-AI checks run.
  const tile = await inv('scratch:create', { crewId: crewA, title: 'real', agent: 'claude', model: MODEL })
  await inv('scratch:start', tile.id)
  const snap = () => inv('chat:snapshot', tile.id)

  await check('2 address bar to page 2, back, forward, reload', async () => {
    const addr = address()
    await addr.fill(`${base}/page2`)
    await addr.press('Enter')
    await waitState('page2', crewA, (s) => s.tabs[0]?.url === `${base}/page2` && !s.tabs[0].loading)
    await page.getByRole('button', { name: 'Back' }).click()
    await waitState('back', crewA, (s) => s.tabs[0]?.url === `${base}/`)
    await page.getByRole('button', { name: 'Forward' }).click()
    await waitState('forward', crewA, (s) => s.tabs[0]?.url === `${base}/page2`)
    const id = await panelId('/page2')
    ok(id, 'panel view for page2 not found')
    await panelRun(id, 'window.__marker = 1')
    await page.getByRole('button', { name: 'Reload' }).click()
    await poll('reload cleared the marker', async () => (await panelRun(id, 'window.__marker ?? null')) === null)
  })
  await check('2 new tab, select, close', async () => {
    await page.getByRole('button', { name: 'New tab' }).click()
    await waitState('two tabs', crewA, (s) => s.tabs.length === 2)
    const s = await bstate(crewA)
    ok(s.activeTabId === s.tabs[1].id, 'new tab is not active')
    await page.getByRole('tab').first().click()
    await waitState('first tab selected', crewA, (st) => st.activeTabId === st.tabs[0].id)
    await page.getByRole('button', { name: /^Close tab/ }).nth(1).click()
    await waitState('back to one tab', crewA, (st) => st.tabs.length === 1)
  })
  await check('2 target=_blank link opens a tab, app UI never navigates', async () => {
    await address().fill(`${base}/`)
    await address().press('Enter')
    await waitState('home', crewA, (s) => s.tabs[0]?.url === `${base}/` && !s.tabs[0].loading)
    const id = await panelId('/')
    await panelRun(id, "document.querySelector('a[target=_blank]').click()")
    await waitState('blank tab', crewA, (s) => s.tabs.length === 2 && s.tabs.some((t) => t.url === `${base}/blank`))
    ok(page.url() === uiStart, `app UI navigated: ${page.url()}`)
    await page.getByRole('button', { name: /^Close tab/ }).last().click()
    await waitState('blank closed', crewA, (st) => st.tabs.length === 1)
  })

  // Helpers for the checks below: one clean tab, and navigation of the active tab without the address bar.
  const activeTab = async () => {
    const s = await bstate(crewA)
    return s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
  }
  const fresh = async (url) => {
    const s = await bstate(crewA)
    if (!s.open || s.tabs.length === 0) await inv('browser:open', crewA, url)
    else {
      for (const t of s.tabs.slice(1)) await inv('browser:tabClose', crewA, t.id)
      await inv('browser:tabSelect', crewA, s.tabs[0].id)
      await inv('browser:navigate', crewA, s.tabs[0].id, url)
    }
    await waitState('one tab loaded', crewA, (st) => st.open && st.tabs.length === 1 && !st.tabs[0].loading)
    await address().waitFor({ timeout: 10_000 })
  }
  const goto = async (url) => {
    const t = await activeTab()
    await inv('browser:navigate', crewA, t.id, url)
    await waitState('load finished', crewA, (st) => !st.tabs.find((x) => x.id === t.id)?.loading)
    await sleep(150)
    return t.id
  }
  const menu = async (...path) => {
    // A menu left open would block the page (Radix hides everything else from the accessibility tree).
    while ((await page.getByRole('menu').count()) > 0) await page.keyboard.press('Escape').then(() => sleep(200))
    await page.getByRole('button', { name: 'Browser menu' }).click()
    for (const [i, name] of path.entries()) {
      const item = page.getByRole('menuitem', { name, exact: true })
      if (i === path.length - 1 && path.length > 1) {
        await item.waitFor()
        await item.dispatchEvent('click')
      } else await item.click()
    }
  }

  // ---------------- A: the real agent over the browser MCP ----------------
  await poll('claude to be ready', async () => (await snap()).process === 'ready', 120_000)
  const urlFile = (() => {
    const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n === 'browser-mcp.json' ? [join(d, n)] : []))
    return walk(dataDir)[0]
  })()
  await poll('the tile token file', async () => existsSync(join(root, 'conn.json')), 20_000).catch(() => undefined)
  if (urlFile && existsSync(join(root, 'conn.json'))) {
    const token = JSON.parse(readFileSync(join(root, 'conn.json'), 'utf8')).token
    const url = JSON.parse(readFileSync(urlFile, 'utf8')).mcpServers['operant-browser'].url
    if (/^[0-9a-f]{64}$/.test(token)) aiConn = { url, headers: { Authorization: `Bearer ${token}` } }
  }

  await check('A real claude.exe runs with the haiku model and the browser MCP config (the tile token is a 64-hex secret)', async () => {
    ok(aiConn, 'could not get the tile token/url (SessionStart hook file or browser-mcp.json missing)')
    ok(aiConn.url.startsWith('http://127.0.0.1:'), `url ${aiConn.url}`)
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -like '*browser-mcp.json*' } | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true })
    const line = out.split(/\r?\n/).find((l) => l.includes('browser-mcp.json'))
    ok(line, 'no real claude.exe with --mcp-config browser-mcp.json found')
    ok(line.includes(`--model ${MODEL}`), `model flag is not ${MODEL}: ${line.slice(0, 300)}`)
    ok(!/[0-9a-f]{64}/.test(readFileSync(urlFile, 'utf8')), 'the MCP config file must hold the placeholder, not a secret')
  })

  let turnTools = []
  await check('A real agent: browser tools exist (navigate, tabs, run_code), tabs/pages show only panel tabs', async () => {
    const from = (await snap()).items.length
    await inv('chat:send', tile.id, {
      text: `Use ONLY the operant-browser MCP tools (load their schemas with ToolSearch if they are deferred). Do exactly these calls in order: 1) browser_navigate to ${base}/  2) browser_tabs with action "list"  3) browser_run_code_unsafe with code: async (page) => JSON.stringify(page.context().pages().map((p) => p.url()))  Call nothing else. Reply with one line: DONE then the JSON result of step 3.`,
    })
    await poll('the turn to start', async () => (await snap()).turn.phase !== 'idle', 30_000)
    await poll('the turn to finish', async () => (await snap()).turn.phase === 'idle', 240_000)
    const s = await snap()
    const items = s.items.slice(from).filter((i) => i.kind === 'tool')
    turnTools = items.map((i) => i.name)
    console.log(`  tools used: ${turnTools.join(', ')}`)
    console.log(`  cost: ${s.costUsd ?? 'n/a'} USD`)
    const named = (re) => items.filter((i) => re.test(i.name))
    ok(named(/^mcp__operant-browser__browser_navigate$/).length > 0, 'browser_navigate was not used')
    ok(!turnTools.some((n) => /playwright|chrome/i.test(n) && !n.startsWith('mcp__operant-browser__')), 'a different browser tool was used')
    const tabs = named(/browser_tabs$/)
    const run = named(/browser_run_code/)
    ok(tabs.length > 0, `browser_tabs was not used (${turnTools.join(',')})`)
    ok(run.length > 0, `browser_run_code_unsafe was not used (${turnTools.join(',')})`)
    for (const i of [...tabs, ...run]) {
      const text = i.result?.text ?? ''
      ok(!i.result?.isError, `${i.name} failed: ${text.slice(0, 200)}`)
      ok(text.includes(base), `${i.name} lists no panel tab: ${text.slice(0, 300)}`)
      ok(!APP_UI.test(text), `${i.name} shows the app UI: ${text.slice(0, 300)}`)
    }
    const nonPanel = (await contents()).filter((c) => !c.url.startsWith(base))
    ok(nonPanel.length > 0, 'sanity: app UI contents missing')
  })

  const mcp = aiConn ? new Mcp(aiConn) : null
  if (mcp) {
    await check('A MCP tools/list has browser_navigate', async () => {
      await mcp.init()
      const r = await mcp.call('tools/list', {})
      const names = r.tools.map((t) => t.name)
      ok(names.includes('browser_navigate'), 'browser_navigate missing')
    })
    await check('A browser_close / Browser.close leave the app and the tile open', async () => {
      await mcp.tool('browser_navigate', { url: `${base}/` })
      const r = await mcp.tool('browser_close').catch((e) => ({ text: String(e) }))
      await sleep(800)
      ok(!page.isClosed() && (await page.getByText('alpha').count()) > 0, 'app window gone')
      let s = await bstate(crewA)
      ok(s.open, `the tile closed after browser_close (tabs ${s.tabs.length}): ${r.text?.slice(0, 200)}`)
      ok(page.url() === uiStart, 'app UI navigated')
      await mcp.tool('browser_navigate', { url: `${base}/` }).catch(() => undefined)
      await mcp.tool('browser_run_code_unsafe', { code: 'async (page) => { await page.context().browser()?.close() }' }).catch(() => undefined)
      await sleep(800)
      s = await bstate(crewA)
      ok(s.open && !page.isClosed(), 'the tile or the app closed after Browser.close')
    })
  }

  // ---------------- B: security ----------------
  await check('B MCP without a token or with a bad one gives 401', async () => {
    ok(aiConn, 'no mcp url')
    const url = aiConn.url
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    ok((await fetch(url, { method: 'POST', headers: h, body })).status === 401, 'no token is not 401')
    ok((await fetch(url, { method: 'POST', headers: { ...h, authorization: `Bearer ${'0'.repeat(64)}` }, body })).status === 401, 'bad token is not 401')
    ok((await fetch(url, { method: 'POST', headers: { ...h, authorization: 'Bearer short' }, body })).status === 401, 'malformed token is not 401')
    ok((await fetch(url, { method: 'POST', headers: { ...h, ...aiConn.headers, origin: 'http://evil.example' }, body })).status === 403, 'a request with an Origin is not refused')
  })
  await check('B proxy refuses without its secret; raw CDP port not on the LAN IP', async () => {
    ok(aiConn, 'no mcp url')
    const pid = await app.evaluate(() => process.pid)
    const ports = execFileSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort }`], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .filter((l) => /^\d+$/.test(l.trim()))
      .map(Number)
    ok(ports.length > 0, 'no listening ports found for the app (Windows only check)')
    const mcpPort = Number(new URL(aiConn.url).port)
    const raw = (() => {
      const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n === 'DevToolsActivePort' ? [join(d, n)] : []))
      const f = walk(dataDir)[0]
      return f ? Number(readFileSync(f, 'utf8').split(/\r?\n/)[0]) : 0
    })()
    ok(raw, 'DevToolsActivePort not found')
    const others = ports.filter((p) => p !== mcpPort && p !== raw)
    for (const p of others) {
      const code = await new Promise((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p}/cdp/${crewA}/${'00'.repeat(32)}`)
        ws.onopen = () => (ws.close(), res('OPEN'))
        ws.onerror = () => res('refused')
        setTimeout(() => res('timeout'), 4000)
      })
      ok(code !== 'OPEN', `a listener on ${p} accepted a CDP websocket without the secret`)
    }
    ok(ports.includes(raw), 'raw port is not owned by the app (sanity)')
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
    if (lan) {
      const state = await new Promise((res) => {
        const s = connect({ host: lan.address, port: raw, timeout: 3000 })
        s.on('connect', () => (s.destroy(), res('reachable')))
        s.on('error', () => res('refused'))
        s.on('timeout', () => (s.destroy(), res('refused')))
      })
      ok(state === 'refused', `raw CDP port reachable on ${lan.address}`)
    }
  })

  // ---------------- D: the human browser controls ----------------
  await check('D setup: one clean tab on the long fixture page', async () => {
    await fresh(`${base}/long`)
  })
  await check('D hard reload (menu) bypasses the cache; Reload keeps it', async () => {
    const id = await panelId('/long')
    ok(id, 'long page panel not found')
    await panelRun(id, 'window.__m = 1')
    const from = site.hits.length
    await menu('Hard reload')
    await poll('hard reload cleared the marker', async () => (await panelRun(id, 'window.__m ?? null')) === null)
    await poll('a no-cache request for /long', async () => site.hits.slice(from).some((h) => h.path === '/long' && /no-cache/i.test(h.cache)))
  })
  await check('D address-bar suggestions from history', async () => {
    await goto(`${base}/page2`)
    await goto(`${base}/long`)
    const addr = address()
    await addr.click()
    await addr.fill('fixture page')
    const group = page.getByRole('group', { name: 'Address suggestions' })
    await group.waitFor({ timeout: 5000 })
    await shot('suggestions')
    await group.getByRole('button', { name: /Fixture Page Two/ }).click()
    await waitState('suggestion opened', crewA, async (s) => s.tabs.some((t) => t.url === `${base}/page2`))
    await goto(`${base}/long`)
  })
  await check('D tab duplicate', async () => {
    const before = await bstate(crewA)
    const src = before.tabs.find((t) => t.id === before.activeTabId)
    await menu('Duplicate tab')
    await waitState('duplicate', crewA, (s) => s.tabs.length === before.tabs.length + 1 && s.tabs.every((t) => t.url !== ''))
    const s = await bstate(crewA)
    const i = s.tabs.findIndex((t) => t.id === src.id)
    ok(s.tabs[i + 1]?.url === src.url, `the copy is not right after the source with the same URL: ${s.tabs.map((t) => t.url).join(' | ')}`)
  })
  await check('D tab reorder (drag; IPC fallback is flagged)', async () => {
    const before = (await bstate(crewA)).tabs.map((t) => t.id)
    ok(before.length >= 2, 'need two tabs')
    const want = [before[1], before[0], ...before.slice(2)].join(',')
    const tabs = page.getByRole('tab')
    await tabs.nth(0).dragTo(tabs.nth(1)).catch(() => undefined)
    let moved = await poll('drag reorder', async () => (await bstate(crewA)).tabs.map((t) => t.id).join(',') === want, 3000).then(() => true, () => false)
    if (!moved) {
      console.log('  NOTE: the UI drag did not reorder (Playwright HTML5 drag); checking browser:tabMove')
      await inv('browser:tabMove', crewA, before[0], 1)
      moved = await poll('tabMove order', async () => (await bstate(crewA)).tabs.map((t) => t.id).join(',') === want, 5000).then(() => true, () => false)
    }
    ok(moved, `tab order did not become ${want}: ${(await bstate(crewA)).tabs.map((t) => t.id).join(',')}`)
    for (const t of (await bstate(crewA)).tabs.slice(1)) await inv('browser:tabClose', crewA, t.id)
    await waitState('one tab', crewA, (s) => s.tabs.length === 1)
  })
  await check('D zoom in, Reset zoom button, reset', async () => {
    await goto(`${base}/long`)
    await menu('Zoom in')
    await waitState('zoom 110', crewA, (s) => s.tabs[0]?.zoom === 110)
    const reset = page.getByRole('button', { name: 'Reset zoom' })
    await reset.waitFor({ timeout: 5000 })
    ok((await reset.textContent())?.includes('110%'), 'the toolbar button does not say 110%')
    await reset.click()
    await waitState('zoom 100', crewA, (s) => (s.tabs[0]?.zoom ?? 100) === 100)
  })
  await check('D find in page shows n/m', async () => {
    await menu('Find in page')
    await sleep(800) // the native view comes back a moment after the menu closes; find works on the attached view
    const input = page.getByLabel('Find in page', { exact: true })
    await input.fill('needle')
    await poll('count text', async () => /^\d+\/5$/.test(((await input.locator('xpath=following-sibling::span').first().textContent()) ?? '').trim()))
    await input.press('Enter')
    await page.getByRole('button', { name: 'Close find' }).click()
  })
  await check('D view source opens a view-source: tab', async () => {
    await menu('View source')
    await waitState('view-source tab', crewA, (s) => s.tabs.some((t) => t.url.startsWith('view-source:')))
    for (const t of (await bstate(crewA)).tabs.filter((x) => x.url.startsWith('view-source:'))) await inv('browser:tabClose', crewA, t.id)
    await waitState('one tab', crewA, (s) => s.tabs.length === 1)
  })
  const stubSave = (file) => app.evaluate(({ dialog }, f) => void (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })), file)
  await check('D screenshot: visible area and full page to a file', async () => {
    await goto(`${base}/long`)
    const vis = join(root, 'visible.png')
    const full = join(root, 'full.png')
    await stubSave(vis)
    await menu('Screenshot', 'Visible area to file')
    await poll('visible file', async () => existsSync(vis) && statSync(vis).size > 100)
    await stubSave(full)
    await menu('Screenshot', 'Full page to file')
    await poll('full file', async () => existsSync(full) && statSync(full).size > 100)
    const v = pngSize(vis)
    const f = pngSize(full)
    ok(f.h >= 2900, `full page is only ${f.h}px tall`)
    ok(f.h > v.h, `full page (${f.h}) is not taller than the visible area (${v.h})`)
    copyFileSync(vis, join(outDir, 'browser-capture-visible.png'))
    copyFileSync(full, join(outDir, 'browser-capture-full.png'))
  })
  await check('D Save as PDF writes a PDF', async () => {
    const pdf = join(root, 'page.pdf')
    await stubSave(pdf)
    await menu('Save as PDF')
    await poll('pdf file', async () => existsSync(pdf) && statSync(pdf).size > 100)
    ok(readFileSync(pdf).subarray(0, 4).toString() === '%PDF', 'not a PDF')
  })
  await check('D DevTools detached opens and closes', async () => {
    const id = await panelId('/long')
    ok(id, 'panel not found')
    const opened = () => app.evaluate(({ webContents }, i) => webContents.fromId(i).isDevToolsOpened(), id)
    await menu('Developer tools', 'Separate window')
    await poll('devtools open', opened)
    ok((await contents()).some((c) => c.url.startsWith('devtools://')), 'no devtools:// window')
    await menu('Developer tools', 'Close')
    await poll('devtools closed', async () => !(await opened()))
  })

  // ---------------- E: site compatibility ----------------
  const setCompat = async (opts) => {
    await inv('settings:set', { browser: { homeUrl: `${base}/`, perCrew: opts ? { [String(crewA)]: opts } : {} } })
    await sleep(500)
  }
  const titleIs = (re, timeout) => poll(`title ${re}`, async () => re.test((await activeTab()).title), timeout)
  const openssl = (() => {
    for (const exe of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
      const r = spawnSync(exe, ['version'], { windowsHide: true })
      if (r.status === 0) return exe
    }
    return null
  })()
  // Chromium caches the verdict per certificate and host, so each certificate is used for one setting only.
  const makeTls = (n) => {
    if (!openssl) return null
    const key = join(root, `key${n}.pem`)
    const cert = join(root, `cert${n}.pem`)
    const r = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { windowsHide: true })
    return r.status === 0 && existsSync(cert) ? { key: readFileSync(key), cert: readFileSync(cert) } : null
  }
  const tls = makeTls(1)
  const tls2 = makeTls(2)
  if (!tls || !tls2) skip('E self-signed https loads / is refused with ignoreCertErrors off', 'openssl not found or could not make a certificate')
  else {
    const secure = await startSite({ tls })
    const httpsBase = `https://127.0.0.1:${secure.port}`
    await check('E self-signed https on 127.0.0.1 loads with ignoreCertErrors auto', async () => {
      await setCompat(null)
      await goto(`${httpsBase}/page2`)
      await titleIs(/^Fixture Page Two$/, 10_000)
    })
    const secure2 = await startSite({ tls: tls2 })
    // In the beta project: Chromium remembers for the session that alpha already accepted this host's self-signed page.
    await check('E ignoreCertErrors off holds a self-signed page behind a "Proceed anyway" prompt', async () => {
      await inv('settings:set', { browser: { homeUrl: `${base}/`, perCrew: { [String(crewB)]: { ignoreCertErrors: 'off' } } } })
      await sleep(500)
      await inv('browser:open', crewB, `https://127.0.0.1:${secure2.port}/long`)
      const pending = await poll('a certificate prompt', async () => (await inv('browser:promptsState', crewB)).prompts.find((p) => p.kind === 'certificate'), 10_000)
      const s = await bstate(crewB)
      ok(!s.tabs.some((t) => /Fixture Long/.test(t.title)), 'the page loaded although certificate errors are not ignored')
      await inv('browser:promptAnswer', pending.id, { proceed: false })
      await inv('browser:close', crewB)
      await setCompat(null)
    })
    secure.close()
    secure2.close()
  }
  const target = (n) => `${base2}/nocors?n=${n}`
  await check('E relaxCors off: a cross-origin fetch without CORS headers is blocked, no safety badge', async () => {
    await setCompat(null)
    await goto(`${base}/corstest?t=${encodeURIComponent(target(1))}`)
    await titleIs(/Fixture Cors Blocked/, 8000)
    ok((await page.getByRole('status', { name: 'Site safety relaxed' }).count()) === 0, 'the badge shows while relaxCors is off')
  })
  await check('E relaxCors on: the same fetch succeeds and the "Site safety relaxed" badge shows', async () => {
    await setCompat({ relaxCors: true })
    await goto(`${base}/corstest?t=${encodeURIComponent(target(2))}`)
    await titleIs(/Fixture Cors OK/, 8000)
    await page.getByRole('status', { name: 'Site safety relaxed' }).waitFor({ timeout: 5000 }).catch(async (e) => {
      const perCrew = JSON.stringify((await inv('settings:get')).browser.perCrew)
      throw new Error(`${e.message.split('\n')[0]}; settings perCrew=${perCrew}; menus open=${await page.getByRole('menu').count()}; text has "CORS relaxed": ${(await page.locator('body').innerText()).includes('CORS relaxed')}`)
    })
    await shot('relaxed')
  })
  await check('E relaxCors turned off again blocks the fetch and removes the badge', async () => {
    await setCompat(null)
    await goto(`${base}/corstest?t=${encodeURIComponent(target(3))}`)
    await titleIs(/Fixture Cors Blocked/, 8000)
    await poll('badge gone', async () => (await page.getByRole('status', { name: 'Site safety relaxed' }).count()) === 0, 5000)
  })

  // ---------------- C: persistence across a restart ----------------
  await check('C log in on the fixture (sets the cookie)', async () => {
    await goto(`${base}/`)
    const id = await panelId('/')
    ok(id, 'panel not found')
    await panelRun(id, "document.querySelector('form[action=\"/login\"]').submit()")
    await waitState('welcome page', crewA, (s) => s.tabs.some((t) => t.url === `${base}/welcome`))
  })
  await check('C cookie persists across restart for the same project only', async () => {
    await app.close()
    await launch()
    await page.locator('[data-crew-row]').getByText('alpha', { exact: true }).waitFor()
    await page.locator('[data-crew-row]').getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
    await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()
    const open = async (name, crew, who) => {
      const row = page.locator('[data-crew-row]', { hasText: name })
      await row.getByText(name, { exact: true }).hover()
      await row.getByRole('button', { name: `Open browser in ${name}` }).click()
      await address().waitFor({ timeout: 10_000 })
      await waitState(`${name} open`, crew, (s) => s.open && s.tabs.length > 0 && s.tabs.every((t) => !t.loading && t.url !== ''))
      await sleep(300) // the address bar drops a typed draft when the page URL changes
      const addr = address()
      await addr.fill(`${base}/whoami?who=${who}`)
      await addr.press('Enter')
      await poll(`${who} whoami request`, async () => site.seen.some((r) => r.who === who)).catch(async (e) => {
        throw new Error(`${e.message}; tabs: ${(await bstate(crew)).tabs.map((t) => t.url).join(' | ')}; address: ${await addr.inputValue()}`)
      })
    }
    await open('alpha', crewA, 'A')
    ok(site.seen.find((r) => r.who === 'A').cookie.includes(COOKIE_VALUE), 'project alpha lost its login cookie after a restart')
    await page.locator('[data-crew-row]').getByText('beta', { exact: true }).click({ position: { x: 4, y: 4 } })
    await open('beta', crewB, 'B')
    ok(!site.seen.find((r) => r.who === 'B').cookie.includes(COOKIE_VALUE), 'project beta shares the cookie of alpha')
  })

  await check('B output carries no token, secret path or cookie value', async () => {
    const token = aiConn?.headers.Authorization.slice(7)
    ok(token, 'no token to look for')
    ok(!output.includes(token), 'the token is in the app output')
    ok(!output.includes(COOKIE_VALUE), 'the cookie value is in the app output')
    ok(!/\/cdp\/\d+\/[0-9a-f]{32}/.test(output), 'a proxy secret path is in the app output')
    ok(!/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser/.test(output), 'the raw CDP endpoint is in the app output')
  })
} finally {
  await app?.close().catch(() => undefined)
  site.close()
  site2.close()
  rmSync(root, { recursive: true, force: true })
}

const failed = results.filter(([, r]) => r === 'FAIL')
const skipped = results.filter(([, r]) => r === 'skip')
console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`)
for (const b of bugs) console.log(`BUG ${b}`)
if (failed.length) process.exit(1)
console.log('browser e2e ok')
