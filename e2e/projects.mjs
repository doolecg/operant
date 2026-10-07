// Project management e2e: groups (create, rename, duplicate refusal, move by menu and by drag, collapse that survives a
// reload, remove), the right-click menu, Open in IDE (a fake IDE, and the failure toast), Show changes (a temp git repo),
// the terminal drawer (shell in the project folder, tabs, close), shortcuts, and the delete dialog. Runs in the
// background with throwaway data and never opens a real file manager or IDE.
// Usage: node e2e/projects.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-prj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-prj-claude-'))
const root = mkdtempSync(join(tmpdir(), 'operant-prj-dirs-'))
const folders = {}
for (const n of ['shop', 'blog', 'api']) {
  folders[n] = join(root, n)
  mkdirSync(folders[n])
  writeFileSync(join(folders[n], 'readme.txt'), n)
}
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: folders.shop, stdio: 'ignore', windowsHide: true })
git('init', '-q', '-b', 'main')
git('add', '.')
git('commit', '-q', '-m', 'first')
writeFileSync(join(folders.shop, 'readme.txt'), 'changed')
writeFileSync(join(folders.shop, 'extra.txt'), 'new')
const ideOut = join(root, 'ide-calls.txt')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, FAKE_IDE_OUT: ideOut }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const packaged = process.env.OPERANT_E2E_EXE

