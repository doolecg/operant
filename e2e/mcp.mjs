// MCP servers e2e: the MCP page (status badges, add, edit, disable, remove with confirmation, secrets masked).
// Runs in the background with throwaway data, the real claude and the fake opencode CLI (e2e/fixtures/bin).
// Usage: node e2e/mcp.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { claudeHome, e2eEnv } from './fixtures/real-claude.mjs'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-mcp-'))
const project = mkdtempSync(join(tmpdir(), 'operant-mcp-proj-'))
const claudeRoot = mkdtempSync(join(tmpdir(), 'operant-mcp-claude-'))
const claudeDir = claudeHome(claudeRoot)
process.on('exit', () => rmSync(claudeRoot, { recursive: true, force: true }))
const ocFile = join(dataDir, 'opencode.json')
const SECRET = 'sk-e2e-secret-123456'

writeFileSync(
  join(claudeDir, '.claude.json'),
  JSON.stringify({
    mcpServers: {
      'files-srv': { type: 'stdio', command: 'npx', args: ['files-mcp', `--api-key=${SECRET}`], env: { API_KEY: SECRET } },
      'bad-srv': { type: 'http', url: 'http://127.0.0.1:9/stream' },
      'auth-srv': { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
    },
  }),
)
writeFileSync(ocFile, JSON.stringify({ mcp: { servers: { 'oc-good': { type: 'local', command: ['node', 'srv.js'] } } } }))

// Which runtimes count as installed for the optional integrations: uvx missing, npx and codegraph present to start. The app reads this
// file (OPERANT_E2E_RUNTIMES) instead of probing the machine, and the Check again button re-reads it.
const runtimesFile = join(dataDir, 'runtimes.json')
const setRuntimes = (runtimes) => writeFileSync(runtimesFile, JSON.stringify(runtimes))
setRuntimes({ uvx: false, npx: true, codegraph: true })

const env = e2eEnv({ dataDir, claudeDir, extra: { OPERANT_E2E_RUNTIMES: runtimesFile, OPENCODE_CONFIG: ocFile } })
const packaged = process.env.OPERANT_E2E_EXE

let app = null
let page = null
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const shot = async (name) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}
const row = (name) => page.locator('tr', { has: page.getByText(name, { exact: true }) })

