// Embedded browser with a REAL Claude agent (cheapest model): the agent drives the browser panel through the browser MCP
// while the panel stays visible, then the owner takes control mid-task. Costs a few cents (two short turns on Haiku).
// A throwaway OPERANT_DATA_DIR and CLAUDE_CONFIG_DIR (a copy of ~/.claude/.credentials.json, deleted at the end, never printed);
// the real claude is on PATH, the fake one is not.
// Usage: node e2e/browser-real.mjs [outDir]  (default docs/specs/screenshots)
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startSite } from './fixtures/site/server.mjs'

const MODEL = 'claude-haiku-5-5'
const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'operant-browser-real-'))
const dataDir = join(root, 'data')
const claudeDir = join(root, 'claude')
const project = join(root, 'alpha')
for (const d of [dataDir, claudeDir, project, join(project, '.claude')]) mkdirSync(d, { recursive: true })
copyFileSync(join(homedir(), '.claude', '.credentials.json'), join(claudeDir, '.credentials.json'))
// The browser tools are allowed for this throwaway project so the run does not stop on permission prompts.
writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__operant-browser'] } }))
const cwd = realpathSync.native(project)

const site = await startSite()
const base = `http://127.0.0.1:${site.port}`
const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push([name, 'pass'])
    console.log(`PASS ${name}`)
  } catch (e) {
    results.push([name, 'FAIL'])
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const poll = async (label, fn, timeout = 20_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) {
    const v = await fn().catch(() => false)
    if (v) return v
  }
  throw new Error(`timed out waiting for ${label}`)
}

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
delete env.OPERANT_E2E
let app
try {
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForFunction(() => !!window.operant)
  const inv = (c, ...a) => page.evaluate(([ch, args]) => window.operant.invoke(ch, ...args), [c, a])
  const shot = async (n) => (await sleep(400), page.screenshot({ path: join(outDir, `browser-real-${n}.png`) }))
  await inv('settings:set', { mainCli: 'claude', browser: { homeUrl: `${base}/`, autonomy: 'full' } })
  const crew = await inv('crews:create', { name: 'alpha', folder: cwd })
  await page.locator('[data-crew-row]').getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  const row = page.locator('[data-crew-row]', { hasText: 'alpha' })
  await row.getByText('alpha', { exact: true }).hover()
  await row.getByRole('button', { name: 'Open browser in alpha' }).click()
  await page.getByLabel('Address').waitFor({ timeout: 10_000 })

  const tile = await inv('scratch:create', { crewId: crew.id, title: 'real', agent: 'claude', model: MODEL })
  await inv('scratch:start', tile.id)
  const snap = () => inv('chat:snapshot', tile.id)
  await poll('claude to be ready', async () => (await snap()).process === 'ready', 90_000)

  await check('a REAL claude.exe runs with the haiku model and the browser MCP config', async () => {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -like '*browser-mcp.json*' } | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true })
    const line = out.split(/\r?\n/).find((l) => l.includes('browser-mcp.json'))
    ok(line, 'no real claude.exe with --mcp-config browser-mcp.json found')
    ok(line.includes(`--model ${MODEL}`), `model flag is not ${MODEL}: ${line.slice(0, 300)}`)
    ok(!/fake-claude/.test(line), 'that is the fake claude')
    console.log(`  launch: ${line.replace(/\s+/g, ' ').slice(0, 260)}`)
  })

  const turn = async (prompt, timeout = 240_000) => {
    const before = (await snap()).items.length
    await inv('chat:send', tile.id, { text: prompt })
    await poll('the turn to start', async () => (await snap()).turn.phase !== 'idle', 30_000)
    return before
  }
  const idle = (timeout) => poll('the turn to finish', async () => (await snap()).turn.phase === 'idle', timeout)
  const tools = (s, from = 0) => s.items.slice(from).filter((i) => i.kind === 'tool').map((i) => i.name)
  const lastText = (s) => [...s.items].reverse().find((i) => i.kind === 'text')?.md ?? ''

  // ---- Run 1: the agent does a whole task while the panel stays visible ----
  let r1 = 0
  await check('run 1: the agent logs in, reads the console error and takes a screenshot (panel visible)', async () => {
    r1 = await turn(
      `Use ONLY the operant-browser MCP tools. Open ${base}/, log in with username test and password test, then call the console messages tool for errors and take one screenshot. Reply with one line: DONE then the console error text.`,
    )
    await poll('the AI pill', async () => (await page.getByRole('status').filter({ hasText: 'AI is controlling' }).count()) > 0, 90_000)
    await shot('ai-controlling')
    await idle(240_000)
    const s = await snap()
    const used = tools(s, r1)
    console.log(`  tools used: ${used.join(', ')}`)
    ok(used.some((n) => n.startsWith('mcp__operant-browser__')), `no browser tool was used: ${used.join(',')}`)
    ok(!used.some((n) => /Playwright|playwright|chrome/i.test(n) && !n.startsWith('mcp__operant-browser__')), 'a different browser tool was used')
    ok(/fixture-console-error/.test(lastText(s)) || s.items.slice(r1).some((i) => i.kind === 'tool' && JSON.stringify(i.result ?? '').includes('fixture-console-error')), `the console error was not reported: ${lastText(s).slice(0, 200)}`)
    const b = await inv('browser:state', crew.id)
    ok(b.open && b.tabs.length >= 1, 'the browser closed when the AI finished')
    ok(b.tabs.some((t) => t.url.includes('/welcome')), `the browser is not on the logged-in page: ${b.tabs.map((t) => t.url).join(',')}`)
    ok(!b.ai.paused, 'still paused')
    console.log(`  cost so far: ${s.costUsd ?? 'n/a'} USD`)
    await shot('after-run-1')
  })

  await check('after the AI finishes the user can keep browsing in the same session', async () => {
    const addr = page.getByLabel('Address')
    await addr.fill(`${base}/page2`)
    await addr.press('Enter')
    await poll('user navigation', async () => (await inv('browser:state', crew.id)).tabs.some((t) => t.url === `${base}/page2`))
  })

  // ---- Run 2: Take control mid-task ----
  await check('run 2: Take control pauses the real agent, Let AI continue resumes it', async () => {
    const from = await turn(
      `Use ONLY the operant-browser MCP tools. Open ${base}/slow?ms=4000, then ${base}/page2, then ${base}/, then take one snapshot. Reply with one line: DONE.`,
    )
    await poll('AI active', async () => (await inv('browser:state', crew.id)).ai.active, 90_000)
    await page.getByRole('button', { name: 'Take control' }).click()
    await poll('paused', async () => (await inv('browser:state', crew.id)).ai.paused, 10_000)
    await shot('paused')
    const doneAtPause = (await snap()).items.slice(from).filter((i) => i.kind === 'tool' && i.status === 'done').length
    await sleep(6000)
    const doneLater = (await snap()).items.slice(from).filter((i) => i.kind === 'tool' && i.status === 'done').length
    ok(doneLater <= doneAtPause + 1, `the agent kept finishing calls while paused (${doneAtPause} -> ${doneLater})`)
    ok((await snap()).turn.phase !== 'idle', 'the turn ended while the user had control')
    await page.getByRole('button', { name: 'Let AI continue' }).click()
    await idle(240_000)
    const s = await snap()
    ok(/DONE/i.test(lastText(s)), `the agent did not finish: ${lastText(s).slice(0, 200)}`)
    const b = await inv('browser:state', crew.id)
    ok(b.open && !b.ai.paused, 'browser closed or still paused at the end')
    await shot('after-run-2')
    console.log(`  total cost: ${s.costUsd ?? 'n/a'} USD`)
  })

  // ---- Run 3: the default autonomy (confirm risky actions) asks before typing a password; Allow lets it finish ----
  await check('run 3: confirm mode asks before typing a password; Allow AI action lets the agent finish', async () => {
    await inv('settings:set', { browser: { homeUrl: `${base}/`, autonomy: 'confirm' } })
    await inv('browser:navigate', crew.id, (await inv('browser:state', crew.id)).activeTabId, `${base}/logout`).catch(() => undefined)
    await turn(`Use ONLY the operant-browser MCP tools. Open ${base}/, log in with username test and password test. Reply with one line: DONE.`)
    const allow = page.getByRole('button', { name: 'Allow AI action' })
    for (let i = 0; i < 6; i++) {
      const asked = await allow.waitFor({ timeout: i === 0 ? 120_000 : 15_000 }).then(() => true, () => false)
      if (!asked) break
      if (i === 0) await shot('confirm-bar')
      await allow.click()
    }
    await idle(240_000)
    const s = await snap()
    ok(/DONE/i.test(lastText(s)), `the agent did not finish: ${lastText(s).slice(0, 200)}`)
    const acts = await inv('browser:actions', crew.id)
    ok(acts.some((a) => a.status === 'done'), 'no AI action in the log')
    ok(!JSON.stringify(acts).includes('"test"') || !acts.some((a) => /password/i.test(a.summary) && /\btest\b/.test(a.summary)), 'a password value shows in the action log')
    console.log(`  total cost: ${s.costUsd ?? 'n/a'} USD`)
  })
} finally {
  await app?.close().catch(() => undefined)
  site.close()
  rmSync(root, { recursive: true, force: true })
}
const failed = results.filter(([, r]) => r === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
console.log('browser real-claude e2e ok')
