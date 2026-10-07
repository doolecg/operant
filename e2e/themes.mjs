// Themes: switches themes through settings and the Appearance page, and asserts the CSS variables, the live preview,
// accent override, custom theme save/edit/delete/import, the terminal colours, the window background and persistence
// after a restart. Runs in the background with throwaway data and saves screenshots.
// Usage: node e2e/themes.mjs [outDir]   (docs/specs/screenshots keeps the spec's themes-*.png and theme-*.png)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { BUILTIN_THEMES, tokensFor } from '../shared/themes.ts'

const outDir = resolve(process.argv[2] ?? 'out/e2e')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-e2e-'))
const project = mkdtempSync(join(tmpdir(), 'operant-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const x = 1\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

const def = (id) => BUILTIN_THEMES.find((t) => t.id === id)
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const launch = () => electron.launch({ args: ['.'], env })

let app = await launch()
try {
  let page = await app.firstWindow()
  const poll = async (label, fn, timeout = 15_000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(200)) if (await fn()) return
    throw new Error(`timed out waiting for ${label}`)
  }
  const css = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
  const attr = (n) => page.evaluate((a) => document.documentElement.dataset[a], n)
  const termBg = () => page.evaluate(() => { const v = document.querySelector('.xterm-scrollable-element'); return v ? getComputedStyle(v).backgroundColor : null })
  const set = (appearance) => page.evaluate((a) => window.operant.invoke('settings:set', { appearance: a }), appearance)
  const winBg = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByText('Welcome to Operant 3').waitFor()
  await page.evaluate(async (folder) => {
    const o = window.operant
    await o.invoke('settings:set', { uiScale: 1 })
    await o.invoke('crews:create', { name: 'shop', folder })
  }, project)
  const master = page.getByRole('region', { name: 'Master Terminal' })
  await master.getByRole('button', { name: 'Start' }).click()
  await page.locator('.xterm').first().waitFor()

  // Default: the Dark theme, terminal following it.
  assert.equal(await attr('theme'), 'dark')
  assert.equal(await css('--background'), def('dark').bg)
  assert.equal(await termBg(), rgb(def('dark').bg))

  // Each theme sets every variable of its token table, the scheme and the terminal colours.
  for (const id of ['nord', 'paper', 'dracula', 'daylight', 'void']) {
    await set({ theme: id })
    await poll(`${id} applied`, async () => (await attr('theme')) === id)
    const t = tokensFor(def(id))
    for (const [k, v] of Object.entries(t)) assert.equal(await css(k), v, `${id} ${k}`)
    assert.equal(await attr('scheme'), def(id).scheme)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), def(id).scheme === 'dark')
    await poll(`${id} terminal`, async () => (await termBg()) === rgb(def(id).bg))
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), rgb(def(id).bg), `${id} page background`)
  }

  // System follows the OS preference live.
  await set({ theme: 'system' })
  await page.emulateMedia({ colorScheme: 'light' })
  await poll('system light', async () => (await attr('theme')) === 'light')
  assert.equal(await css('--background'), def('light').bg)
  await page.emulateMedia({ colorScheme: 'dark' })
  await poll('system dark', async () => (await attr('theme')) === 'dark')
  await page.emulateMedia({ colorScheme: null })

  // The terminal can stay dark when it does not follow the theme.
  await set({ theme: 'paper', terminalFollowsTheme: false })
  await poll('terminal stays dark', async () => (await termBg()) === rgb('#09090b'))
  await set({ terminalFollowsTheme: true })
  await poll('terminal follows again', async () => (await termBg()) === rgb(def('paper').bg))

  // Settings > Appearance: the picker previews on hover and keeps the choice on click.
  await set({ theme: 'nord' })
  await poll('settings page', async () => {
    await page.keyboard.press('Control+,')
    return (await page.getByRole('heading', { name: 'Settings' }).count()) > 0
  })
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByTestId('theme-card-dracula').waitFor()
  await page.mouse.move(5, 5)
  await page.getByTestId('theme-card-dracula').hover()
  await poll('hover previews', async () => (await attr('theme')) === 'dracula')
  assert.equal((await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.theme, 'nord', 'hover does not save')
  await page.mouse.move(5, 5)
  await poll('preview ends', async () => (await attr('theme')) === 'nord')
  await page.getByTestId('theme-card-dracula').click()
  await poll('click keeps', async () => (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.theme === 'dracula')
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(outDir, 'themes-picker.png') })

  // Accent: a preset, then a typed hex, then back to the theme's own.
  await page.getByTestId('accent-5b9cff').click()
  await poll('accent preset', async () => (await css('--primary')) === '#5b9cff')
  assert.equal(await css('--ring'), '#5b9cff')
  await page.getByTestId('accent-hex').fill('#ff8800')
  await poll('accent hex', async () => (await css('--primary')) === '#ff8800')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await poll('accent reset', async () => (await css('--primary')) === def('dracula').accent)

  // Custom themes: edit colours live, save under a name, change, export/import and delete.
  const custom = page.getByTestId('custom-hex-bg')
  await custom.scrollIntoViewIfNeeded()
  await custom.fill('#102030')
  await poll('draft previews', async () => (await css('--background')) === '#102030')
  assert.equal((await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.customThemes.length, 0, 'draft is not saved')
  await page.getByRole('button', { name: 'Reset colours' }).click()
  await poll('reset reverts', async () => (await css('--background')) === def('dracula').bg)
  await custom.fill('#102030')
  await page.getByTestId('custom-name').fill('Night shift')
  await page.getByTestId('custom-save').click()
  await poll('custom saved', async () => (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.customThemes.length === 1)
  let ap = (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance
  assert.deepEqual(ap.customThemes[0], { id: 'custom-1', name: 'Night shift', base: 'dracula', colors: { bg: '#102030' } })
  assert.equal(ap.theme, 'custom-1')
  assert.equal(await css('--background'), '#102030')
  assert.equal(await css('--foreground'), def('dracula').text)
  await page.getByTestId('theme-card-custom-1').waitFor()

  await page.getByTestId('custom-hex-accent').fill('#00cc88')
  await page.getByTestId('custom-save').click()
  await poll('custom edited', async () => (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.customThemes[0].colors.accent === '#00cc88')
  assert.equal(await css('--primary'), '#00cc88')

  const exported = JSON.stringify({ operantTheme: 1, name: 'Imported one', base: 'nord', colors: { bg: '#202020', accent: '#ff00ff' } })
  await page.getByTestId('custom-import-text').fill(exported)
  await page.getByTestId('custom-import').click()
  await poll('imported', async () => (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.customThemes.length === 2)
  await page.getByTestId('custom-import-text').fill('not json')
  await page.getByTestId('custom-import').click()
  await page.getByRole('alert').filter({ hasText: 'invalid JSON' }).waitFor()

  await page.getByRole('button', { name: 'Delete Night shift' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete theme' }).click()
  await poll('deleted', async () => (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.customThemes.length === 1)
  ap = (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance
  assert.equal(ap.theme, 'custom-2', 'deleting another theme keeps the one in use')
  assert.equal(ap.customThemes[0].name, 'Imported one')
  await page.getByRole('button', { name: 'Delete Imported one' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete theme' }).click()
  await poll('all deleted', async () => (await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.customThemes.length === 0)
  assert.equal((await page.evaluate(() => window.operant.invoke('settings:get'))).appearance.theme, 'dark', 'deleting the theme in use falls back to Dark')

  // Restart: the last theme comes back, and the window is painted in its colour before the page loads.
  await set({ theme: 'gruvbox', accent: '' })
  await page.keyboard.press('Escape')
  await poll('terminal after settings closes', async () => (await termBg()) === rgb(def('gruvbox').bg))
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  assert.equal((await winBg()).toLowerCase(), def('gruvbox').bg, 'window background matches the saved theme')
  await poll('theme after restart', async () => (await attr('theme')) === 'gruvbox')
  assert.equal(await css('--background'), def('gruvbox').bg)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('region', { name: 'Master Terminal' }).getByRole('button', { name: 'Start' }).click()
  await page.locator('.xterm').first().waitFor()

  // Screenshots of the app in three themes.
  for (const [file, id] of [['theme-a.png', 'dracula'], ['theme-b.png', 'paper'], ['theme-c.png', 'gruvbox']]) {
    await set({ theme: id })
    await poll(`${id} shown`, async () => (await attr('theme')) === id)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(outDir, file) })
  }
  console.log('themes e2e ok')
} finally {
  await app.close().catch(() => undefined)
}
