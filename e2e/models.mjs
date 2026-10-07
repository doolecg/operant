// Model list e2e: with a fake OpenCode that lists several providers, the model selector groups them under friendly
// provider headings, shows friendly names with the raw id muted, a free badge, a not-connected hint, filters across
// provider and model names, focuses the filter on open and has a Refresh button.
// Usage: node e2e/models.mjs   (the screenshot goes to docs/specs/screenshots/opencode-models.png)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = resolve('docs/specs/screenshots')
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-models-'))
const project = mkdtempSync(join(tmpdir(), 'operant-models-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-models-claude-'))
const ocFile = join(dataDir, 'opencode.json')
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
writeFileSync(ocFile, JSON.stringify({ mcp: { servers: {} } }))

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, OPENCODE_CONFIG: ocFile, OPENCODE_FAKE_MODELS: 'multi' }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
  const inv = (c, ...a) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [c, a])
  const win = (fn) => app.evaluate(({ BrowserWindow }, f) => new Function('w', `return (${f})(w)`)(BrowserWindow.getAllWindows()[0]), fn.toString())
  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('crews:create', { name: 'alpha', folder: project })
  await win((w) => w.isMaximized() && w.unmaximize())
  await win((w) => w.setContentSize(1400, 900))
  await sleep(1200)

  // The IPC answer: provider groups, friendly names, connected flags.
  const list = await inv('models:list', 'opencode')
  const byId = Object.fromEntries(list.providers.map((p) => [p.providerId, p]))
  assert.equal(byId.opencode.providerName, 'OpenCode Zen')
  assert.equal(byId['zai-coding-plan'].providerName, 'Z.AI Coding Plan')
  assert.equal(byId.openai.connected, false, 'OpenAI is listed but not connected')
  assert.equal(byId['zai-coding-plan'].connected, true)
  assert.equal(list.models.length, 8)

  await page.getByRole('button', { name: 'Start new task' }).evaluate((el) => el.click())
  const dlg = page.getByRole('dialog')
  await dlg.getByRole('combobox', { name: 'Master CLI' }).click().catch(async () => dlg.locator('#run-cli').click())
  await page.getByRole('option', { name: 'OpenCode' }).click()
  await sleep(1200)
  await dlg.getByRole('button', { name: 'Master model' }).click()
  const filter = page.getByRole('combobox', { name: 'Filter' })
  await filter.waitFor()
  assert.ok(await filter.evaluate((el) => el === document.activeElement), 'the filter is focused on open')
  const pop = page.getByRole('listbox', { name: 'Options' })
  const text = (await pop.innerText()).toLowerCase()
  for (const h of ['OpenCode Zen', 'Z.AI Coding Plan', 'Ollama (local)', 'OpenAI (ChatGPT)']) assert.ok(text.includes(h.toLowerCase()), `heading ${h}`)
  assert.ok(text.indexOf('opencode zen') < text.indexOf('z.ai coding plan') && text.indexOf('z.ai coding plan') < text.indexOf('openai (chatgpt)'), 'connected providers come first')
  const pickle = pop.getByRole('option', { name: /Big Pickle/ })
  assert.ok((await pickle.innerText()).includes('opencode/big-pickle'), 'the raw id is shown muted beside the name')
  assert.ok((await pop.getByRole('option', { name: /Exo Free/ }).innerText()).includes('free'), 'free badge')
  assert.ok(text.includes('opencode auth login'), 'the not-connected hint says how to sign in')
  assert.ok((await pop.getByRole('option', { name: /GLM 4\.7/ }).innerText()).includes('zai-coding-plan/glm-4.7'))
  assert.ok((await pop.getByRole('option', { name: /GPT 5/ }).count()) === 1, 'unconnected models are listed')
  await page.getByRole('button', { name: 'Refresh models' }).waitFor()
  await sleep(300)
  const png = await win((w) => w.webContents.capturePage().then((i) => i.toPNG().toString('base64')))
  writeFileSync(join(shots, 'opencode-models.png'), Buffer.from(png, 'base64'))

  // Filtering matches provider and model names.
  await filter.fill('z.ai')
  assert.equal(await pop.getByRole('option').count(), 3, 'filtering by provider name keeps its models')
  await filter.fill('pickle')
  assert.equal(await pop.getByRole('option').count(), 1)
  await filter.fill('llamacpp:a3d2')
  assert.equal(await pop.getByRole('option').count(), 1, 'long ids with colons are listed and found')
  await filter.fill('')
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await pop.getByRole('option').first().waitFor()

  // Pick one: the trigger shows the friendly name.
  await filter.fill('big pickle')
  await filter.press('Enter')
  await dlg.getByRole('button', { name: 'Master model' }).filter({ hasText: 'Big Pickle' }).waitFor()
  console.log('models e2e passed')
} finally {
  await app?.close().catch(() => {})
}
