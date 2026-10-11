// Project panel e2e: the 2.8.2 layout (header with small buttons, 24 px rows, git info,
// groups), keyboard navigation (arrows, Enter, Left/Right, Esc, Alt+Arrow reorder, F2 rename, collapse that is saved), the
// drag tab and the edge resize. Runs in the background with throwaway data.
// Usage: node e2e/sidebar.mjs [outDir] [shotPrefix]   (shotPrefix: only take the screenshots, named <prefix>-*.png)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { claudeHome, e2eEnv } from './fixtures/real-claude.mjs'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
const prefix = process.argv[3] ?? ''
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-side-'))
const claudeRoot = mkdtempSync(join(tmpdir(), 'operant-side-claude-'))
const claudeDir = claudeHome(claudeRoot)
process.on('exit', () => rmSync(claudeRoot, { recursive: true, force: true }))
const root = mkdtempSync(join(tmpdir(), 'operant-side-dirs-'))
const names = ['atlas', 'beacon', 'cobalt', 'delta', 'ember', 'fjord']
const folders = {}
for (const n of names) {
  folders[n] = join(root, n)
  mkdirSync(folders[n])
  writeFileSync(join(folders[n], 'readme.txt'), n)
}
for (const n of ['atlas', 'cobalt']) {
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: folders[n], stdio: 'ignore', windowsHide: true })
  git('init', '-q', '-b', n === 'atlas' ? 'main' : 'feature/long-branch-name-here')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(folders[n], 'readme.txt'), 'changed')
  if (n === 'atlas') writeFileSync(join(folders[n], 'extra.txt'), 'new')
}

