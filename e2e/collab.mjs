// Collaboration e2e: operators started with a fake claude that really runs the `operant` CLI against the app's
// socket (jobs, messages, nudges), then the seat editor, edit/delete flows, caps, settings and error display.
// Runs in the background with throwaway data. Usage: node e2e/collab.mjs [outDir]
// Set OPERANT_E2E_EXE to a packaged executable to test a build instead of the dev app.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'out/e2e-collab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-collab-'))
const project = mkdtempSync(join(tmpdir(), 'operant-collab-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-collab-claude-'))
writeFileSync(join(project, 'app.ts'), 'export function main() { return helper() }\nfunction helper() { return 1 }\n')

// manager (the PM) adds a job for implementor and messages it; the nudged implementor reads its inbox, claims and
// finishes the job with review (FAKE_CLAUDE_ON_INBOX runs after every `operant inbox`).
const SCRIPT = [
  '[manager] operant whoami',
  '[implementor] operant whoami',
  '[manager] operant job add "Build the login form" --for implementor --review user --body "Scaffold the form"',
  '[manager] operant msg implementor "Please start on the login form"',
].join('\n')
const ON_INBOX = ['[implementor] operant job claim', '[implementor] operant job done 1 --note "form scaffolded"'].join('\n')

const env = {
  ...process.env,
  OPERANT_BACKGROUND: '1', OPERANT_E2E: '1',
  OPERANT_DATA_DIR: dataDir,
  CLAUDE_CONFIG_DIR: claudeDir,
  FAKE_CLAUDE_SCRIPT: SCRIPT,
  FAKE_CLAUDE_ON_INBOX: ON_INBOX,
}
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const packaged = process.env.OPERANT_E2E_EXE

const consoleNotes = []
let app = null
let page = null

async function launch() {
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleNotes.push(`console.error: ${m.text()}`)
  })
  page.on('pageerror', (e) => consoleNotes.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
}

async function relaunch() {
  await app.close()
  await launch()
}

const inv = (channel, ...args) =>
  page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
// A call that must be refused: resolves to { code, message }.
const refused = (channel, ...args) =>
  page.evaluate(
    async ([c, a]) => {
      try {
        await window.operant.invoke(c, ...a)
        return null
      } catch (e) {
        const m = /^OPERANT_ERR:([A-Z_]+):([\s\S]*)$/.exec(e.message)
        return m ? { code: m[1], message: m[2], raw: e.message } : { code: undefined, message: e.message, raw: e.message }
      }
    },
    [channel, args],
  )

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(label, fn, timeout = 30_000, every = 250) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    } catch (e) {
      last = e
    }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`)
}

const jsonl = (file) => {
  const p = join(claudeDir, file)
  return existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
}
const launches = () => jsonl('fake-claude-launches.jsonl')
const commands = () => jsonl('fake-claude-commands.jsonl')
const ran = (operator, cmd) => commands().find((c) => c.operator === operator && c.cmd.startsWith(cmd))

const shot = async (name) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}
const editor = () => page.getByRole('region', { name: 'Seat editor' })
const seatView = (label) => page.getByRole('group', { name: 'Seat editor view' }).getByRole('button', { name: label, exact: true })
const mode = (label) => page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: label, exact: true })
const typeInto = (id, text) => inv('operators:write', id, text + '\r')
const buffer = (id) => inv('operators:buffer', id)

const results = []
const timings = {}
async function step(name, fn) {
  const t0 = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] })
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`)
    await page?.screenshot({ path: join(outDir, `fail-${results.length}.png`) }).catch(() => {})
  }
  timings[name] = Date.now() - t0
}

const ids = {}
const T0 = Date.now()
const job = (id) => inv('jobs:get', id)
const spentOf = async (id) => (await inv('caps:status')).operators[id]?.spentUsd ?? 0
const totalSpend = async () => (await inv('usage:breakdown', ids.crew, '30d')).totalUsd
let masterId = null

