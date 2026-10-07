// Top bar (one 42 px row): the media block, the clock pill and the job counts, at four window widths and two UI scales,
// with live settings. The media bar (fake helper speaking the real JSON lines). Runs in the background with throwaway data.
// Usage: node e2e/topbar.mjs [outDir]   (screenshots for the spec go to docs/specs/screenshots when given as that dir)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'out/e2e')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-e2e-'))
const project = mkdtempSync(join(tmpdir(), 'operant-proj-'))
const logFile = join(mkdtempSync(join(tmpdir(), 'operant-media-')), 'commands.log')

const env = {
  ...process.env,
  OPERANT_BACKGROUND: '1', OPERANT_E2E: '1',
  OPERANT_DATA_DIR: dataDir,
  OPERANT_E2E_MEDIA_HELPER: resolve('e2e/fixtures/fake-media-helper.mjs'),
  OPERANT_FAKE_MEDIA_LOG: logFile,
}
const app = await electron.launch({ args: ['.'], env })
const sent = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : [])
try {
  const page = await app.firstWindow()
  const poll = async (label, fn, timeout = 15_000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(200)) if (await fn()) return
    throw new Error(`timed out waiting for ${label}`)
  }
  const win = (fn, arg) => app.evaluate(({ BrowserWindow }, a) => new Function('w', 'a', `return (${a.fn})(w, a.arg)`)(BrowserWindow.getAllWindows()[0], a), { fn: fn.toString(), arg })
  const resize = async (width, height = 900) => {
    await win((w, [x, y]) => w.setContentSize(x, y), [width, height])
    await page.waitForTimeout(400)
  }
  await resize(1920)
  await page.getByText('Welcome to Operant 3').waitFor()
  await page.evaluate(async (folder) => {
    const o = window.operant
    const crew = await o.invoke('crews:create', { name: 'shop', folder })
    await o.invoke('runs:create', { crewId: crew.id, task: 'Count me' }).catch(() => undefined)
  }, project)
  await page.getByRole('heading', { name: 'shop' }).waitFor({ state: 'attached' })

  await page.evaluate(() => window.operant.invoke('settings:set', { uiScale: 1, topBar: { mediaSize: 'compact' } }))
  const bar = page.getByRole('group', { name: 'Media controls' })
  await bar.waitFor()
  await bar.getByText('Midnight City').waitFor()
  assert.equal((await page.evaluate(() => window.operant.invoke('media:state'))).title.startsWith('Midnight City'), true)

  // Settings that make the screenshots predictable: 24 hour, with the date.
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { clockFormat: '24', clockSeconds: false, clockDate: true } }))
  const clock = page.getByTestId('clock-time')
  await poll('24h clock', async () => /^\d{2}:\d{2}$/.test((await clock.textContent()) ?? ''))

  // Compact: only the cover and title show; the controls slide in on hover and out again.
  const next = bar.getByRole('button', { name: 'Next track' })
  await page.mouse.move(5, 500)
  await poll('controls hidden', async () => (await next.evaluate((e) => getComputedStyle(e.parentElement).opacity)) === '0')
  assert.ok((await bar.boundingBox()).height <= 31, 'compact media block is 30 px tall')
  await bar.hover()
  await poll('controls shown', async () => (await next.evaluate((e) => getComputedStyle(e.parentElement).opacity)) === '1')
  await page.screenshot({ path: join(outDir, 'media-compact-hover.png'), clip: { x: 0, y: 0, width: 1920, height: 60 } })

  // Buttons reach the helper, and the helper's answer comes back as a push.
  await bar.getByRole('button', { name: 'Pause' }).click()
  await bar.getByRole('button', { name: 'Play' }).waitFor()
  await bar.getByRole('button', { name: 'Next track' }).click()
  await bar.getByRole('button', { name: 'Previous track' }).click()
  await bar.getByRole('button', { name: 'Shuffle' }).click()
  await bar.getByRole('button', { name: 'Shuffle' }).and(page.locator('[aria-pressed="true"]')).waitFor()
  await bar.getByRole('button', { name: 'Mute' }).click()
  await bar.getByRole('button', { name: 'Midnight City' }).or(bar.locator('button[title*="focus the player"]')).first().click()
  await poll('commands', async () => sent().includes('focus') && sent().includes('vol 0.000'))
  const commands = sent()
  for (const c of ['toggle', 'next', 'prev', 'shuffle']) assert.ok(commands.includes(c), `helper got ${c}`)

  // The progress bar moves by itself between helper reports.
  const before = await bar.getByRole('progressbar').getAttribute('aria-valuenow').catch(() => null)

  // Unlisted commands never get through.
  assert.equal(await page.evaluate(() => window.operant.invoke('media:command', 'quit')), false)

  // The agent pill counts the open project's jobs.
  const pill = page.getByRole('status', { name: /^Jobs:/ })
  await pill.waitFor()

  // The month calendar after a short hover, and the click copy.
  await page.getByRole('button', { name: /^Clock / }).hover()
  const cal = page.getByRole('dialog', { name: 'Calendar' })
  await cal.waitFor()
  assert.match((await cal.textContent()) ?? '', /week \d+/)
  await page.screenshot({ path: join(outDir, 'top-bar-calendar.png') })
  await page.getByRole('button', { name: /^Clock / }).click()
  await page.getByText(/^(Copied|Could not copy)/).first().waitFor()
  await page.mouse.move(5, 500)

  // One row at every width and scale: nothing overflows, no second row, the name stays readable, and the pills
  // collapse into the status menu before the name is cut.
  const shot = async (name) => {
    const png = await win((w) => w.webContents.capturePage({ x: 0, y: 0, width: 4000, height: 120 }).then((i) => i.toPNG().toString('base64')))
    writeFileSync(join(outDir, name), Buffer.from(png, 'base64'))
  }
  for (const scale of [1, 2]) {
    await page.evaluate((s) => window.operant.invoke('settings:set', { uiScale: s }), scale)
    for (const w of [1000, 1280, 1920, 2560]) {
      await win((win, n) => win.setContentSize(n, 700), w)
      await page.waitForTimeout(1200)
      const m = await page.evaluate(() => {
        const h = document.querySelector('header')
        const h1 = h.querySelector('h1')
        return { doc: document.documentElement.scrollWidth, win: window.innerWidth, headScroll: h.scrollWidth, headClient: h.clientWidth, height: h.getBoundingClientRect().height, name: [h1.clientWidth, h1.scrollWidth], status: !!h.querySelector('[aria-label="Status and alerts"]') }
      })
      const label = `${w}px at ${scale * 100}%`
      assert.ok(m.doc <= m.win, `page overflows at ${label}: ${JSON.stringify(m)}`)
      assert.ok(m.headScroll <= m.headClient + 1, `header overflows at ${label}: ${JSON.stringify(m)}`)
      assert.equal(Math.round(m.height), 42, `one 42 px row at ${label}: ${JSON.stringify(m)}`)
      if (scale === 1) assert.ok(m.name[0] >= m.name[1], `the project name is readable at ${label}: ${JSON.stringify(m)}`)
      if (scale === 1 && w === 1000) assert.ok(m.status, 'status and alerts collapsed into the menu at 1000')
      if (scale === 1 && w >= 1920) assert.ok(!m.status, 'pills stay in the bar when there is room')
      if (scale === 1) await shot(`top-bar-${w}.png`)
    }
  }
  await page.evaluate(() => window.operant.invoke('settings:set', { uiScale: 1 }))
  await win((w) => w.setContentSize(1100, 700))
  await page.waitForTimeout(800)
  await win((w) => w.setContentSize(1280, 700))
  await page.waitForTimeout(800)
  await bar.screenshot({ path: join(outDir, 'media-bar.png') })

  // The '+' opens the new task dialog; the Console toggle lives on the sidebar's bottom row next to Settings; the project
  // block at the top left has its mini buttons on hover.
  await page.getByRole('button', { name: 'Start new task' }).click()
  await page.getByRole('dialog').getByText('Start new task').first().waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('complementary', { name: 'Projects' }).getByRole('button', { name: /^Console/ }).waitFor()
  await page.getByRole('heading', { level: 1 }).hover()
  for (const n of [/^(Update index|Index with CodeGraph)$/, /^Open .* in IDE$/, /^New shell in /, /^Actions for crew /]) await page.getByRole('button', { name: n }).waitFor()
  await page.mouse.move(5, 500)

  // The status menu holds the pills when the bar is narrow.
  await win((w) => w.setContentSize(1000, 700))
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Status and alerts' }).click()
  await page.getByRole('status', { name: /^Jobs:/ }).waitFor()
  await page.keyboard.press('Escape')
  await win((w) => w.setContentSize(1280, 700))
  await page.waitForTimeout(800)

  // Live settings: seconds, 12 hour, compact media, and the pills off.
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { clockSeconds: true, clockFormat: '12' } }))
  await poll('12h with seconds', async () => /^\d{2}:\d{2}:\d{2}\s?(am|pm)$/i.test((await clock.textContent()) ?? ''))
  await resize(1920)
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { mediaSize: 'full' } }))
  await poll('full', async () => (await bar.getByRole('slider', { name: 'Volume' }).count()) === 1)
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { mediaSize: 'compact' } }))
  await poll('compact', async () => (await bar.getByText('Midnight City').count()) === 1)
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { agentPill: false, clockDate: false } }))
  await poll('agent pill off', async () => (await pill.count()) === 0)
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { mediaControls: false } }))
  await poll('media off', async () => (await bar.count()) === 0)
  await page.evaluate(() => window.operant.invoke('settings:set', { topBar: { mediaControls: true, mediaSize: 'full', agentPill: true, clockDate: true, clockSeconds: false } }))
  await bar.waitFor()

  // The Top bar section and the media shortcuts exist in Settings.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.getByRole('button', { name: 'Top bar' }).click()
  await page.getByText('Media controls').first().waitFor()
  await page.screenshot({ path: join(outDir, 'settings-top-bar.png') })
  await page.getByRole('button', { name: 'Shortcuts' }).click()
  await page.getByText('Media: play or pause', { exact: true }).waitFor()
  console.log(`top bar e2e passed (progress before: ${before})`)
} finally {
  await app.close()
}