try {
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()

  const ids = await page.evaluate(async (folder) => {
    const o = window.operant
    const crew = await o.invoke('crews:create', { name: 'mcp-demo', folder })
    return { crew: crew.id }
  }, project)

  // The MCP page: statuses from the CLIs, secrets masked.
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'MCP servers', exact: true }).click()
  await page.getByText(/Read from each CLI/).waitFor()
  await row('files-srv').waitFor({ timeout: 60_000 })
  await row('files-srv').getByText('Connected').waitFor()
  await row('bad-srv').getByText('Failed', { exact: true }).waitFor()
  await row('bad-srv').getByText(/ECONNREFUSED/).waitFor()
  await row('auth-srv').getByText('Needs auth').waitFor()
  await row('oc-good').getByText('Connected').waitFor()
  assert.ok((await row('oc-good').textContent()).includes('OpenCode'))
  assert.ok(!(await page.locator('body').innerText()).includes(SECRET), 'a secret reached the page')
  assert.ok(!JSON.stringify(await inv('mcp:list', ids.crew)).includes(SECRET), 'a secret reached the IPC result')
  await shot('mcp')

  // Add through the CLI, with a secret that is masked afterwards.
  await page.getByRole('button', { name: 'Add server' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill('added-srv')
  await dialog.getByLabel('Command and arguments').fill('node server.js --port 80')
  await dialog.getByLabel('Environment').fill('TOKEN=added-secret-value')
  await dialog.getByRole('button', { name: 'Add server' }).click()
  await dialog.waitFor({ state: 'detached' })
  await row('added-srv').getByText('Connected').waitFor()
  assert.ok(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers['added-srv'].env.TOKEN === 'added-secret-value')
  assert.ok(!(await page.locator('body').innerText()).includes('added-secret-value'))

  // Edit keeps the masked value.
  await page.getByRole('button', { name: 'Edit added-srv' }).click()
  assert.equal(await dialog.getByLabel('Environment').inputValue(), 'TOKEN=***')
  await dialog.getByLabel('Command and arguments').fill('node server.js --port 81')
  await dialog.getByRole('button', { name: 'Save server' }).click()
  await dialog.waitFor({ state: 'detached' })
  await row('added-srv').getByText('node server.js --port 81').waitFor()
  const saved = JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers['added-srv']
  assert.equal(saved.env.TOKEN, 'added-secret-value')
  assert.deepEqual(saved.args, ['server.js', '--port', '81'])

  // Disable and enable (OpenCode: its own config file).
  await row('oc-good').getByRole('switch', { name: 'Enabled oc-good' }).click()
  await row('oc-good').getByText('Disabled').waitFor()
  assert.equal(JSON.parse(readFileSync(ocFile, 'utf8')).mcp.servers['oc-good'].disabled, true)
  await row('oc-good').getByRole('switch', { name: 'Enabled oc-good' }).click()
  await row('oc-good').getByText('Connected').waitFor()

  // Remove asks first.
  await page.getByRole('button', { name: 'Remove added-srv' }).click()
  await dialog.getByText(/Remove added-srv from Claude Code/).waitFor()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  assert.ok('added-srv' in JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers, 'cancel must keep the server')
  await page.getByRole('button', { name: 'Remove added-srv' }).click()
  await dialog.getByRole('button', { name: 'Remove server' }).click()
  await row('added-srv').waitFor({ state: 'detached' })
  assert.ok(!('added-srv' in JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers))

  // Optional integrations. Both start as not added. With uvx missing, Git cannot be added and says why. Playwright
  // (npx present) is added to Claude Code, shows in the table and is removed again. Then uvx is present, the check runs
  // again, a project is picked and Git is added with that folder.
  await page.getByText('Optional integrations', { exact: true }).waitFor()
  assert.equal(await page.getByText('Not added', { exact: true }).count(), 3)
  assert.ok(!('playwright' in (JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers ?? {})), 'nothing may be added before Add is clicked')
  assert.ok(await page.getByRole('button', { name: 'Add Git MCP' }).isDisabled())
  await page.getByText(/uvx is not installed/).waitFor()
  await shot('mcp-optional')
  await page.getByRole('button', { name: 'Add Playwright MCP' }).click()
  await page.getByRole('button', { name: 'Write to the chosen CLIs' }).click()
  await page.getByText('Added by Operant', { exact: true }).waitFor()
  await row('playwright').getByText('Connected').waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers.playwright.args, ['@playwright/mcp@latest'])
  await page.getByRole('button', { name: 'Remove Playwright MCP added by Operant' }).click()
  await row('playwright').waitFor({ state: 'detached' })
  assert.ok(!('playwright' in JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers))
  await page.getByText('Not added', { exact: true }).nth(1).waitFor()

  // Git needs a project: the Project selector is set to no project first, so the reason shows, then mcp-demo is picked.
  setRuntimes({ uvx: true, npx: true, codegraph: true })
  await page.getByRole('button', { name: 'Check optional integrations again' }).click()
  await page.getByText(/uvx is not installed/).waitFor({ state: 'detached' })
  await page.getByRole('combobox', { name: 'Project' }).click()
  await page.getByRole('option', { name: 'No project (user level)' }).click()
  await page.getByText(/Select a project first/).waitFor()
  assert.ok(await page.getByRole('button', { name: 'Add Git MCP' }).isDisabled(), 'Git needs a project even with uvx present')
  await page.getByRole('combobox', { name: 'Project' }).click()
  await page.getByRole('option', { name: 'mcp-demo' }).click()
  await page.getByText(/Select a project first/).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Add Git MCP' }).click()
  await page.getByRole('button', { name: 'Write to the chosen CLIs' }).click()
  await row('git').getByText('Connected').waitFor()
  const gitArgs = JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers.git.args
  assert.deepEqual(gitArgs.slice(0, 2), ['mcp-server-git', '--repository'], 'Git was not written with its package and folder')
  await page.getByRole('button', { name: 'Remove Git MCP added by Operant' }).click()
  await row('git').waitFor({ state: 'detached' })

  // CodeGraph: codegraph is present and not in the config, so Add writes it and Remove takes it back. A missing codegraph
  // command blocks Add. A copy the user wrote by hand (same name, no record) shows as found and is never removed.
  const cgCard = page.locator('div.rounded-md.border', { hasText: 'CodeGraph MCP' })
  await cgCard.getByText('Not added', { exact: true }).waitFor()
  setRuntimes({ uvx: true, npx: true, codegraph: false })
  await page.getByRole('button', { name: 'Check optional integrations again' }).click()
  await cgCard.getByText(/codegraph is not installed/).waitFor()
  assert.ok(await page.getByRole('button', { name: 'Add CodeGraph MCP' }).isDisabled(), 'CodeGraph cannot be added without its command')
  setRuntimes({ uvx: true, npx: true, codegraph: true })
  await page.getByRole('button', { name: 'Check optional integrations again' }).click()
  await cgCard.getByText(/codegraph is not installed/).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Add CodeGraph MCP' }).click()
  await page.getByRole('button', { name: 'Write to the chosen CLIs' }).click()
  await cgCard.getByText('Added by Operant', { exact: true }).waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers.codegraph, { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] })
  await page.getByRole('button', { name: 'Remove CodeGraph MCP added by Operant' }).click()
  await cgCard.getByText('Not added', { exact: true }).waitFor()
  assert.ok(!('codegraph' in JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers), 'Remove must take the CodeGraph entry back')

  const cfg = JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8'))
  cfg.mcpServers.codegraph = { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], alwaysLoad: true }
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify(cfg))
  await page.getByRole('button', { name: 'Check optional integrations again' }).click()
  await cgCard.getByText(/Found in your config as codegraph/).waitFor()
  assert.ok(await page.getByRole('button', { name: 'Remove CodeGraph MCP added by Operant' }).count() === 0, 'a hand-made copy must not show Remove')

  console.log('mcp e2e passed; screenshots in', outDir)
} catch (err) {
  await page?.screenshot({ path: join(outDir, 'fail-mcp.png') }).catch(() => {})
  throw err
} finally {
  await app?.close().catch(() => {})
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}