let app = null
try {
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])

  const crews = {}
  for (const n of ['shop', 'blog', 'api']) crews[n] = await inv('crews:create', { name: n, folder: folders[n] })
  const row = (n) => page.locator(`[data-crew-row="${crews[n].id}"]`)
  await row('api').waitFor()

  // Groups: a new group is named and goes straight into rename; Esc keeps the default, a duplicate is refused.
  await page.getByRole('button', { name: 'New group', exact: true }).click()
  await page.getByLabel(/Rename group New group/).press('Escape')
  await page.getByRole('region', { name: 'Group New group' }).waitFor()
  await page.getByRole('button', { name: 'New group', exact: true }).click()
  await page.getByLabel(/Rename group New group 2/).fill('new group')
  await page.getByLabel(/Rename group New group 2/).press('Enter')
  await page.getByRole('alert').filter({ hasText: /already exists/ }).waitFor()
  await page.getByRole('region', { name: 'Group New group 2' }).waitFor()
  assert.equal((await inv('groups:list')).length, 2)
  // Double-click renames; Enter commits.
  await page.getByRole('region', { name: 'Group New group 2' }).getByText('New group 2', { exact: true }).dblclick()
  await page.getByLabel(/Rename group New group 2/).fill('Play')
  await page.getByLabel(/Rename group New group 2/).press('Enter')
  await page.getByRole('region', { name: 'Group Play' }).waitFor()
  await page.getByRole('region', { name: 'Group New group' }).getByText('New group', { exact: true }).dblclick()
  await page.getByLabel(/Rename group New group/).fill('Work')
  await page.getByLabel(/Rename group New group/).press('Enter')
  const work = page.getByRole('region', { name: 'Group Work' })
  const play = page.getByRole('region', { name: 'Group Play' })
  await work.waitFor()

  // The right-click menu: every item, in order.
  await row('shop').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions for shop' })
  await menu.waitFor()
  const labels = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim())
  assert.deepEqual(labels, [
    'New agent here',
    'New shell here',
    'Open in VS Code',
    process.platform === 'win32' ? 'Open in Explorer' : process.platform === 'darwin' ? 'Reveal in Finder' : 'Open folder',
    'Index with CodeGraph',
    'Show changes',
    'Copy path',
    'Move to Work',
    'Move to Play',
    'Move to new group',
    'Project defaults…',
    'Delete project…',
  ])

  // Move by menu, move by drag, remove from group.
  await menu.getByRole('menuitem', { name: 'Move to Work' }).click()
  await work.locator(`[data-crew-row="${crews.shop.id}"]`).waitFor()
  await row('blog').dragTo(work.getByText('Work', { exact: true }))
  await work.locator(`[data-crew-row="${crews.blog.id}"]`).waitFor()
  await row('api').dragTo(play.getByText('Play', { exact: true }))
  await play.locator(`[data-crew-row="${crews.api.id}"]`).waitFor()
  const groups = await inv('groups:list')
  assert.deepEqual(
    (await inv('crews:list')).map((c) => [c.name, c.groupId]),
    [
      ['shop', groups[0].id],
      ['blog', groups[0].id],
      ['api', groups[1].id],
    ],
  )
  await row('api').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove from group' }).click()
  await play.locator(`[data-crew-row="${crews.api.id}"]`).waitFor({ state: 'detached' })
  assert.equal((await inv('crews:list')).find((c) => c.name === 'api').groupId, null)
  // Dropping a project on a row in another group puts it in that group, before that row.
  await row('api').dragTo(row('shop'))
  assert.deepEqual((await inv('crews:list')).map((c) => c.name), ['api', 'shop', 'blog'])
  assert.equal((await inv('crews:list'))[0].groupId, groups[0].id)

  // Collapse is saved and survives a reload.
  await work.getByRole('button', { name: 'Collapse Work' }).click()
  await work.locator(`[data-crew-row="${crews.shop.id}"]`).waitFor({ state: 'detached' })
  assert.equal((await inv('groups:list'))[0].collapsed, true)
  await page.reload()
  await page.getByRole('button', { name: 'Expand Work' }).waitFor()
  await page.getByRole('button', { name: 'Expand Work' }).click()
  await row('shop').waitFor()

  // Open in IDE through a fake IDE; a broken command shows an error toast.
  await inv('settings:set', { ide: { default: 'custom', custom: `node "${resolve('e2e/fixtures/fake-ide.mjs')}"` } })
  await row('shop').hover()
  await page.getByRole('complementary', { name: 'Projects' }).getByRole('button', { name: /^Open shop in/ }).click()
  for (const end = Date.now() + 15_000; !existsSync(ideOut) && Date.now() < end; await page.waitForTimeout(200));
  assert.ok(existsSync(ideOut), 'the fake IDE was started')
  assert.equal(readFileSync(ideOut, 'utf8').trim(), folders.shop)
  await inv('settings:set', { ide: { custom: 'operant-no-such-ide-command-xyz' } })
  await row('shop').hover()
  await page.getByRole('complementary', { name: 'Projects' }).getByRole('button', { name: /^Open shop in/ }).click()
  await page.getByRole('alert').filter({ hasText: /could not start/ }).waitFor({ timeout: 15_000 })

  // Show changes reads git status of the project folder.
  const dismissToasts = async () => {
    for (const d of await page.getByRole('button', { name: 'Dismiss' }).all()) await d.click()
  }
  await dismissToasts()
  await inv('settings:set', { ide: { default: 'code' } })
  await row('shop').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in VS Code' }).waitFor()
  await page.screenshot({ path: join(outDir, 'project-menu.png') })
  await page.getByRole('menuitem', { name: 'Show changes' }).click()
  const changes = page.getByTestId('git-files')
  await changes.getByText('readme.txt').waitFor()
  await changes.getByText('extra.txt').waitFor()
  await page.getByTestId('git-page').getByRole('tab', { name: /^Changes\s*2$/ }).waitFor()

  // Terminal drawer: a shell in the project folder, a second tab, closing tabs.
  await row('shop').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New shell here' }).click()
  const drawer = page.getByTestId('terminal-drawer')
  await drawer.waitFor()
  const tiles = await inv('scratch:list', crews.shop.id)
  assert.equal(tiles.length, 1)
  assert.equal(tiles[0].agent, 'shell')
  assert.equal(tiles[0].cwd, folders.shop)
  const marker = 'operant-shell-ok'
  await inv('scratch:write', tiles[0].id, `echo ${marker}\r`)
  let buffer = ''
  for (const end = Date.now() + 20_000; !buffer.includes(marker) && Date.now() < end; await page.waitForTimeout(250)) buffer = await inv('scratch:buffer', tiles[0].id)
  assert.ok(buffer.includes(marker), 'the shell ran the command')
  await drawer.getByRole('tab', { name: /Shell: shop/ }).waitFor()
  await dismissToasts()
  await page.screenshot({ path: join(outDir, 'terminal-drawer.png') })
  // The drawer scales with the window.
  const h1 = (await drawer.boundingBox()).height
  await page.setViewportSize({ width: 1440, height: 700 })
  await page.waitForTimeout(300)
  const h2 = (await drawer.boundingBox()).height
  assert.ok(h2 < h1 - 20, `drawer shrinks with the window (${h1} -> ${h2})`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await drawer.getByRole('button', { name: 'New shell in this project' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="terminal-drawer"] [role="tab"]').length === 2)
  await drawer.getByRole('button', { name: /^Close Shell: shop/ }).first().click()
  assert.equal((await inv('scratch:list', crews.shop.id)).length, 1, 'closing a tab removes its tile')
  await drawer.getByRole('button', { name: /^Close Shell: shop/ }).click()
  await drawer.waitFor({ state: 'detached' })
  assert.equal((await inv('scratch:list', crews.shop.id)).length, 0)

  // Shortcuts: Alt+Shift+T opens a shell for the selected project, Alt+B hides and shows the list.
  await row('shop').click()
  await page.keyboard.press('Alt+Shift+T')
  await drawer.waitFor()
  // A terminal in focus keeps its own keys, so the list shortcut is pressed from the page.
  await row('shop').click()
  await page.keyboard.press('Alt+b')
  await page.getByRole('complementary', { name: 'Projects' }).waitFor({ state: 'detached' })
  await page.keyboard.press('Alt+b')
  await page.getByRole('complementary', { name: 'Projects' }).waitFor()
  await drawer.getByRole('button', { name: /^Close Shell: shop/ }).click()
  await drawer.waitFor({ state: 'detached' })

  // Project defaults opens Settings at the Projects section.
  await row('shop').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Project defaults…' }).click()
  await page.getByText('Open in IDE', { exact: true }).first().waitFor()
  await page.getByTestId(`project-row-${crews.shop.id}`).waitFor()
  await page.getByRole('button', { name: 'Edit shop' }).click()
  await page.getByLabel('Tracker file').fill('docs/specs/tracker.html')
  await page.screenshot({ path: join(outDir, 'pm-tracker-setting.png') })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByLabel('Tracker file').waitFor({ state: 'detached' })
  assert.equal((await inv('crews:list')).find((c) => c.id === crews.shop.id).trackerFile, 'docs/specs/tracker.html')
  await page.getByRole('button', { name: 'Close settings' }).click()

  // The tracker: "Update tracker now" puts one job on the Board for the project manager, a second press adds to it.
  await row('shop').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Update tracker now' }).click()
  await row('shop').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Update tracker now' }).click()
  await page.getByRole('menu').waitFor({ state: 'detached' })
  const tracker = (await inv('jobs:list', crews.shop.id)).filter((j) => j.title === 'Update tracker')
  assert.equal(tracker.length, 1)
  assert.match(tracker[0].body, /Tracker: docs\/specs\/tracker.html/)
  assert.match(tracker[0].body, /tick only what was verified/)
  await row('shop').click()
  await page.getByRole('tab', { name: /^Board/ }).click()
  await page.getByText('Update tracker', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(outDir, 'pm-tracker-job.png') })

  // Delete: the dialog says what goes and what stays; the folder is never touched; the group stays.
  const all = await inv('groups:list')
  await inv('groups:move', crews.blog.id, all[1].id)
  await inv('groups:collapse', all[1].id, true)
  await page.reload()
  await page.getByRole('button', { name: 'Expand Play' }).waitFor()
  for (const d of await page.getByRole('button', { name: 'Dismiss' }).all()) await d.click()
  await page.screenshot({ path: join(outDir, 'project-groups.png') })
  await inv('groups:collapse', all[1].id, false)
  await page.reload()
  await row('blog').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete project…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText(/Deleting the project removes 0 runs/).waitFor()
  await dialog.getByText(/Its lessons \(0\) are deleted too/).waitFor()
  await dialog.getByText(/spend history/).waitFor()
  await dialog.getByText(/folder and every file in it are not touched/).waitFor()
  await page.screenshot({ path: join(outDir, 'project-delete.png') })
  await dialog.getByRole('button', { name: 'Delete project' }).click()
  await row('blog').waitFor({ state: 'detached' })
  assert.ok(existsSync(join(folders.blog, 'readme.txt')), 'the folder is untouched')
  assert.equal((await inv('groups:list')).length, 2, 'the group stays')

  // Removing a group returns its projects to the list.
  await work.getByText('Work', { exact: true }).hover()
  await work.getByRole('button', { name: 'Actions for group Work' }).click()
  await page.getByRole('menuitem', { name: 'Remove group' }).click()
  await page.getByRole('region', { name: 'Group Work' }).waitFor({ state: 'detached' })
  assert.deepEqual((await inv('crews:list')).map((c) => c.groupId), [null, null])
  console.log('projects e2e ok')
} finally {
  await app?.close().catch(() => undefined)
}
