// Learning loop UI e2e (R16, R18): the Memory page (lessons, Hindsight, CodeGraph notes, personal memory, skill drafts),
// the learning status panel, the header badge and the Learning settings. The learn model is the fake
// claude answering from learn-response.json; lessons, skill drafts and a learn run are seeded into the database, since nothing in the app triggers a learn step on demand. Hindsight points at a closed port, so it is skipped and says why.
// Runs in the background with throwaway data. Usage: node e2e/memory.mjs [outDir]  (default docs/specs/screenshots)
// Set OPERANT_E2E_EXE to a packaged executable to test a build instead of the dev app.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-memory-'))
const project = mkdtempSync(join(tmpdir(), 'operant-memory-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-memory-claude-'))
writeFileSync(join(project, 'app.ts'), 'export function main() { return helper() }\nfunction helper() { return 1 }\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const packaged = process.env.OPERANT_E2E_EXE

const consoleNotes = []
let app = null
let page = null
async function launch() {
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  page = await app.firstWindow()
  // Say why the window went away, so a closed-window failure names its cause (crash, quit, exit code, main-process error).
  const t0 = Date.now()
  const say = (m) => console.log(`[lifecycle +${Date.now() - t0}ms] ${m}`)
  page.on('close', () => say('page closed'))
  page.on('crash', () => say('page crashed'))
  app.process().on('exit', (code, signal) => say(`app process exited code=${code} signal=${signal}`))
  app.process().stderr?.on('data', (d) => say(`main stderr: ${String(d).trim().slice(0, 300)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleNotes.push(`console.error: ${m.text()}`)
  })
  page.on('pageerror', (e) => consoleNotes.push(`pageerror: ${e.message}`))
  page.setDefaultTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
}
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const shot = async (name) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(label, fn, timeout = 60_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`)
}
const mode = (label) => page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: label, exact: true })
const respond = (lessons) => writeFileSync(join(claudeDir, 'learn-response.json'), JSON.stringify(lessons))
const pick = async (label, option) => {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
const pickLearn = (settings) => ({ cli: settings.learn.cli, model: settings.learn.model, effort: settings.learn.effort })
const lessonRow = (id) => page.locator(`[data-lesson="${id}"]`)

const R1 = [
  { kind: 'convention', text: 'Unit tests live next to the code as .test.ts files and run with vitest.', files: ['app.ts'], symbols: [], scope: 'project', supersedes: [] },
  { kind: 'pitfall', text: 'Running vitest from a subfolder misses the root config, so test imports fail.', files: [], symbols: ['helper'], scope: 'project', supersedes: [] },
  { kind: 'correction', text: 'The user wants plain commit messages with no attribution trailer.', files: [], symbols: [], scope: 'user', supersedes: [] },
  { kind: 'procedure', text: 'To release: bump the version in package.json, run the full test suite, tag the commit, then push the tag.', files: [], symbols: [], scope: 'project', supersedes: [] },
]

const results = []
async function step(name, fn) {
  const t0 = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (e) {
    const waiting = e.message.match(/waiting for .*/)?.[0]
    results.push({ name, ok: false, error: e.message.split('\n')[0] })
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}${waiting ? ` (${waiting})` : ''}`)
    await page?.screenshot({ path: join(outDir, `fail-memory-${results.length}.png`) }).catch(() => {})
  }
}

const ids = {}
try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()

  await step('set up a project with seeded lessons, drafts and a learn run', async () => {
    respond([])
    ids.crew = (await inv('crews:create', { name: 'alpha', folder: project })).id
    const db = new DatabaseSync(join(dataDir, 'operant.db'))
    db.exec('PRAGMA busy_timeout = 5000')
    const now = Date.now()
    const addLesson = db.prepare(
      `INSERT INTO lessons (crew_id, text, kind, scope, files, symbols, source_jobs, stores, status, hits, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const l of R1) addLesson.run(ids.crew, l.text, l.kind, l.scope, JSON.stringify(l.files), JSON.stringify(l.symbols), '[]', JSON.stringify(['memory', 'codegraph']), 'active', 1, now, now)
    const addDraft = db.prepare(`INSERT INTO skill_drafts (crew_id, name, body, source_jobs, status, installed_path, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    addDraft.run(ids.crew, 'release-procedure', '---\nname: release-procedure\ndescription: How to release\n---\nBump the version, run the tests, tag, push.\n', '[]', 'pending', '', now, now)
    addDraft.run(ids.crew, 'add-ipc-channel', '---\nname: add-ipc-channel\ndescription: How to add an IPC channel\n---\nDeclare it, handle it, expose it.\n', '[]', 'pending', '', now, now)
    db.prepare(
      `INSERT INTO learn_runs (crew_id, run_id, source, at, extracted, written, merged, staled, queued, skipped, error, cli, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(ids.crew, null, 'conversation', now, 4, 4, 0, 0, 0, JSON.stringify([{ store: 'hindsight', reason: 'Hindsight is down' }]), '', 'claude', 'claude-haiku-5-5')
    for (const row of db.prepare('SELECT id, kind FROM lessons WHERE crew_id = ?').all(ids.crew)) ids[row.kind] = row.id
    db.close()
    await page.reload()
    await page.waitForFunction(() => !!window.operant)
    // The Playground stays selected after a reload, so pick the seeded project.
    await page.locator(`[data-crew-row="${ids.crew}"]`).click()
    await page.getByRole('heading', { name: 'alpha', level: 1 }).waitFor()
  })

  await step('settings: Learning section, per-store switches, review mode', async () => {
    await page.keyboard.press('Control+,')
    await page.getByRole('heading', { name: 'Settings' }).waitFor()
    await page.getByRole('button', { name: 'Learning', exact: true }).click()
    const sw = (name) => page.getByRole('switch', { name })
    await sw('Learn from finished sessions').waitFor()
    // The default holds lessons for review; the rest of this run needs them written straight away.
    assert.equal((await inv('settings:get')).learn.review, 'queue')
    await inv('settings:set', { learn: { review: 'auto' } })
    await sw('Write to CodeGraph notes').click()
    await until('codegraph off', async () => (await inv('settings:get')).learn.codegraph === false)
    await sw('Write to CodeGraph notes').click()
    await until('codegraph on', async () => (await inv('settings:get')).learn.codegraph === true)
    await sw('Learn from finished sessions').click()
    await until('master off', async () => (await inv('settings:get')).learn.enabled === false)
    assert.ok(await sw('Write to Hindsight').isDisabled(), 'store switches wait for the master switch')
    await sw('Learn from finished sessions').click()
    await until('master on', async () => (await inv('settings:get')).learn.enabled === true)
  })

  await step('settings: Learning AI, Test, OpenCode choice and the model default', async () => {
    const card = page.locator('div[data-slot="card"]').filter({ hasText: 'Learning AI' }).last()
    await card.waitFor()
    const learnNow = pickLearn(await inv('settings:get'))
    assert.equal(learnNow.cli, 'claude')
    assert.equal(learnNow.model, '', 'no model chosen: the cheap default')
    await card.getByTestId('learn-ai-resolved').getByText('claude-haiku-5-5').waitFor()
    respond([])
    await card.getByRole('button', { name: 'Test', exact: true }).click()
    await card.getByTestId('learn-ai-result').getByText(/^OK, /).waitFor()
    // OpenCode: nothing in the fake list is a cheap model, so the default says so; an own model resolves.
    await pick('Learning CLI', 'OpenCode')
    await until('opencode saved', async () => (await inv('settings:get')).learn.cli === 'opencode')
    await card.getByTestId('learn-ai-resolved').getByText(/pick one/).waitFor()
    await inv('settings:set', { learn: { model: 'provider-3/model-003-instruct' } })
    await card.getByTestId('learn-ai-resolved').getByText('provider-3/model-003-instruct').waitFor()
    assert.equal((await inv('learn:ai')).isDefault, false)
    // On Windows the fixture is a .cmd that an unshelled spawn can't start; either way the result is shown, honestly.
    await card.getByRole('button', { name: 'Test', exact: true }).click()
    await card.getByTestId('learn-ai-result').getByText(/^(OK, |Failed after )/).waitFor()
    const t = await inv('learn:test')
    assert.equal(t.cli, 'opencode')
    assert.ok(t.ok || t.error.length > 0, 'a failed test explains itself')
    await shot('learning-ai')
    await inv('settings:set', { learn: { cli: 'claude', model: '', effort: '' } })
    await card.getByTestId('learn-ai-resolved').getByText('claude-haiku-5-5').waitFor()
  })

  await step('settings: Learning AI on a local model server', async () => {
    // A fake OpenAI-compatible server: /v1/models and /v1/chat/completions.
    const seen = []
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`)
        res.setHeader('Content-Type', 'application/json')
        res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'llama-3.2-3b' }] }) : JSON.stringify({ choices: [{ message: { content: '[]' } }] }))
      })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${srv.address().port}`
      const card = page.locator('div[data-slot="card"]').filter({ hasText: 'Learning AI' }).last()
      await pick('Learning CLI', 'Local model server')
      await until('local saved', async () => (await inv('settings:get')).learn.cli === 'local')
      await card.getByLabel('Local server endpoint').fill(url)
      await card.getByLabel('Local server endpoint').press('Enter')
      await until('url saved', async () => (await inv('settings:get')).learn.localUrl === url)
      await card.getByText(/small local models may extract poor lessons/i).waitFor()
      await card.getByTestId('learn-ai-resolved').getByText('qwen2.5-7b-instruct').waitFor()
      await pick('Learning model', 'llama-3.2-3b')
      await until('model saved', async () => (await inv('settings:get')).learn.model === 'llama-3.2-3b')
      await card.getByRole('button', { name: 'Test', exact: true }).click()
      await card.getByTestId('learn-ai-result').getByText(/^OK, /).waitFor()
      assert.ok(seen.includes('POST /v1/chat/completions'), 'the test called the chat endpoint')
      // A plain-http host outside the LAN is refused until confirmed.
      await inv('settings:set', { learn: { localUrl: 'http://example.com:1234' } })
      assert.match((await inv('learn:ai')).error, /unencrypted/)
      await shot('learning-ai-local')
    } finally {
      await new Promise((r) => srv.close(r))
      await inv('settings:set', { learn: { cli: 'claude', model: '', effort: '', localUrl: 'http://127.0.0.1:1234' } })
    }
  })

  await step('settings: Hindsight section, remote URL is validated and saved, the key is write-only', async () => {
    await page.locator('main nav button', { hasText: /^Memory$/ }).click()
    await page.getByRole('heading', { name: 'Hindsight', exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole('radio', { name: /Remote/ }).click()
    await until('remote mode', async () => (await inv('settings:get')).hindsight.mode === 'remote')
    const field = page.getByLabel('Hindsight URL')
    await field.fill('ftp://nas:9077')
    await field.press('Enter')
    await page.getByRole('alert').filter({ hasText: 'http:// or https://' }).waitFor()
    assert.equal((await inv('settings:get')).hindsightUrl, '')
    await field.fill('http://127.0.0.1:9')
    await field.press('Enter')
    await until('url saved', async () => (await inv('settings:get')).hindsightUrl === 'http://127.0.0.1:9')
    assert.equal(await page.getByRole('alert').filter({ hasText: 'http:// or https://' }).count(), 0)
    await page.getByLabel('Hindsight API key').fill('test-key-12345')
    await page.getByRole('button', { name: 'Save key' }).click()
    await page.getByText('Key saved', { exact: true }).waitFor()
    assert.deepEqual(await inv('hindsight:keyState'), { shared: false, remote: true })
    assert.ok(!JSON.stringify(await inv('settings:get')).includes('test-key-12345'), 'the key is not in settings')
    await page.getByRole('button', { name: 'Test connection' }).click()
    await page.getByRole('status', { name: 'Test result' }).waitFor()
    await shot('settings-hindsight-remote')
    await inv('hindsight:clearKey', 'remote')
  })

  await step('Memory page lists the lessons with filters and search', async () => {
    await page.keyboard.press('Control+,')
    await mode('Terminal').waitFor()
    await mode('Memory').click()
    await page.getByRole('heading', { name: 'Memory', level: 2 }).waitFor()
    await lessonRow(ids.convention).waitFor()
    assert.equal(await page.locator('[data-lesson]').count(), 4)
    await page.getByLabel('Search memory').fill('vitest')
    await until('search narrows', async () => (await page.locator('[data-lesson]').count()) === 2)
    await page.getByLabel('Search memory').fill('')
    await pick('Kind', 'Pitfall')
    await until('kind narrows', async () => (await page.locator('[data-lesson]').count()) === 1)
    await pick('Kind', 'Any kind')
    await pick('Status', 'Stale')
    await page.getByText('No lessons match').waitFor()
    await pick('Status', 'Any status')
    await until('all back', async () => (await page.locator('[data-lesson]').count()) === 4)
    await page.setViewportSize({ width: 1440, height: 1500 })
    await shot('memory-manager')
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  await step('learning status panel: stores, last run, totals', async () => {
    const panel = page.getByRole('region', { name: 'Learning status' })
    await panel.getByLabel('Learning stores').waitFor()
    const hs = panel.locator('[data-store="hindsight"]')
    await hs.getByText('Down').waitFor()
    await panel.locator('[data-store="memory"]').getByText('Up').waitFor()
    const last = panel.getByRole('group', { name: 'Last learn run' })
    await last.getByText(/Hindsight skipped/).waitFor()
    await panel.getByRole('group', { name: 'Learning totals' }).getByText('4 active').waitFor()
  })

  await step('edit a lesson', async () => {
    await lessonRow(ids.convention).getByRole('button', { name: `Edit lesson ${ids.convention}` }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Lesson text').fill('Unit tests sit beside the source as .test.ts files and run with vitest.')
    await dialog.getByRole('button', { name: 'Save lesson' }).click()
    await dialog.waitFor({ state: 'detached' })
    await lessonRow(ids.convention).getByText(/sit beside the source/).waitFor()
    assert.match((await inv('learn:lessons', { crewId: ids.crew })).find((l) => l.id === ids.convention).text, /sit beside/)
  })

  await step('merge duplicate lessons', async () => {
    await lessonRow(ids.convention).getByLabel(`Select lesson ${ids.convention}`).check()
    await lessonRow(ids.pitfall).getByLabel(`Select lesson ${ids.pitfall}`).check()
    await page.getByRole('button', { name: 'Merge selected (2)' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(`Keep lesson ${ids.convention}`).check()
    await dialog.getByRole('button', { name: 'Merge lessons' }).click()
    await dialog.waitFor({ state: 'detached' })
    await until('merged', async () => (await page.locator('[data-lesson]').count()) === 3)
    const kept = (await inv('learn:lessons', { crewId: ids.crew })).find((l) => l.id === ids.convention)
    assert.ok(kept.symbols.includes('helper'), 'the merged lesson carries the other one\'s symbols')
    assert.equal((await inv('learn:lessons', { crewId: ids.crew, status: 'deleted' })).length, 1)
  })

  await step('mark stale, mark active again', async () => {
    await lessonRow(ids.correction).getByRole('button', { name: `Mark lesson ${ids.correction} stale` }).click()
    await lessonRow(ids.correction).getByText('Stale', { exact: true }).waitFor()
    await lessonRow(ids.correction).getByRole('button', { name: `Mark lesson ${ids.correction} active again` }).click()
    await lessonRow(ids.correction).getByText('Active', { exact: true }).waitFor()
  })

  await step('move to a store that is down shows the error', async () => {
    await lessonRow(ids.correction).getByRole('combobox', { name: `Move lesson ${ids.correction} to another store` }).click()
    await page.getByRole('option', { name: 'Hindsight', exact: true }).click()
    await lessonRow(ids.correction).getByRole('alert').waitFor()
    assert.ok(!(await inv('learn:lessons', { crewId: ids.crew })).find((l) => l.id === ids.correction).stores.includes('hindsight'))
  })

  await step('delete asks first, then removes', async () => {
    await lessonRow(ids.correction).getByRole('button', { name: `Delete lesson ${ids.correction}` }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText(/removed from every memory store/).waitFor()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    assert.equal((await inv('learn:lessons', { crewId: ids.crew, status: 'deleted' })).length, 1, 'cancel deletes nothing')
    await lessonRow(ids.correction).getByRole('button', { name: `Delete lesson ${ids.correction}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete lesson' }).click()
    await lessonRow(ids.correction).waitFor({ state: 'detached' })
    assert.equal((await inv('learn:lessons', { crewId: ids.crew, status: 'deleted' })).length, 2)
  })

  await step('personal memory, CodeGraph notes and Hindsight tabs', async () => {
    await page.getByRole('tab', { name: 'Personal memory' }).click()
    const files = page.getByRole('list', { name: 'Personal memory files' })
    await files.waitFor()
    await page.getByRole('tab', { name: 'CodeGraph notes' }).click()
    await page.getByText('CodeGraph has no notes API').waitFor()
    await page.locator('[data-lesson]').first().waitFor()
    await page.getByRole('tab', { name: 'Hindsight' }).click()
    await page.getByText(/cannot be edited or deleted from here/).waitFor()
    await page.getByRole('alert').filter({ hasText: 'Hindsight did not answer' }).waitFor()
    await page.getByRole('tab', { name: /^Lessons/ }).click()
  })

  await step('skill draft: listed, not installed until approved, then installed', async () => {
    await page.getByRole('tab', { name: /^Skill drafts/ }).click()
    const list = page.getByRole('list', { name: 'Skill drafts' })
    await list.waitFor()
    const drafts = await inv('learn:drafts', ids.crew, 'pending')
    assert.equal(drafts.length, 2)
    const d = drafts.find((x) => x.name === 'release-procedure')
    const target = join(project, '.claude', 'skills', d.name, 'SKILL.md')
    assert.ok(!existsSync(target), 'nothing is installed before approval')
    await list.getByRole('button', { name: `Edit skill draft ${d.id}` }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('SKILL.md').fill(`${d.body}\nAlways run the tests before tagging.\n`)
    await dialog.getByRole('button', { name: 'Save draft' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.ok(!existsSync(target), 'saving an edit does not install')
    await list.getByRole('button', { name: `Approve skill draft ${d.id}` }).click()
    await until('installed', () => existsSync(target))
    await list.getByText(/Installed at/).waitFor()
  })

  await step('skill draft: reject and delete', async () => {
    const pending = (await inv('learn:drafts', ids.crew, 'pending'))[0]
    assert.ok(pending, 'a second draft is pending')
    const list = page.getByRole('list', { name: 'Skill drafts' })
    await list.getByRole('button', { name: `Reject skill draft ${pending.id}` }).click()
    await until('rejected', async () => (await inv('learn:drafts', ids.crew, 'rejected')).length === 1)
    await list.getByRole('button', { name: `Delete skill draft ${pending.id}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete draft' }).click()
    await until('deleted', async () => (await inv('learn:drafts', ids.crew, 'rejected')).length === 0)
  })

  await step('per-store switch in the panel is saved', async () => {
    const panel = page.getByRole('region', { name: 'Learning status' })
    await panel.getByRole('switch', { name: 'Personal memory on or off' }).click()
    await until('memory off', async () => (await inv('settings:get')).learn.memory === false)
    await panel.locator('[data-store="memory"]').getByText('Off', { exact: true }).waitFor()
    await panel.getByRole('switch', { name: 'Personal memory on or off' }).click()
    await until('memory on', async () => (await inv('settings:get')).learn.memory === true)
    await shot('learning-status')
  })

  await step('header badge shows learning health and opens the Memory page', async () => {
    await mode('Terminal').click()
    const badge = page.getByRole('button', { name: /^Learning health:/ })
    await badge.waitFor()
    assert.match((await badge.getAttribute('aria-label')) ?? '', /Hindsight is down/)
    await badge.click()
    await page.getByRole('heading', { name: 'Memory', level: 2 }).waitFor()
  })

  assert.deepEqual(consoleNotes, [], 'no console errors')
} catch (e) {
  results.push({ name: 'fatal', ok: false, error: e.message })
  console.log(`FAIL fatal: ${e.message}`)
  await page?.screenshot({ path: join(outDir, 'fail-memory.png') }).catch(() => {})
} finally {
  await app?.close().catch(() => {})
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length ? 1 : 0)
