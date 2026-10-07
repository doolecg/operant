// Console e2e: a background command (the fake claude's `mcp list`) logs into the in-app console, the drawer opens from the
// header icon and the rebindable key, filters by source, searches, clears, and nothing secret shows. Runs in the background
// with throwaway data. Usage: node e2e/console.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-console-'))
const project = mkdtempSync(join(tmpdir(), 'operant-console-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-console-claude-'))
const SECRET = 'sk-e2e-secret-123456'
writeFileSync(
  join(claudeDir, '.claude.json'),
  JSON.stringify({ mcpServers: { 'files-srv': { type: 'stdio', command: 'npx', args: ['files-mcp', `--api-key=${SECRET}`], env: { API_KEY: SECRET } } } }),
)

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
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

  const crew = await inv('crews:create', { name: 'console-demo', folder: project })
  await page.getByRole('heading', { name: 'console-demo' }).waitFor()
  assert.equal(await page.getByTestId('console-drawer').count(), 0, 'the drawer starts closed')

  // A background command: the MCP status check runs the (fake) claude CLI and its output must land in the console.
  await inv('mcp:list', crew.id, true)
  let lines = []
  for (const end = Date.now() + 15_000; Date.now() < end; await page.waitForTimeout(250)) {
    lines = await inv('console:list')
    if (lines.some((l) => l.source === 'mcp' && l.stream === 'info' && /exited/.test(l.text))) break
  }
  assert.ok(lines.some((l) => l.source === 'mcp' && l.stream === 'info' && /^started:/.test(l.text)), 'a started line for the mcp process')
  assert.ok(lines.some((l) => l.source === 'mcp' && l.stream === 'stdout'), 'a fake process output line')
  assert.ok(!JSON.stringify(lines).includes(SECRET), 'no secret reaches the console')

  // The header icon opens it; the keybind toggles it.
  await page.getByRole('button', { name: /^Console/ }).click()
  const drawer = page.getByTestId('console-drawer')
  await drawer.waitFor()
  await drawer.getByText(/\[mcp\]/).first().waitFor()
  await page.screenshot({ path: join(outDir, 'console.png') })

  await drawer.getByRole('tab', { name: 'git' }).click()
  await drawer.getByText('No output yet').waitFor()
  await drawer.getByRole('tab', { name: 'mcp', exact: true }).click()
  assert.ok((await drawer.locator('[data-source="mcp"]').count()) > 0, 'mcp tab shows mcp lines')
  await drawer.getByLabel('Search console').fill('zzz-no-such-text')
  assert.equal(await drawer.locator('[data-source]').count(), 0, 'search filters lines')
  await drawer.getByLabel('Search console').fill('')

  await page.keyboard.press('Control+j')
  await drawer.waitFor({ state: 'detached' })
  await page.keyboard.press('Control+j')
  await drawer.waitFor()

  await drawer.getByRole('button', { name: 'Clear console' }).click()
  await drawer.getByText('No output yet').waitFor()
  assert.equal((await inv('console:list', 'mcp')).length, 0, 'clear empties the buffer in main too')

  // Stop refuses a pid the app did not start.
  assert.equal(await inv('console:stop', process.pid), false)
  console.log('console e2e ok')
} finally {
  await app?.close().catch(() => undefined)
}
