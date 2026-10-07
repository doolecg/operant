// Scale e2e: seeded data (projects and a group, jobs with agents, usage, lessons, seats and a team), the REAL window
// maximized with BrowserWindow.maximize(), and every screen checked for what fills the window: the Master Terminal and
// both drawers refit (xterm cols and rows grow), the job cards and panels reach the bottom and right edges, nothing
// scrolls sideways, and the UI scale follows the window (and the UI scale setting and Ctrl+= / Ctrl+- / Ctrl+0).
// Usage: node e2e/scale.mjs [outDir]   (screenshots scale-max-*.png go to docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { coverage, realWindow } from './winapi.mjs'

const outDir = resolve(process.argv[2] ?? 'out/e2e')
const shots = resolve('docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-scale-'))
const project = mkdtempSync(join(tmpdir(), 'operant-scale-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-scale-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const packaged = process.env.OPERANT_E2E_EXE
const app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()
  const inv = (c, ...a) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [c, a])

  // Seed: four projects (two in a group), seats and a team, jobs with agents, usage rows, lessons.
  const crews = []
  for (const n of ['alpha', 'beta', 'gamma', 'delta']) crews.push(await inv('crews:create', { name: n, folder: project }))
  const group = await inv('groups:create', 'Games')
  await inv('groups:move', crews[2].id, group.id)
  await inv('groups:move', crews[3].id, group.id)
  const presets = await inv('presets:list')
  await inv('teams:create', {
    name: 'duo',
    seats: [
      { presetId: presets.find((p) => p.builtin === 'pm').id, count: 1, model: 'sonnet' },
      { presetId: presets.find((p) => p.builtin === 'reviewer').id, count: 2, model: 'haiku' },
    ],
  })
  writeFileSync(
    join(claudeDir, 'learn-response.json'),
    JSON.stringify([
      { kind: 'convention', text: 'Unit tests live next to the code as .test.ts files and run with vitest.', files: ['app.ts'], symbols: [], scope: 'project', supersedes: [] },
      { kind: 'pitfall', text: 'Running vitest from a subfolder misses the root config, so test imports fail.', files: [], symbols: [], scope: 'project', supersedes: [] },
    ]),
  )
  const runs = []
  for (const t of ['Add a health check to app.ts', 'Fix the login bug', 'Refactor the store', 'Write the docs', 'Speed up the build', 'Tidy the settings page']) {
    runs.push(await inv('runs:create', { crewId: crews[0].id, task: t, masterCli: 'claude' }))
  }
  const db = new DatabaseSync(join(dataDir, 'operant.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  const agent = db.prepare('INSERT INTO job_agents (run_id, seat, model, status, transcript_ref) VALUES (?, ?, ?, ?, ?)')
  const pm = Number(agent.run(runs[0].id, 'pm', 'claude-opus-5-5', 'working', 'a1.jsonl').lastInsertRowid)
  agent.run(runs[0].id, 'reviewer', 'claude-haiku-4-5', 'done', 'a2.jsonl')
  const add = db.prepare(
    `INSERT INTO usage (at, model, input_tokens, output_tokens, cache_read, cache_w5m, cache_w1h, cost_usd, crew_id, run_id, job_agent_id, cli, provider, source, seat, ext_key, legacy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  )
  const NOW = Date.now()
  for (let d = 0; d < 14; d++) {
    add.run(NOW - d * 86400000 - 600_000, 'claude-sonnet-5-5', 30_000 + d * 700, 5_000, 180_000, 20_000, 0, 0.55 + (d % 5) * 0.18, crews[0].id, null, null, 'claude', 'anthropic', 'operator', 'builder', `scale-${d}`)
  }
  add.run(NOW - 600_000, 'claude-opus-5-5', 15_000, 3_000, 80_000, 6_000, 0, 0.88, crews[0].id, runs[0].id, pm, 'claude', 'anthropic', 'agent', 'pm', 'scale-job')
  db.prepare("UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), runs[5].id)
  db.close()
  await inv('settings:set', { learn: { review: 'auto' } })
  await inv('learn:run', runs[5].id)
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  if (!(await page.getByRole('heading', { name: 'alpha', level: 1 }).count())) await page.getByText('alpha', { exact: true }).first().click()
  await page.getByRole('heading', { name: 'alpha', level: 1 }).waitFor()

  const win = (fn, arg) => app.evaluate(({ BrowserWindow, screen }, a) => new Function('w', 's', 'a', `return (${a.fn})(w, s, a.arg)`)(BrowserWindow.getAllWindows()[0], screen, a), { fn: fn.toString(), arg })
  const noHScroll = (label) =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1).then((ok) => assert.ok(ok, `no horizontal scroll: ${label}`))
  const box = async (loc) => (await loc.first().boundingBox()) ?? assert.fail('missing box')
  const view = () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }))
  const shot = async (name) => {
    await sleep(500)
    // The window's own pixels: Playwright's page screenshot clips to the unzoomed viewport when the page zoom is above 100%.
    const png = await win((w) => w.webContents.capturePage().then((i) => i.toPNG().toString('base64')))
    writeFileSync(join(shots, `scale-max-${name}.png`), Buffer.from(png, 'base64'))
  }
  const mode = (l) => page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: l, exact: true })
  const termRows = () => page.evaluate(() => document.querySelector('.xterm-rows')?.children.length ?? 0)
  const zoom = () => win((w) => w.webContents.getZoomFactor())

  // The REAL OS window: ShowWindow(SW_MAXIMIZE) through user32, then what is on the display must fill the client area
  // (the page used to stay at the old size in the top-left corner, the rest black), with automatic and fixed scales.
  const pid = await app.evaluate(() => process.pid)
  const real = realWindow(pid)
  const filled = async (label) => {
    await sleep(1800)
    const m = real.measure()
    const c = coverage(m)
    console.log('real window', label, JSON.stringify(m), `coverage ${(c * 100).toFixed(1)}%`)
    assert.ok(m.zoomed, `${label}: the OS window is maximized`)
    assert.ok(c >= 0.98, `${label}: the painted area covers the client area (${m.paintedBox} of ${m.client})`)
  }
  for (const [label, setting] of [['auto', 0], ['fixed 100%', 1], ['fixed 175%', 1.75]]) {
    await inv('settings:set', { uiScale: setting })
    await sleep(600)
    real.maximize()
    await filled(`maximize, ${label}`)
    real.restore()
    await sleep(1000)
  }
  await inv('settings:set', { uiScale: 0 })
  await sleep(600)

  // Other Windows display scales: the same real maximize at device scale factors 1.25 and 1.75, automatic and fixed.
  for (const dsf of ['1.25', '1.75']) {
    const dir = mkdtempSync(join(tmpdir(), 'operant-scale-dsf-'))
    const a2 = await electron.launch({ args: ['.', `--force-device-scale-factor=${dsf}`], env: { ...env, OPERANT_DATA_DIR: dir } })
    try {
      const p2 = await a2.firstWindow()
      await p2.waitForFunction(() => !!window.operant)
      const w2 = realWindow(await a2.evaluate(() => process.pid))
      for (const [label, setting] of [['auto', 0], ['fixed 100%', 1]]) {
        await p2.evaluate((u) => window.operant.invoke('settings:set', { uiScale: u }), setting)
        await sleep(800)
        w2.maximize()
        await sleep(1800)
        const m = w2.measure()
        console.log('real window', `scale factor ${dsf}`, label, JSON.stringify(m), `coverage ${(coverage(m) * 100).toFixed(1)}%`)
        assert.ok(m.zoomed && coverage(m) >= 0.98, `device scale ${dsf}, ${label}: the painted area covers the client area (${m.paintedBox} of ${m.client})`)
        w2.restore()
        await sleep(800)
      }
    } finally {
      await a2.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Master Terminal running (fake claude stays alive), at the default window size first.
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.locator('.xterm').first().waitFor()
  await sleep(1500)
  await win((w) => w.isMaximized() && w.unmaximize())
  await win((w) => w.setContentSize(1440, 860))
  await sleep(1000)
  const small = { rows: await termRows(), zoom: await zoom() }
  await noHScroll('1440x860')

  // Real maximize.
  await win((w) => w.maximize())
  await page.waitForFunction(() => window.innerWidth > 1500)
  await sleep(1500)
  const wa = await win((w, s) => ({ ...s.getPrimaryDisplay().workAreaSize, max: w.isMaximized() }))
  assert.ok(wa.max, 'the window is maximized')
  const z = await zoom()
  const v = await view()
  console.log('maximized', JSON.stringify({ workArea: [wa.width, wa.height], inner: [v.w, v.h], dpr: v.dpr, zoom: z, before: small.zoom }))
  assert.ok(Math.abs(v.w * z - wa.width) <= 24, `the page fills the work area width (${v.w} x ${z} of ${wa.width})`)
  assert.ok(v.h * z >= wa.height - 80, `the page fills the work area height (${v.h} x ${z} of ${wa.height})`)
  // The UI scale follows the window: above 100% once the window is well above 1600x900, never below it on auto.
  const expectScale = await page.evaluate(() => {
    const f = Math.min(window.outerWidth / 1600, window.outerHeight / 900)
    return Math.round(Math.min(1.75, Math.max(1, f)) * 20) / 20
  })
  assert.equal(z, expectScale, 'automatic UI scale follows the window size')
  if (wa.width >= 1900 && wa.height >= 1000) assert.ok(z > small.zoom, `the UI scale grew on maximize (${small.zoom} to ${z})`)
  await noHScroll('maximized workspace')

  const rows = await termRows()
  assert.ok(rows > small.rows || z > small.zoom, `xterm refits on maximize (rows ${small.rows} to ${rows})`)
  const masterArea = await box(page.getByRole('region', { name: 'Master Terminal' }))
  const mt = await box(page.locator('.xterm-screen'))
  assert.ok(mt.height >= (masterArea.height - 44) * 0.85, `terminal fills the Master height (${mt.height} of ${masterArea.height})`)
  assert.ok(mt.width >= masterArea.width * 0.85, `terminal fills the Master width (${mt.width} of ${masterArea.width})`)
  const panels = await box(page.getByRole('region', { name: 'Workspace panels' }))
  assert.ok(panels.x + panels.width >= v.w - 2, 'right column reaches the right edge')
  assert.ok(panels.y + panels.height >= v.h - 2, 'right column reaches the bottom edge')
  assert.ok(panels.width >= v.w * 0.25 && panels.width <= v.w * 0.45, `right column is a proportionate share (${panels.width} of ${v.w})`)
  await shot('workspace')

  // Cards stay in the column; the job panel fills it; the agent view fills the panel.
  const cards = page.getByRole('button', { name: /Open JOB#/ })
  const first = await box(cards)
  assert.ok(first.x >= panels.x && first.x + first.width <= panels.x + panels.width + 1, 'cards stay inside the column')
  await cards.first().click()
  const panel = page.getByRole('region', { name: `Job panel JOB#${runs[0].id}` })
  await panel.waitFor()
  const pb = await box(panel)
  assert.ok(pb.y + pb.height >= v.h - 2 && pb.x + pb.width >= v.w - 2, 'job panel reaches the window edge')
  await shot('job-panel')
  await panel.getByRole('button', { name: 'Open agent pm' }).click()
  await panel.getByText('Read-only').waitFor()
  await shot('agent-view')
  const log = await box(panel.getByRole('log'))
  assert.ok(log.y + log.height >= v.h - 40, `the agent log runs to the bottom (${log.y + log.height} of ${v.h})`)
  await panel.getByRole('button', { name: 'Close job panel' }).click()

  // The other tabs of the right column.
  for (const t of ['Board', 'Messages', 'Activity', 'Usage']) {
    await page.getByRole('tab', { name: new RegExp(`^${t}`) }).click()
    await sleep(500)
    await noHScroll(`tab ${t}`)
    await shot(`tab-${t.toLowerCase()}`)
  }
  await page.getByRole('tab', { name: /^Runs/ }).click()

  // The new-task dialog stays inside the window.
  await page.getByRole('button', { name: 'Start new task' }).click()
  const dlg = await box(page.getByRole('dialog'))
  assert.ok(dlg.x >= 0 && dlg.y >= 0 && dlg.x + dlg.width <= v.w && dlg.y + dlg.height <= v.h, 'the new-task dialog fits the window')
  await shot('dialog')
  await page.keyboard.press('Escape')

  // Terminal and Console drawers: a share of the window height, and their xterm fills them.
  await page.keyboard.press('Alt+Shift+T')
  const drawer = page.getByRole('region', { name: 'Terminals' })
  await drawer.waitFor()
  await sleep(1500)
  const d1 = await box(drawer)
  assert.ok(d1.height >= v.h * 0.25 && d1.y + d1.height >= v.h - 2, `terminal drawer is a share of the height (${d1.height} of ${v.h})`)
  const dterm = await box(drawer.locator('.xterm-screen'))
  assert.ok(dterm.width >= d1.width * 0.85, `drawer terminal fills the width (${dterm.width} of ${d1.width})`)
  assert.ok(dterm.height >= (d1.height - 40) * 0.7, `drawer terminal fills the height (${dterm.height} of ${d1.height})`)
  await shot('terminal-drawer')
  await page.getByRole('button', { name: 'Hide terminals' }).click()
  await page.keyboard.press('Control+j')
  const cons = page.getByRole('region', { name: 'Console' })
  await cons.waitFor()
  const cb = await box(cons)
  assert.ok(cb.height >= v.h * 0.25 && cb.y + cb.height >= v.h - 2, 'console drawer is a share of the height')
  await shot('console')
  await page.keyboard.press('Control+j')

  // Seats and Memory.
  for (const m of ['Seats', 'Memory']) {
    await mode(m).click()
    await sleep(900)
    await noHScroll(m)
    await shot(m.toLowerCase())
  }
  await mode('Workspace').click()

  // Settings: every section stays inside the window; shots of General and Shortcuts.
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  const names = await page.locator('main nav button').allInnerTexts()
  assert.ok(names.length >= 8, 'settings sections found')
  for (const n of names) {
    await page.locator('main nav button', { hasText: n }).first().click()
    await sleep(350)
    await noHScroll(`settings ${n}`)
    const c = await box(page.getByTestId('settings-content'))
    assert.ok(c.width >= v.w * 0.5, `settings ${n} content uses the width (${c.width} of ${v.w})`)
    if (n === 'General' || n === 'Shortcuts') await shot(`settings-${n.toLowerCase()}`)
  }

  // UI scale: General has the select, Ctrl+= and Ctrl+- step it, Ctrl+0 returns to automatic.
  await page.locator('main nav button', { hasText: 'General' }).first().click()
  await page.getByRole('combobox', { name: 'UI scale' }).waitFor()
  await inv('settings:set', { uiScale: 1 })
  await sleep(500)
  assert.equal(await zoom(), 1, 'a fixed 100% scale is applied live')
  await page.keyboard.press('Control+=')
  await sleep(500)
  assert.equal((await inv('settings:get')).uiScale, 1.1, 'Ctrl+= steps the scale up')
  assert.equal(await zoom(), 1.1)
  await page.keyboard.press('Control+-')
  await sleep(300)
  await page.keyboard.press('Control+-')
  await sleep(500)
  assert.equal((await inv('settings:get')).uiScale, 0.9, 'Ctrl+- steps it down')
  await page.keyboard.press('Control+0')
  await sleep(500)
  assert.equal((await inv('settings:get')).uiScale, 0, 'Ctrl+0 returns to automatic')
  assert.equal(await zoom(), expectScale, 'automatic scale is back')

  // Settings closes with its X, Esc and Ctrl+,.
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('region', { name: 'Master Terminal' }).waitFor()
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('region', { name: 'Master Terminal' }).waitFor()

  // Back to a normal window: nothing sticks to the maximized size.
  await win((w) => w.unmaximize())
  await sleep(1000)
  await win((w) => w.setContentSize(1100, 700))
  await sleep(1000)
  await noHScroll('1100x700 after unmaximize')
  const pn = await box(page.getByRole('region', { name: 'Workspace panels' }))
  const nv = await view()
  assert.ok(pn.x + pn.width >= nv.w - 2, 'right column reaches the edge after unmaximize')

  console.log('scale e2e passed; screenshots in', shots)
} finally {
  await app.close()
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}