try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()
  await shot('00-welcome')

  await step('1. seed: PM and implementor from presets; launch line per preset (args file)', async () => {
    Object.assign(
      ids,
      await page.evaluate(async (folder) => {
        const inv = window.operant.invoke.bind(window.operant)
        const crew = await inv('crews:create', { name: 'shop', folder })
        const dev = await inv('squads:create', { crewId: crew.id, name: 'dev' })
        const review = await inv('squads:create', { crewId: crew.id, name: 'review' })
        const presets = await inv('presets:list')
        const preset = (b) => presets.find((p) => p.builtin === b)
        const manager = await inv('operators:createFromPreset', { squadId: dev.id, role: 'manager', presetId: preset('pm').id })
        const implementor = await inv('operators:createFromPreset', { squadId: dev.id, role: 'implementor', presetId: preset('implementor').id })
        const reviewer = await inv('operators:createFromPreset', { squadId: review.id, role: 'reviewer', presetId: preset('reviewer').id })
        await inv('crews:update', crew.id, { pmId: manager.id })
        await inv('settings:set', { collab: { nudgeIdleSeconds: 1, nudgeBatchSeconds: 0 } })
        const side = await inv('crews:create', { name: 'side', folder })
        return {
          crew: crew.id,
          side: side.id,
          dev: dev.id,
          review: review.id,
          manager: manager.id,
          implementor: implementor.id,
          reviewer: reviewer.id,
          presets: { pm: preset('pm'), implementor: preset('implementor') },
        }
      }, project),
    )
    await page.getByRole('heading', { name: 'shop' }).waitFor({ timeout: 15_000 }).catch(async () => {
      await page.getByText('shop', { exact: true }).first().click()
      await page.getByRole('heading', { name: 'shop' }).waitFor()
    })
    assert.equal(await mode('Crew').count(), 0, 'crew mode is gone')
    await inv('operators:start', ids.implementor)
    await inv('operators:start', ids.manager)
    await until('both launch lines', () => launches().length >= 2)
    for (const [op, preset] of [
      ['manager@shop', ids.presets.pm],
      ['implementor@shop', ids.presets.implementor],
    ]) {
      const x = launches().find((l) => l.operator === op)
      assert.ok(x, `no launch for ${op}`)
      assert.equal(x.model, preset.model, `${op} --model`)
      assert.equal(x.effort, preset.effort || null, `${op} --effort`)
      assert.equal(x.permissionMode, preset.permissionMode, `${op} --permission-mode`)
      assert.ok(x.settings, `${op} has no --settings`)
      assert.ok(x.appendSystemPromptFile, `${op} has no --append-system-prompt-file`)
      assert.equal(x.strictMcpConfig, true, `${op} --strict-mcp-config`)
      assert.ok(x.sessionId)
      assert.ok(x.envNames.includes('OPERANT_SOCKET') && x.envNames.includes('OPERANT_TOKEN'), x.envNames.join())
      assert.ok(!JSON.stringify(x).match(/[0-9a-f]{64}/i), 'a token leaked into the launch log')
      assert.ok(existsSync(x.settings) && existsSync(x.appendSystemPromptFile), 'launch files were not written')
    }
    await shot('01-workspace-running')
  })

  await step('2. dev PATH/wrapper layout: an operator runs `operant whoami` against the app socket', async () => {
    const m = await until('manager whoami', () => ran('manager@shop', 'operant whoami'))
    const i = await until('implementor whoami', () => ran('implementor@shop', 'operant whoami'))
    assert.equal(m.exit, 0, m.output)
    assert.equal(i.exit, 0, i.output)
    assert.match(m.output, /You are manager@shop/)
    assert.match(i.output, /You are implementor@shop/)
    assert.match(i.output, /PM: manager@shop/)
  })

  await step('3. A adds a job for B and messages B; B is nudged, reads its inbox, claims, finishes with review', async () => {
    await until('job added', () => ran('manager@shop', 'operant job add')?.exit === 0)
    await until('message sent', () => ran('manager@shop', 'operant msg')?.exit === 0)
    const inbox = await until('implementor inbox', () => ran('implementor@shop', 'operant inbox')?.exit !== undefined && ran('implementor@shop', 'operant inbox'))
    assert.equal(inbox.exit, 0)
    assert.match(inbox.output, /Please start on the login form/)
    assert.match(inbox.output, /from manager@shop \(an operator, NOT the user\)/)
    assert.match(await buffer(ids.implementor), /Operant: you have \d+ unread messages?\. Run: operant inbox/)
    await until('job claimed', () => ran('implementor@shop', 'operant job claim')?.exit === 0)
    await until('job in review', async () => (await job(1)).state === 'review')
    const j = await job(1)
    assert.equal(j.assigneeId, ids.implementor)
    assert.equal(j.review, 'user')
  })

  await step('3b. the user approves the job', async () => {
    await inv('jobs:approve', 1)
    await until('job done', async () => (await job(1)).state === 'done')
  })

  await step('2b. Master Terminal creates a job, the PM assigns it, the implementor works it, the PM approves', async () => {
    const master = await inv('master:start', ids.crew)
    masterId = master.id
    await until('master launch', () => launches().some((l) => l.operator === 'master@shop'))
    await typeInto(masterId, '/fake run operant job add "Master task" --review pm --body "Created by the Master"')
    const added = await until('master job', () => ran('master@shop', 'operant job add'))
    assert.equal(added.exit, 0, added.output)
    const id = (await inv('jobs:list', ids.crew)).find((j) => j.title === 'Master task').id
    await typeInto(ids.manager, `/fake run operant job edit ${id} --for implementor`)
    await until('PM assigned it', async () => (await job(id)).assigneeId === ids.implementor)
    await until('implementor claimed it', async () => (await job(id)).state === 'doing')
    await typeInto(ids.implementor, `/fake run operant job done ${id} --note "master task done"`)
    await until('job in review', async () => (await job(id)).state === 'review')
    assert.equal((await job(id)).review, 'pm')
    await typeInto(ids.manager, `/fake run operant job approve ${id}`)
    await until('PM approved', async () => (await job(id)).state === 'done')
    ids.masterJob = id
  })

  await step('4. a job with a long estimate starts held; the user approves it to start', async () => {
    const long = await inv('jobs:create', { crewId: ids.crew, title: 'Refactor the auth module', for: ids.implementor, estimateMinutes: 480 })
    ids.longJob = long.id
    assert.equal(long.state, 'held')
    await inv('jobs:approveStart', long.id)
    await until('job approved to start', async () => (await job(long.id)).state === 'todo')
    await typeInto(ids.implementor, `/fake run operant job claim ${long.id}`)
    await until('job doing', async () => (await job(long.id)).state === 'doing')
  })

  await step('5. change effort: restarts fresh (R1), jobs persist', async () => {
    const before = launches().filter((l) => l.operator === 'implementor@shop').length
    const oldSession = launches().findLast((l) => l.operator === 'implementor@shop').sessionId
    await inv('operators:previewChange', ids.implementor, { effort: 'high' })
    await inv('operators:applyChange', ids.implementor, { effort: 'high' })
    await until('fresh launch', () => launches().filter((l) => l.operator === 'implementor@shop').length > before)
    const l = launches().findLast((x) => x.operator === 'implementor@shop')
    assert.equal(l.effort, 'high')
    assert.notEqual(l.sessionId, oldSession, 'a fresh session id is used (R1), not --resume')
    assert.ok(!l.argv.includes('--resume'))
    const j = await job(ids.longJob)
    assert.equal(j.assigneeId, ids.implementor, 'the job stays with the operator across the restart')
    assert.equal(j.state, 'doing')
  })

  await step('5b. change model: restarts fresh and keeps the earlier effort', async () => {
    const before = launches().filter((l) => l.operator === 'implementor@shop').length
    await inv('operators:applyChange', ids.implementor, { model: 'opus' })
    await until('fresh launch', () => launches().filter((l) => l.operator === 'implementor@shop').length > before)
    const l = launches().findLast((x) => x.operator === 'implementor@shop')
    assert.match(l.model, /opus/)
    assert.equal(l.effort, 'high', 'the earlier effort change is kept')
    assert.equal((await job(ids.longJob)).state, 'doing')
  })

  await step('6. token cap pauses an operator without killing it; raising resumes', async () => {
    await inv('operators:update', ids.implementor, { dailyCapUsd: 100 })
    await until('implementor spend ingested', async () => (await spentOf(ids.implementor)) > 0)
    await typeInto(ids.implementor, '/fake spend 0 10000 0')
    const base = await spentOf(ids.implementor)
    await until('spend grew', async () => (await spentOf(ids.implementor)) > base)
    const spent = await spentOf(ids.implementor)
    const unit = spent - base
    const cap = spent / 0.85
    await inv('operators:update', ids.implementor, { dailyCapUsd: Math.round(cap * 1e6) / 1e6 })
    await until('cap warning', async () => (await inv('caps:status')).operators[ids.implementor]?.pct >= 80)
    assert.ok((await inv('events:recent', 100)).some((e) => /is at 8\d%/.test(e.message)), 'a cap warning event was logged')

    const more = Math.ceil((cap - spent) / unit) + 2
    await typeInto(ids.implementor, `/fake spend 0 ${more * 10000} 0`)
    await until('paused', async () => (await inv('caps:status')).operators[ids.implementor]?.paused === true)
    const op = (await inv('crews:topology', ids.crew)).squads.flatMap((s) => s.operators).find((o) => o.id === ids.implementor)
    assert.equal(op.status, 'running', 'the paused operator is not killed')
    const claim = (id) => commands().filter((c) => c.operator === 'implementor@shop' && c.cmd === `operant job claim ${id}`).length
    const extra = await inv('jobs:create', { crewId: ids.crew, title: 'Cap probe', for: ids.implementor })
    const inboxBefore = commands().filter((c) => c.operator === 'implementor@shop' && c.cmd === 'operant inbox').length
    await inv('messages:send', { crewId: ids.crew, to: 'implementor', body: 'ping while paused' })
    await typeInto(ids.implementor, `/fake run operant job claim ${extra.id}`)
    await until('claim refused', () => commands().some((c) => c.operator === 'implementor@shop' && c.cmd === `operant job claim ${extra.id}` && c.exit === 6))
    assert.equal(claim(extra.id), 1)
    await sleep(3500)
    assert.equal(
      commands().filter((c) => c.operator === 'implementor@shop' && c.cmd === 'operant inbox').length,
      inboxBefore,
      'no nudge is typed to a paused operator',
    )
    await inv('caps:reset', ids.implementor)
    await until('resumed', async () => (await inv('caps:status')).operators[ids.implementor]?.paused !== true)
    assert.ok((await inv('caps:status')).operators[ids.implementor].pct < 100, 'spend counts from the reset, so the cap shows under 100% again')
    await until('nudged after resume', () => commands().filter((c) => c.operator === 'implementor@shop' && c.cmd === 'operant inbox').length > inboxBefore)
    // The nudge after the resume runs FAKE_CLAUDE_ON_INBOX, whose bare `job claim` takes the pre-assigned job.
    await until('job claimed after resume', async () => (await job(extra.id)).state === 'doing')
    await inv('jobs:delete', extra.id)
  })

  await step('7. spend is recorded', async () => {
    assert.ok((await totalSpend()) > 0)
  })

  await step('8. graph data: message and handoff edges exist for the crew (backend only)', async () => {
    const g = await inv('graph:get', ids.crew, 'all')
    const kinds = new Set(g.edges.map((e) => e.kind))
    for (const k of ['member', 'message', 'job']) assert.ok(kinds.has(k), `graph edge kind ${k} missing: ${[...kinds]}`)
    assert.ok(g.nodes.some((n) => n.type === 'master'), 'the graph has a Master node')
  })

  await step('9. seat editor: seats and teams in the node view, edited inline, the list view shows the same data', async () => {
    await mode('Seats').click()
    await editor().waitFor()
    await page.locator('.react-flow__node').first().waitFor()
    await editor().getByRole('button', { name: 'New seat' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name', { exact: true }).fill('docs writer')
    await dialog.getByRole('button', { name: 'Create preset' }).click()
    await editor().getByRole('button', { name: 'Edit docs writer' }).waitFor()
    await editor().getByRole('button', { name: 'New team' }).click()
    await dialog.getByLabel('Name', { exact: true }).fill('Writers')
    await dialog.getByRole('button', { name: 'Add seat' }).click()
    await dialog.getByRole('combobox', { name: 'Seat 1 preset' }).click()
    await page.getByRole('option', { name: 'docs writer' }).click()
    await dialog.getByLabel('Seat 1 count').fill('2')
    await dialog.getByRole('button', { name: 'Create team' }).click()
    await editor().getByRole('button', { name: 'Edit Writers' }).waitFor()
    const writers = (await inv('teams:list')).find((t) => t.name === 'Writers')
    const seat = (await inv('presets:list')).find((p) => p.name === 'docs writer')
    assert.deepEqual(writers.seats.map((x) => [x.presetId, x.count]), [[seat.id, 2]])
    await page.locator('.react-flow__edge').first().waitFor()
    await shot('08-seat-editor-nodes')
    await seatView('List').click()
    await editor().getByRole('button', { name: 'Edit Writers' }).waitFor()
    await editor().getByRole('button', { name: 'Edit docs writer' }).waitFor()
    await shot('09-seat-editor-list')
    await seatView('Nodes').click()
  })

  await step('12. Settings change apply live (daily cap per operator, shortcuts)', async () => {
    await page.keyboard.press('Control+,')
    await page.getByRole('heading', { name: 'Settings' }).waitFor()
    await page.getByRole('button', { name: 'Tokens', exact: true }).click()
    await page.getByLabel('Default daily cap per operator (USD)').fill('3')
    await page.getByLabel('Default daily cap per operator (USD)').press('Enter')
    await until('default cap saved', async () => (await inv('settings:get')).tokens.operatorDailyCapUsd === 3)
    await shot('15-settings-tokens')
    await inv('operators:start', ids.reviewer)
    await until('reviewer launch', () => launches().some((l) => l.operator === 'reviewer@shop'))
    await until('default cap applies live', async () => (await inv('caps:status')).operators[ids.reviewer]?.capUsd === 3)
    await page.getByRole('button', { name: 'Collaboration', exact: true }).click()
    await page.getByLabel('Keep deleted operators for (days)').fill('0')
    await page.getByLabel('Keep deleted operators for (days)').press('Enter')
    await until('retention saved', async () => (await inv('settings:get')).collab.purgeRetentionDays === 0)
    await shot('16-settings-collab')
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click()
    await page.getByRole('button', { name: 'Ctrl+N' }).click()
    await page.keyboard.press('Control+Shift+K')
    await page.getByRole('button', { name: 'Ctrl+Shift+K' }).waitFor()
    await shot('17-settings-shortcuts')
    assert.equal((await inv('settings:get')).keybinds.newCrew, 'Mod+Shift+K')
    await page.getByRole('complementary', { name: 'Projects' }).getByText('shop', { exact: true }).click()
  })

  await step('13. a failing IPC call shows a typed inline error (duplicate seat name)', async () => {
    const r = await refused('squads:create', { crewId: ids.crew, name: 'dev' })
    assert.ok(r, 'the duplicate squad name was accepted')
    assert.ok(!/Error invoking remote method/.test(r.raw), `Electron's prefix leaked: ${r.raw}`)
    assert.equal(r.code, 'CONFLICT', 'the IPC error carries its typed code')
    await mode('Seats').click()
    await editor().getByRole('button', { name: 'New seat' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name', { exact: true }).fill('docs writer')
    await dialog.getByRole('button', { name: 'Create preset' }).click()
    const err = dialog.locator('p.text-destructive')
    await err.waitFor()
    const text = await err.innerText()
    assert.ok(!/OPERANT_ERR|Error invoking remote method/.test(text), `the wire prefix leaked: ${text}`)
    await shot('10-error-inline')
    console.log(`  duplicate error: code=${r.code} message=${JSON.stringify(r.message)} inline=${JSON.stringify(text)}`)
    await page.keyboard.press('Escape')
  })

  await step('14. delete a running operator: its job is released, history and spend are kept', async () => {
    const running = (await inv('crews:topology', ids.crew)).squads.flatMap((s) => s.operators).find((o) => o.id === ids.implementor)
    if (running.status === 'stopped') {
      await inv('operators:start', ids.implementor)
      await until('implementor launch', () => launches().filter((l) => l.operator === 'implementor@shop').length >= 1)
    }
    await until('implementor running', async () => (await inv('crews:topology', ids.crew)).squads.flatMap((s) => s.operators).find((o) => o.id === ids.implementor).status === 'running')
    await sleep(1500)
    await typeInto(ids.implementor, `/fake run operant job claim ${ids.longJob}`)
    await until('job doing again', async () => (await job(ids.longJob)).state === 'doing')
    const eventsBefore = (await inv('events:recent', 500)).length
    const spendBefore = await totalSpend()
    await inv('operators:delete', ids.implementor)
    await until('operator gone', async () => !(await inv('crews:topology', ids.crew)).squads.flatMap((s) => s.operators).some((o) => o.id === ids.implementor))
    const j = await job(ids.longJob)
    assert.equal(j.assigneeId, null, 'the job was released')
    assert.notEqual(j.state, 'doing')
    assert.ok((await inv('events:recent', 500)).length > eventsBefore, 'the delete was logged')
    assert.equal((await job(1)).title, 'Build the login form', 'history (jobs) is kept')
    assert.ok(Math.abs((await totalSpend()) - spendBefore) < 1e-9, 'spend is unchanged by the delete')
    ids.spendAfterDelete = spendBefore
  })

  await step('15. Purge now with retention 0: the deleted operator goes, spend totals stay equal', async () => {
    const before = await totalSpend()
    const day = (await inv('dashboard:summary')).spendToday
    const status = await inv('purge:status')
    assert.ok(status.candidates.some((c) => c.label.includes('implementor')), 'the deleted operator is a purge candidate')
    const out = await inv('purge:now', 'all')
    const mine = out.find((o) => o.label.includes('implementor'))
    assert.ok(mine?.purged, `purge blocked: ${JSON.stringify(mine)}`)
    assert.ok(Math.abs((await totalSpend()) - before) < 1e-9, `crew spend changed by the purge: ${before} -> ${await totalSpend()}`)
    assert.ok(Math.abs((await inv('dashboard:summary')).spendToday - day) < 1e-9, 'daily total changed by the purge')
  })

  await step('16. delete job and squad over IPC, crew from the dashboard', async () => {
    await inv('jobs:delete', ids.longJob)
    await until('job deleted', async () => (await inv('jobs:list', ids.crew)).every((j) => j.id !== ids.longJob))
    await inv('squads:delete', ids.review)
    await until('squad deleted', async () => !(await inv('crews:topology', ids.crew)).squads.some((s) => s.name === 'review'))
    await page.getByRole('complementary', { name: 'Projects' }).getByText('side', { exact: true }).click()
    await page.getByRole('heading', { name: 'side' }).waitFor()
    await mode('Workspace').click()
    await page.getByRole('heading', { name: 'side' }).hover({ position: { x: 4, y: 4 } })
    await page.getByRole('button', { name: 'Actions for project side' }).click()
    await page.getByRole('menuitem', { name: 'Delete project' }).click()
    await shot('20-delete-crew-dialog')
    await page.getByRole('dialog').getByRole('button', { name: 'Delete project' }).click()
    await until('crew deleted', async () => (await inv('crews:list')).every((c) => c.id !== ids.side))
    await page.getByRole('heading', { name: 'shop' }).waitFor()
    await shot('21-after-deletes')
  })
} finally {
  await app?.close().catch(() => {})
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
const real = consoleNotes.filter((n) => !/Download the React DevTools/.test(n))
if (real.length) console.log('renderer console errors:\n' + real.join('\n'))
console.log(`\n${results.length - failed.length}/${results.length} steps passed in ${Date.now() - T0} ms; screenshots in ${outDir}`)
for (const f of failed) console.log(`  FAIL ${f.name}: ${f.error}`)
if (failed.length || real.length) process.exit(1)
console.log('collab e2e passed')
