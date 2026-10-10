// Claude Mods e2e: a Claude tile shows its info bar and the Agents panel. The fake Claude fixture sends hook events and a
// status line payload (through the commands Operant wrote into --settings), so the panel goes from Running to Completed,
// shows the context card from the popover, and shows Waiting when Claude asks for input. Runs in the background with
// throwaway data. Usage: node e2e/mods.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-mods-'))
const project = mkdtempSync(join(tmpdir(), 'operant-mods-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-mods-claude-'))
const hookFile = join(claudeDir, 'hook-events.jsonl')
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
// Events the fake Claude sends: the session starts and a prompt is submitted, the status line reports the context, a
// sub-agent runs and finishes, and Claude then asks for input.
const steps = [
  { after: 300, event: 'SessionStart', payload: { cwd: project } },
  { after: 400, event: 'UserPromptSubmit', payload: {} },
  {
    after: 450,
    event: 'StatusLine',
    payload: {
      model: { display_name: 'Sonnet 5.5' },
      context_window: {
        context_window_size: 1_000_000,
        used_percentage: 9,
        current_usage: { input_tokens: 1000, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 9000, output_tokens: 300 },
      },
      cost: { total_cost_usd: 0.42, total_duration_ms: 120_000 },
    },
  },
  { after: 500, event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu1', tool_input: { description: 'Map the tile code' } } },
  { after: 600, event: 'SubagentStart', payload: { agent_id: 'agent-1', agent_type: 'Explore' } },
  { after: 6000, event: 'PostToolUse', payload: { tool_name: 'Agent', tool_use_id: 'tu1', tool_response: { agentId: 'agent-1', status: 'completed' } } },
  { after: 6100, event: 'SubagentStop', payload: { agent_id: 'agent-1', agent_type: 'Explore' } },
  { after: 6400, event: 'Notification', payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } },
]
writeFileSync(hookFile, steps.map((e) => JSON.stringify(e)).join('\n') + '\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, FAKE_CLAUDE_HOOK_EVENTS: hookFile }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForFunction(() => !!window.operant)
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
  const shot = async (name) => (await page.waitForTimeout(400), page.screenshot({ path: join(outDir, `${name}.png`) }))

  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('crews:create', { name: 'mods', folder: project })
  await inv('settings:set', { mainCli: 'claude', claudeMods: { enabled: true, mods: { subagents: true } }, infoBar: true })
  await page.locator('[data-crew-row]').getByText('mods', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'mods', level: 1 }).waitFor()
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()

  // A Claude tile in the Terminal view: the info bar is under its title, the Agents panel beside it.
  await page.locator('[data-crew-row]').getByText('mods', { exact: true }).click({ button: 'right', position: { x: 4, y: 4 } })
  await page.getByRole('menuitem', { name: 'New Claude terminal here' }).click()
  await page.getByRole('region', { name: /^Claude: / }).waitFor({ timeout: 20_000 })
  // New Claude tiles open in the Chat view; this test drives the Terminal view (hook events, status line, info bar).
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  const info = page.getByLabel('Tile info')
  await info.waitFor()
  await info.getByText('Sonnet 5.5').waitFor({ timeout: 15_000 }) // the model comes from the status line

  const panel = page.getByTestId('subagent-panel')
  await panel.waitFor()
  assert.match(await panel.innerText(), /Agents/)
  await panel.getByRole('img', { name: 'Running' }).waitFor({ timeout: 15_000 })
  assert.match(await panel.innerText(), /Explore/)
  await shot('mods-subagent-running')

  // The context card opens from the info bar's context bar: real numbers only, with the category note.
  await info.getByRole('button', { name: 'Context details' }).click()
  const card = page.getByRole('region', { name: 'Context' }).last()
  await card.waitFor()
  assert.match(await card.innerText(), /1M/, 'the window size is shown')
  assert.match(await card.innerText(), /Category breakdown is only available from \/context inside Claude/)
  await shot('mods-context-popover')
  await info.getByRole('button', { name: 'Context details' }).click() // closes the popover

  // The sub-agent finishes: its dot turns to Done, and no row is Running.
  await panel.getByRole('img', { name: 'Done' }).waitFor({ timeout: 20_000 })
  assert.equal(await panel.getByRole('img', { name: 'Running' }).count(), 0, 'no agent runs any more')
  await shot('mods-subagent-completed')

  // Claude asks for input: the tile header says so (the panel is only a list of agents).
  await page.getByRole('status').filter({ hasText: /Needs you|Waiting/ }).first().waitFor({ timeout: 15_000 })
  await shot('mods-subagent-waiting')

  console.log('mods e2e ok')
} finally {
  await app.close()
}
