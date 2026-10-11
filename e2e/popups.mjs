// Popups and resize e2e: with many items (300 OpenCode models, 25 groups, 40 MCP servers) every dialog and
// menu stays inside a small window (1000x640) and at UI scale 200%, with its header and footer in view and its body
// scrolling; every dialog type fits at 1000x640, 1920x1080 and UI scale 200% (large ones fill the window at 1080p); long model lists get a filter box; the project list resizes by drag and keyboard and persists across a restart.
// Usage: node e2e/popups.mjs   (screenshots go to docs/specs/screenshots)
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { claudeHome, e2eEnv } from './fixtures/real-claude.mjs'

const shots = resolve('docs/specs/screenshots')
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-popups-'))
const project = mkdtempSync(join(tmpdir(), 'operant-popups-proj-'))
const claudeRoot = mkdtempSync(join(tmpdir(), 'operant-popups-claude-'))
const claudeDir = claudeHome(claudeRoot)
process.on('exit', () => rmSync(claudeRoot, { recursive: true, force: true }))
const ocFile = join(dataDir, 'opencode.json')
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
execSync('git init -q', { cwd: project })
for (let i = 0; i < 60; i++) writeFileSync(join(project, `changed-file-${i}.ts`), 'x')
const servers = {}
for (let i = 0; i < 40; i++) servers[`mcp-server-${String(i).padStart(2, '0')}`] = { type: 'stdio', command: 'npx', args: [`srv-${i}`] }
writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: servers }))
writeFileSync(ocFile, JSON.stringify({ mcp: { servers: {} } }))

const env = e2eEnv({ dataDir, claudeDir, extra: { OPENCODE_CONFIG: ocFile, OPENCODE_FAKE_MODELS: '300' } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Settings pages: the nav buttons, or the page select below 900px wide (UI scale 200% and small windows).
const openSettingsPage = async (label) => {
  const select = page.getByRole('combobox', { name: 'Settings page' })
  if (await select.isVisible().catch(() => false)) return select.selectOption({ label })
  await page.locator('main nav button', { hasText: label }).first().click()
}

let app = null
let page = null
const launch = async () => {
  app = await electron.launch({ args: ['.'], env })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
}
const inv = (c, ...a) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [c, a])
const win = (fn, arg) => app.evaluate(({ BrowserWindow }, a) => new Function('w', 'a', `return (${a.fn})(w, a.arg)`)(BrowserWindow.getAllWindows()[0], a), { fn: fn.toString(), arg })
const shot = async (name) => {
  await sleep(500)
  const png = await win((w) => w.webContents.capturePage().then((i) => i.toPNG().toString('base64')))
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, 'base64'))
}
const view = () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
const box = async (loc) => (await loc.first().boundingBox()) ?? assert.fail('missing box')
const inside = async (loc, label) => {
  const b = await box(loc)
  const v = await view()
  assert.ok(b.x >= -1 && b.y >= -1 && b.x + b.width <= v.w + 1 && b.y + b.height <= v.h + 1, `${label} fits the window (${JSON.stringify(b)} in ${v.w}x${v.h})`)
}
// A dialog with a lot in it: fits, its body scrolls, and its footer button and title stay in view.
const dialogOk = async (label, { footer, scrolls = true }) => {
  const dlg = page.getByRole('dialog')
  await inside(dlg, `${label} dialog`)
  const body = dlg.locator('[data-slot=dialog-body]')
  if (scrolls) assert.ok(await body.evaluate((el) => el.scrollHeight > el.clientHeight + 4), `${label}: the body scrolls inside the dialog`)
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await inside(dlg.getByRole('button', { name: footer, exact: true }), `${label} footer button`)
  await body.evaluate((el) => (el.scrollTop = 0))
  await sleep(100)
  await inside(dlg.getByRole('heading').first(), `${label} title`)
}