const env = e2eEnv({ dataDir, claudeDir })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()
  const inv = (c, ...a) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [c, a])
  const win = (fn, arg) => app.evaluate(({ BrowserWindow }, a) => new Function('w', 'a', `return (${a.fn})(w, a.arg)`)(BrowserWindow.getAllWindows()[0], a), { fn: fn.toString(), arg })

  const crews = {}
  for (const n of names) crews[n] = await inv('crews:create', { name: n, folder: folders[n] })
  const work = await inv('groups:create', 'Work')
  const play = await inv('groups:create', 'Play')
  await inv('groups:move', crews.cobalt.id, work.id)
  await inv('groups:move', crews.delta.id, work.id)
  await inv('groups:move', crews.ember.id, play.id)
  await page.reload()
  await page.waitForFunction(() => !!window.operant)

  const row = (n) => page.locator(`[data-crew-row="${crews[n].id}"]`)
  const aside = page.getByRole('complementary', { name: 'Projects' })
  await row('atlas').waitFor()
  const shot = async (name, w, h, scale) => {
    await inv('settings:set', { uiScale: scale })
    await win((x, a) => (x.isMaximized() && x.unmaximize(), x.setContentSize(a[0], a[1])), [w, h])
    await sleep(900)
    const png = await win((x) => x.webContents.capturePage().then((i) => i.toPNG().toString('base64')))
    writeFileSync(join(outDir, `${prefix || 'sidebar'}-${name}.png`), Buffer.from(png, 'base64'))
  }
  if (prefix) {
    await shot('1000', 1000, 700, 1)
    await shot('1920', 1920, 1080, 1)
    await shot('2x', 1920, 1080, 2)
    console.log('sidebar shots in', outDir)
    process.exit(0)
  }
  await inv('settings:set', { uiScale: 1 })
  await win((x) => (x.isMaximized() && x.unmaximize(), x.setContentSize(1440, 900)))
  await sleep(600)

  // Layout: header row 32 px with the title and five small buttons; project rows 24 px; the panel defaults to 250 px.
  const box = async (loc) => (await loc.first().boundingBox()) ?? assert.fail('missing box')
  assert.ok(Math.abs((await box(aside)).width - 250) <= 2, 'the panel is 250 px wide by default')
  await aside.getByText('Projects', { exact: true }).first().waitFor()
  assert.equal(await aside.getByText('Crews').count(), 0, 'no crews heading')
  assert.ok(Math.abs((await box(page.getByTestId('project-panel-header'))).height - 32) <= 1, 'the header row is 32 px')
  for (const b of ['Add project', 'New group', 'Index all projects with CodeGraph', 'Refresh projects', 'Hide project list']) await aside.getByRole('button', { name: b, exact: true }).waitFor()
  assert.ok(Math.abs((await box(row('atlas'))).height - 24) <= 1, 'a project row is 24 px')
  await row('atlas').getByText('main').waitFor()
  await row('atlas').getByLabel('2 changed files').waitFor()

  // Keyboard: the list is one tab stop; arrows move the current row, Enter opens it, Right/Left expand and collapse, Esc leaves.
  const nav = aside.getByRole('tree')
  await nav.focus()
  const current = () => page.evaluate(() => document.querySelector('[data-nav-current="true"]')?.getAttribute('data-nav-label') ?? null)
  await page.keyboard.press('ArrowDown')
  const first = await current()
  assert.ok(first, 'a current row appears')
  await page.keyboard.press('ArrowDown')
  assert.notEqual(await current(), first, 'ArrowDown moves the current row')
  await page.keyboard.press('ArrowUp')
  assert.equal(await current(), first, 'ArrowUp moves back')
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  const last = await current()
  assert.ok(last, 'End goes to the last row')
  await page.keyboard.press('Home')
  // Collapse a group with Left on its header, expand with Right; the state is saved.
  while ((await current()) !== 'group:Work') await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowLeft')
  await until(async () => (await inv('groups:list')).find((g) => g.name === 'Work').collapsed === true)
  // A key reads what the list shows, which trails the saved state by a refetch: wait for the rows to follow before the next key.
  await until(async () => (await row('cobalt').count()) === 0)
  await page.keyboard.press('ArrowRight')
  await until(async () => (await inv('groups:list')).find((g) => g.name === 'Work').collapsed === false)
  await until(async () => (await row('cobalt').count()) === 1)
  // Right on an open group goes to its first project, Left on a project goes back to its group.
  await page.keyboard.press('ArrowRight')
  assert.equal(await current(), 'project:cobalt')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await current(), 'group:Work')
  // Enter on a project selects it.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'cobalt' }).waitFor()
  // Alt+Arrow reorders the project in its group (from the row itself, no need to find the grip).
  await page.keyboard.press('Alt+ArrowDown')
  const inWork = async () => (await inv('crews:list')).filter((c) => c.groupId === work.id).map((c) => c.name).join()
  await until(async () => (await inWork()) === 'delta,cobalt')
  // The press reads the order the list is showing, so wait until the rows show it too (a refetch that began before the save can briefly redraw the old order).
  const shown = () => page.evaluate((ids) => [...document.querySelectorAll('[data-crew-row]')].map((el) => el.getAttribute('data-crew-row')).filter((id) => ids.includes(id)).join(), [String(crews.cobalt.id), String(crews.delta.id)])
  await until(async () => (await shown()) === `${crews.delta.id},${crews.cobalt.id}`)
  await page.keyboard.press('Alt+ArrowUp')
  await until(async () => (await inWork()) === 'cobalt,delta')
  // F2 renames the current group in place.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  while ((await current()) !== 'group:Play') await page.keyboard.press('ArrowDown')
  await page.keyboard.press('F2')
  const edit = aside.getByLabel('Rename group Play')
  await edit.fill('Fun')
  await edit.press('Enter')
  await until(async () => (await inv('groups:list')).some((g) => g.name === 'Fun'))
  await page.keyboard.press('Escape')
  // The group header: double click renames, a click collapses and it survives a reload.
  await aside.getByRole('region', { name: 'Group Fun' }).getByRole('button', { name: 'Collapse Fun' }).click()
  await until(async () => (await inv('groups:list')).find((g) => g.name === 'Fun').collapsed === true)
  await page.reload()
  await aside.getByRole('button', { name: 'Expand Fun' }).waitFor()
  await aside.getByRole('button', { name: 'Expand Fun' }).click()

  // The drag tab: visible on hover, reorders by keyboard.
  await row('delta').hover()
  const tab = row('delta').getByRole('button', { name: 'Reorder delta' })
  assert.ok((await tab.evaluate((el) => getComputedStyle(el).opacity)) !== '0', 'the drag tab shows on hover')
  await page.screenshot({ path: join(outDir, 'sidebar-drag-tab.png'), clip: { x: 0, y: 0, width: 300, height: 420 } })

  // Resize: clamped between 160 and 600 px, saved, double click resets to 250.
  const grip = aside.getByRole('separator', { name: 'Resize project list' })
  const gb = await box(grip)
  await page.mouse.move(gb.x + gb.width / 2, gb.y + 100)
  await page.mouse.down()
  await page.mouse.move(gb.x + 800, gb.y + 100, { steps: 5 })
  await page.mouse.up()
  assert.ok((await box(aside)).width <= 601, 'the panel stops at 600 px')
  await grip.dblclick()
  assert.ok(Math.abs((await box(aside)).width - 250) <= 2, 'double click resets the width')
  console.log('sidebar e2e passed')
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(150)
  }
  assert.fail('timed out')
}
