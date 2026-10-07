// MCP servers e2e: the MCP page (status badges, add, edit, disable, remove with confirmation, secrets masked), the
// seat dialog's server picker, the header badge when a seat's server is down, and a job that still starts with one
// down. Runs in the background with throwaway data and fake claude and opencode CLIs (e2e/fixtures/bin).
// Usage: node e2e/mcp.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-mcp-'))
const project = mkdtempSync(join(tmpdir(), 'operant-mcp-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-mcp-claude-'))
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

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, OPENCODE_CONFIG: ocFile }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
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
    const presets = await o.invoke('presets:list')
    const pm = presets.find((p) => p.builtin === 'pm')
    await o.invoke('presets:update', pm.id, { mcpServers: ['codegraph', 'bad-srv'] })
    const team = await o.invoke('teams:create', { name: 'solo', seats: [{ presetId: pm.id, count: 1, model: 'sonnet' }] })
    return { crew: crew.id, pm: pm.id, team: team.id }
  }, project)

  // The header badge names the seat's server that is down.
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.getByRole('button', { name: /^MCP servers down: .*bad-srv/ }).waitFor({ timeout: 60_000 })

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

  // The seat dialog picks servers.
  await page.getByRole('button', { name: 'Presets', exact: true }).click()
  await page.getByRole('button', { name: /^Seat settings for project manager$/ }).click()
  const seat = page.getByRole('dialog')
  await seat.getByRole('list', { name: 'MCP servers' }).getByText('files-srv').waitFor()
  await seat.getByRole('checkbox').first().waitFor()
  await seat.getByText('bad-srv').waitFor()
  await seat.getByRole('listitem').filter({ hasText: 'files-srv' }).getByRole('checkbox').check()
  await shot('mcp-seat-dialog')
  await seat.getByRole('button', { name: 'Save seat' }).click()
  await seat.waitFor({ state: 'detached' })
  const pm = (await inv('presets:list')).find((p) => p.id === ids.pm)
  assert.deepEqual([...pm.mcpServers].sort(), ['bad-srv', 'codegraph', 'files-srv'])

  // A job whose seat needs a down server still starts, and Claude gets only the picked servers.
  const run = await inv('runs:create', { crewId: ids.crew, task: 'Say hello', masterCli: 'claude', teamId: ids.team })
  const end = Date.now() + 30_000
  let status = ''
  while (Date.now() < end && status !== 'working') {
    status = (await inv('runs:get', run.id)).status
    if (status === 'failed') break
    await page.waitForTimeout(250)
  }
  assert.equal(status, 'working', 'the job must start even though bad-srv is down')
  const launches = readFileSync(join(claudeDir, 'fake-claude-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const jobLaunch = launches.find((l) => l.argv.includes('-p') && l.argv.includes('--mcp-config'))
  assert.ok(jobLaunch?.strictMcpConfig, 'the job launch passes --strict-mcp-config with the picked servers')
  await inv('runs:stop', run.id)

  console.log('mcp e2e passed; screenshots in', outDir)
} catch (err) {
  await page?.screenshot({ path: join(outDir, 'fail-mcp.png') }).catch(() => {})
  throw err
} finally {
  await app?.close().catch(() => {})
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}
