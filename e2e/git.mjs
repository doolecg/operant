// Git page e2e: a temp repository (never a real one) is changed, staged (whole files and one hunk), diffed (unified and
// side by side), committed, listed in the history, branched, switched and discarded through the page. Nothing is
// pushed. Runs in the background with throwaway data and takes the screenshots for the spec.
// Usage: node e2e/git.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-git-data-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-git-claude-'))
const root = mkdtempSync(join(tmpdir(), 'operant-git-repo-'))
const repo = join(root, 'shop')
mkdirSync(repo)
const sh = (...a) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true })
const lines = Array.from({ length: 40 }, (_, i) => `const value${i + 1} = ${i + 1}`)
sh('init', '-q', '-b', 'main')
sh('config', 'core.autocrlf', 'false')
writeFileSync(join(repo, 'app.ts'), lines.join('\n') + '\n')
writeFileSync(join(repo, 'gone.txt'), 'to be deleted\n')
writeFileSync(join(repo, 'notes.md'), '# Notes\n')
sh('add', '.')
sh('commit', '-q', '-m', 'Initial commit')
// Two separate hunks in app.ts, a deleted file, a new file with a space and unicode in its name.
lines[1] = 'const value2 = "changed near the top"'
lines[36] = 'const value37 = "changed near the end"'
writeFileSync(join(repo, 'app.ts'), lines.join('\n') + '\n')
rmSync(join(repo, 'gone.txt'))
writeFileSync(join(repo, 'dé mo.txt'), 'first line\nsecond line\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const packaged = process.env.OPERANT_E2E_EXE
let app = null
try {
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()
  await page.evaluate((folder) => window.operant.invoke('crews:create', { name: 'shop', folder }), repo)
  await page.locator('[data-crew-row]').getByText('shop', { exact: true }).click({ position: { x: 4, y: 4 } })

  // The chip shows the branch; clicking it opens the Git tab.
  const chip = page.getByRole('button', { name: /^Git: Branch main, 3 changed files/ })
  await chip.waitFor()
  await chip.click()
  const git = page.getByTestId('git-page')
  await git.waitFor()
  const files = page.getByTestId('git-files')
  const pick = (name, side) => files.locator(`[data-file-row="${name}"]${side ? `[data-side="${side}"]` : ''} button`).first()
  const refresh = () => git.getByRole('button', { name: 'Refresh' }).click()
  await files.getByText('app.ts').waitFor()
  await files.getByText('dé mo.txt').waitFor()
  await files.getByText('gone.txt').waitFor()
  assert.equal(await files.getByRole('region', { name: 'Untracked' }).count(), 1)
  assert.equal(await files.getByRole('region', { name: 'Changes' }).locator('li').count(), 2, 'app.ts and gone.txt are unstaged changes')
  const commitBtn = git.getByRole('form', { name: 'Commit' }).getByRole('button', { name: /^Commit/ })
  assert.ok(await commitBtn.isDisabled(), 'Commit is disabled with nothing staged and no message')

  // Expand to the full workspace area; the same view, wider.
  await git.getByRole('button', { name: 'Widen the Git panel' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(outDir, 'git-page.png') })

  // Diff of app.ts: both hunks, line numbers, added and removed lines; side by side shows the pair.
  await pick('app.ts').click()
  const body = page.getByTestId('diff-body')
  await body.getByText('changed near the top').waitFor()
  await body.getByText('changed near the end').waitFor()
  assert.equal(await body.getByRole('button', { name: /^(Collapse|Expand) @@/ }).count(), 2)
  await page.getByRole('button', { name: 'Side by side' }).click()
  await body.getByText('changed near the top').waitFor()
  await page.getByRole('button', { name: 'Next change' }).click()
  await page.screenshot({ path: join(outDir, 'git-diff.png') })
  await page.getByRole('button', { name: 'Unified' }).click()

  // A collapsed hunk hides its lines.
  await body.getByRole('button', { name: /^Collapse @@ -1,/ }).click()
  await page.waitForTimeout(100)
  assert.equal(await body.getByText('changed near the top').count(), 0)
  await body.getByRole('button', { name: /^Expand @@ -1,/ }).click()
  await body.getByText('changed near the top').waitFor()

  // Stage the second hunk only: git sees one hunk staged and one not.
  await body.getByRole('button', { name: 'Stage hunk' }).nth(1).click()
  await files.getByRole('region', { name: 'Staged' }).getByText('app.ts').waitFor()
  assert.match(sh('diff', '--cached'), /changed near the end/)
  assert.doesNotMatch(sh('diff', '--cached'), /changed near the top/)
  assert.match(sh('diff'), /changed near the top/)
  // Stage everything else with the checkboxes.
  await files.getByRole('checkbox', { name: 'Stage app.ts', exact: true }).click()
  await files.getByRole('checkbox', { name: 'Stage gone.txt', exact: true }).click()
  await files.getByRole('checkbox', { name: 'Stage dé mo.txt', exact: true }).click()
  await files.getByRole('region', { name: 'Staged' }).getByText('dé mo.txt').waitFor()
  assert.equal(sh('status', '--porcelain').split('\n').filter((l) => l && !/^[AMD] /.test(l)).length, 0, 'everything is staged')
  // The new file's diff reads as added lines.
  await pick('dé mo.txt', 'staged').click()
  await body.getByText('second line').waitFor()

  // Commit: the subject and the body are written as typed, with nothing added.
  const form = git.getByRole('form', { name: 'Commit' })
  await form.getByRole('button', { name: /^Commit 3 files$/ }).waitFor()
  assert.ok(await form.getByRole('button', { name: /^Commit/ }).isDisabled(), 'no message yet')
  await form.getByLabel('Commit message').fill('Change app, drop gone.txt, add a demo\n\nThe body explains why.')
  await form.getByRole('button', { name: /^Commit 3 files$/ }).click()
  const notice = page.getByTestId('git-notice')
  await notice.getByText(/Commit/).first().waitFor()
  await notice.getByText(/Committed [0-9a-f]{7,}/).waitFor()
  await page.getByText('No changes since the last commit.').waitFor()
  await page.screenshot({ path: join(outDir, 'git-commit.png') })
  assert.equal(sh('log', '-1', '--format=%B').trim(), 'Change app, drop gone.txt, add a demo\n\nThe body explains why.')
  assert.equal(sh('status', '--porcelain').trim(), '')
  await page.getByText('No changes since the last commit.').waitFor()

  // A hook that refuses shows its words and keeps the message.
  writeFileSync(join(repo, 'notes.md'), '# Notes\nmore\n')
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint says no" >&2\nexit 1\n', { mode: 0o755 })
  await refresh()
  await files.getByRole('checkbox', { name: 'Stage notes.md', exact: true }).click()
  await form.getByLabel('Commit message').fill('Should be blocked')
  await form.getByRole('button', { name: /^Commit 1 file$/ }).click()
  await notice.getByText(/lint says no/).waitFor()
  assert.equal(await form.getByLabel('Commit message').inputValue(), 'Should be blocked')
  rmSync(join(repo, '.git', 'hooks', 'pre-commit'))
  await form.getByRole('button', { name: /^Commit 1 file$/ }).click()
  await notice.getByText(/Committed/).waitFor()

  // Amend: the last message comes in, and the commit is replaced.
  const before = sh('rev-parse', 'HEAD')
  await form.getByLabel('Amend last commit').check()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Commit message"]')?.value === 'Should be blocked')
  await form.getByLabel('Commit message').fill('Update notes')
  await form.getByRole('button', { name: 'Amend commit' }).click()
  await notice.getByText(/Amended/).waitFor()
  assert.notEqual(sh('rev-parse', 'HEAD'), before)
  assert.equal(sh('log', '-1', '--format=%s').trim(), 'Update notes')

  // History: the commits, a click shows the message, its files and the file's diff.
  await git.getByRole('tab', { name: 'History' }).click()
  const log = page.getByTestId('git-log')
  await log.getByText('Initial commit').waitFor()
  await log.getByText('Update notes').waitFor()
  assert.equal(await log.locator('li').count(), 3)
  await log.getByRole('button', { name: /Change app, drop gone\.txt/ }).click()
  const details = page.getByTestId('git-commit-details')
  await details.getByText('The body explains why.').waitFor()
  await details.getByRole('button', { name: /gone\.txt/ }).click()
  await page.getByTestId('diff-body').getByText('to be deleted').waitFor()
  await page.getByRole('button', { name: 'Open in IDE' }).waitFor()

  // Branches: create from the page, then switch back; a clashing switch is refused with the reason.
  await git.getByRole('button', { name: /^Branch main/ }).click()
  await page.getByRole('menuitem', { name: 'New branch…' }).click()
  await git.getByLabel('New branch name').fill('feature/e2e')
  await git.getByRole('button', { name: 'Create and switch' }).click()
  await git.getByRole('button', { name: /^Branch feature\/e2e/ }).waitFor()
  assert.equal(sh('branch', '--show-current').trim(), 'feature/e2e')
  await page.getByRole('button', { name: /^Git: Branch feature\/e2e/ }).waitFor()
  await git.getByRole('tab', { name: /^Changes/ }).click()
  writeFileSync(join(repo, 'app.ts'), 'feature version\n')
  sh('commit', '-qam', 'feature change')
  await refresh()
  await git.getByRole('button', { name: /^Branch feature\/e2e/ }).click()
  await page.getByRole('menuitem', { name: /main/ }).click()
  await git.getByRole('button', { name: /^Branch main/ }).waitFor()
  writeFileSync(join(repo, 'app.ts'), 'dirty on main\n')
  await refresh()
  await files.locator('[data-file-row="app.ts"]').waitFor()
  await git.getByRole('button', { name: /^Branch main/ }).click()
  await page.getByRole('menuitem', { name: /feature\/e2e/ }).click()
  await notice.getByText(/Commit, stash or discard/).waitFor()
  assert.equal(sh('branch', '--show-current').trim(), 'main')

  // Discard asks first; cancelling keeps the file, confirming restores it. A new file is deleted.
  writeFileSync(join(repo, 'extra.txt'), 'scratch\n')
  await refresh()
  await files.locator('[data-file-row="extra.txt"]').waitFor()
  await files.getByRole('button', { name: 'Discard changes to app.ts' }).click({ force: true })
  const confirm = page.getByTestId('git-confirm')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  assert.ok(existsSync(join(repo, 'app.ts')))
  assert.match(sh('diff', '--stat'), /app\.ts/)
  await files.getByRole('button', { name: 'Discard changes to app.ts' }).click({ force: true })
  await confirm.getByRole('button', { name: 'Discard' }).click()
  await page.waitForFunction(() => !document.querySelector('[data-file-row="app.ts"]'))
  assert.equal(sh('diff', '--stat').trim(), '')
  await files.getByRole('button', { name: 'Discard changes to extra.txt' }).click({ force: true })
  await confirm.getByText(/deletes it/).waitFor()
  await confirm.getByRole('button', { name: 'Discard' }).click()
  await page.waitForFunction(() => !document.querySelector('[data-file-row="extra.txt"]'))
  assert.equal(existsSync(join(repo, 'extra.txt')), false)

  // Push with no remote: it asks, then says why it cannot (nothing leaves the machine).
  await git.getByRole('button', { name: /^Push/ }).click()
  await confirm.getByRole('button', { name: 'Push' }).click()
  await notice.getByText(/no remote named origin/i).waitFor()

  console.log('git e2e ok')
} finally {
  await app?.close().catch(() => undefined)
  for (const d of [dataDir, claudeDir, root]) rmSync(d, { recursive: true, force: true })
}