try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('crews:create', { name: 'alpha', folder: project })
  await inv('crews:create', { name: 'beta', folder: project })
  for (let i = 0; i < 25; i++) await inv('groups:create', `Group number ${i + 1}`)
  await win((w) => w.isMaximized() && w.unmaximize())
  await win((w) => w.setContentSize(1000, 640))
  await inv('settings:set', { uiScale: 1 })
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await sleep(1500)
  await page.getByRole('complementary', { name: 'Projects' }).getByText('alpha', { exact: true }).waitFor()
  await sleep(800)

  // Resize handles: drag, keyboard, double click reset (done first at a roomy size).
  await win((w) => w.setContentSize(1500, 900))
  await sleep(800)
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  const side = page.getByRole('complementary', { name: 'Projects' })
  const sw0 = (await box(side)).width
  const sh = await box(page.getByRole('separator', { name: 'Resize project list' }))
  await page.mouse.move(sh.x + sh.width / 2, sh.y + 300)
  await page.mouse.down()
  await page.mouse.move(sh.x + sh.width / 2 + 90, sh.y + 300, { steps: 6 })
  await page.mouse.up()
  const sw1 = (await box(side)).width
  assert.ok(sw1 > sw0 + 60, `dragging the project list handle widens it (${sw0} to ${sw1})`)
  await page.getByRole('separator', { name: 'Resize project list' }).focus()
  await page.keyboard.press('ArrowRight')
  const sw2 = (await box(side)).width
  assert.ok(sw2 > sw1, `an arrow key resizes the sidebar (${sw1} to ${sw2})`)
  await shot('panel-resize')
  await sleep(600)
  const saved = (await inv('settings:get')).layout
  assert.ok(saved.sidebarWidth > 0, `the width is saved ${JSON.stringify(saved)}`)

  // Restart: the widths come back.
  await app.close()
  await launch()
  await page.getByRole('complementary', { name: 'Projects' }).getByText('alpha', { exact: true }).waitFor()
  await win((w) => w.isMaximized() && w.unmaximize())
  await win((w) => w.setContentSize(1500, 900))
  await sleep(1000)
  const sw3 = (await box(page.getByRole('complementary', { name: 'Projects' }))).width
  assert.ok(Math.abs(sw3 - sw2) <= 2, `the sidebar width persists across a restart (${sw2} vs ${sw3})`)
  // Limits: a huge drag stops at the maximum; Home resets.
  await page.getByRole('separator', { name: 'Resize project list' }).focus()
  for (let i = 0; i < 60; i++) await page.keyboard.press('Shift+ArrowRight')
  const swMax = (await box(page.getByRole('complementary', { name: 'Projects' }))).width
  assert.ok(swMax <= 1500 / 2 + 1, `the sidebar stops at half the window (${swMax})`)
  await page.keyboard.press('Home')
  await sleep(500)
  assert.ok((await box(page.getByRole('complementary', { name: 'Projects' }))).width < 300, 'Home resets the sidebar')

  // Small window from here on.
  await win((w) => w.setContentSize(1000, 640))
  await sleep(800)
  const scales = [1, 2]
  for (const scale of scales) {
    await inv('settings:set', { uiScale: scale })
    await sleep(700)
    const tag = `${Math.round(scale * 100)}%`

    // Project right-click and '...' menus with 25 groups.
    await page.getByRole('complementary', { name: 'Projects' }).getByText('alpha', { exact: true }).first().click({ button: 'right' })
    const ctx = page.getByRole('menu', { name: 'Actions for alpha' })
    await ctx.waitFor()
    await inside(ctx, `${tag} context menu`)
    assert.ok(await ctx.evaluate((el) => el.scrollHeight > el.clientHeight), `${tag}: the long project menu scrolls`)
    if (scale === 1) await shot('popup-project-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'More actions for alpha' }).click()
    const dd = page.getByRole('menu', { name: 'Actions for alpha' })
    await dd.waitFor()
    await inside(dd, `${tag} dropdown menu`)
    await page.keyboard.press('Escape')

    // Model list: the Learning AI on OpenCode, filter the 300 models.
    await page.keyboard.press('Control+,')
    await page.getByRole('heading', { name: 'Settings' }).waitFor()
    await openSettingsPage('Learning')
    await page.getByRole('combobox', { name: 'Learning CLI' }).click()
    await page.getByRole('option', { name: 'OpenCode', exact: true }).click()
    await sleep(1500)
    await page.getByRole('button', { name: 'Learning model' }).click()
    const filter = page.getByRole('combobox', { name: 'Filter' })
    await filter.waitFor()
    const pop = page.getByRole('listbox', { name: 'Options' })
    await inside(page.locator('[data-radix-popper-content-wrapper]').last(), `${tag} model list`)
    assert.ok((await pop.getByRole('option').count()) >= 300, `${tag}: all 300 models are listed`)
    await filter.fill('model-299')
    assert.equal(await pop.getByRole('option').count(), 1, `${tag}: the filter narrows the models to one`)
    if (scale === 1) await shot('popup-model-search')
    await filter.press('Enter')
    await page.getByRole('button', { name: 'Learning model' }).filter({ hasText: 'Model 299 Instruct' }).waitFor()
    await inv('settings:set', { learn: { cli: 'claude', model: '', effort: '' } })

    // Settings: the team dialog.
    await openSettingsPage('Presets')
    await page.getByRole('button', { name: /New team/ }).first().click()
    const td = page.getByRole('dialog')
    await td.getByLabel('Name', { exact: true }).fill('big')
    await dialogOk(`${tag} team`, { footer: 'Create team', scrolls: false })
    await page.keyboard.press('Escape')
    await td.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('complementary', { name: 'Projects' }).getByText('alpha', { exact: true }).waitFor()
  }

  // Every dialog type: inside the window, nothing sideways, header and footer in view, body scrolled to its end shows its last row.
  const closeAll = async () => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {})
    const close = page.getByRole('button', { name: 'Close settings' })
    if (await close.isVisible().catch(() => false)) await close.click()
    await sleep(200)
  }
  const settingsPage = async (nav) => {
    await page.keyboard.press('Control+,')
    await page.getByRole('heading', { name: 'Settings' }).waitFor()
    await openSettingsPage(nav)
  }
  const sidebarRight = async (name) => {
    await page.getByRole('complementary', { name: 'Projects' }).getByText(name, { exact: true }).first().click({ button: 'right' })
  }
  const dialogTypes = [
    { name: 'mcp add', large: true, open: async () => {
      await settingsPage('MCP servers')
      await page.getByRole('button', { name: 'Add server' }).click()
    } },
    { name: 'team', large: true, open: async () => {
      await settingsPage('Presets')
      await page.getByRole('button', { name: /New team/ }).first().click()
    } },
    { name: 'preset editor', large: true, open: async () => {
      await settingsPage('Presets')
      await page.getByRole('button', { name: /New preset/ }).first().click()
    } },
    { name: 'new project', large: false, open: async () => {
      await page.getByRole('button', { name: /^(Add|New) project$/ }).first().evaluate((el) => el.click())
    } },
    { name: 'delete project', large: false, open: async () => {
      await sidebarRight('beta')
      await page.getByRole('menuitem', { name: /^Delete project/ }).click()
    } },
  ]
  const dialogMatrix = async (label) => {
    const v = await view()
    for (const t of dialogTypes) {
      await t.open()
      const dlg = page.getByRole('dialog')
      await dlg.waitFor()
      await sleep(500)
      const tag = `${label} ${t.name}`
      await inside(dlg, `${tag} dialog`)
      const m = await dlg.evaluate((el) => {
        const body = el.querySelector('[data-slot=dialog-body]')
        const rect = (e) => (e ? e.getBoundingClientRect().toJSON() : null)
        if (body) body.scrollTop = body.scrollHeight
        const last = body?.lastElementChild
        return {
          dlgSideways: el.scrollWidth > el.clientWidth + 1,
          dlgScrolls: el.scrollHeight > el.clientHeight + 1,
          bodySideways: body ? body.scrollWidth > body.clientWidth + 1 : false,
          dlg: rect(el), head: rect(el.querySelector('[data-slot=dialog-header]')), foot: rect(el.querySelector('[data-slot=dialog-footer]')),
          body: rect(body), last: rect(last),
        }
      })
      assert.ok(!m.dlgSideways && !m.bodySideways, `${tag}: no horizontal overflow`)
      assert.ok(!m.dlgScrolls, `${tag}: the dialog itself does not scroll, only its body`)
      assert.ok(m.head && m.foot, `${tag}: header and footer exist`)
      for (const [k, r] of [['header', m.head], ['footer', m.foot]]) {
        assert.ok(r.top >= m.dlg.top - 1 && r.bottom <= m.dlg.bottom + 1 && r.bottom <= v.h + 1, `${tag}: ${k} is in view`)
      }
      if (m.body && m.last) assert.ok(m.last.bottom <= m.body.bottom + 1, `${tag}: the last row is not clipped (${m.last.bottom} vs ${m.body.bottom})`)
      if (t.large && v.w >= 1900) assert.ok(m.dlg.width >= v.w * 0.6, `${tag}: a large dialog uses at least 60% of the window width (${Math.round(m.dlg.width)} of ${v.w})`)
      if (label.startsWith('1920')) await shot(`dialog-matrix-${t.name.replace(/ /g, '-')}`)
      await closeAll()
    }
  }
  for (const [w, h, scale] of [[1000, 640, 1], [1920, 1080, 1], [1000, 640, 2]]) {
    await win((x) => x.isMaximized() && x.unmaximize())
    await win((x, a) => x.setContentSize(a[0], a[1]), [w, h])
    await inv('settings:set', { uiScale: scale })
    await sleep(1000)
    await dialogMatrix(`${w}x${h} at ${Math.round(scale * 100)}%`)
  }
  await win((x, a) => x.setContentSize(a[0], a[1]), [1500, 900])
  await inv('settings:set', { uiScale: 1.25 })
  await win((w) => w.setContentSize(1500, 900))
  await sleep(800)
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await openSettingsPage('General')
  await page.getByRole('combobox', { name: 'UI scale' }).waitFor()
  await page.getByRole('button', { name: /^UI scale 125%/ }).click()
  await page.getByRole('menuitem', { name: 'Reset' }).waitFor()
  await shot('ui-scale-setting')
  await page.keyboard.press('Escape')
  console.log('popups e2e passed')
} finally {
  await app?.close().catch(() => {})
}
