import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  diffArgs,
  findRepo,
  gitArgs,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCommitDetails,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitLastMessage,
  gitLog,
  gitStage,
  gitStageHunk,
  gitStatus,
  gitUnstage,
  hunkPatch,
  normalizeMessage,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseStatus,
  safeRepoPath,
  splitDiff,
} from './git'

const NUL = '\0'

describe('parseStatus', () => {
  it('reads the branch, upstream and ahead/behind', () => {
    const s = parseStatus(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', ''].join(NUL))
    expect(s).toMatchObject({ branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1, files: [] })
  })

  it('reports no upstream as null with zero counts', () => {
    const s = parseStatus(['# branch.oid abc', '# branch.head topic', ''].join(NUL))
    expect(s).toMatchObject({ upstream: null, ahead: 0, behind: 0 })
  })

  it('shows a detached HEAD by its short id', () => {
    const s = parseStatus(['# branch.oid 1234567890abcdef', '# branch.head (detached)', ''].join(NUL))
    expect(s).toMatchObject({ branch: '1234567', detached: true })
  })

  it('reads an unborn branch', () => {
    const s = parseStatus(['# branch.oid (initial)', '# branch.head main', '? a.txt', ''].join(NUL))
    expect(s.branch).toBe('main')
    expect(s.files).toEqual([{ path: 'a.txt', x: '.', y: '.', untracked: true, conflicted: false }])
  })

  it('reads ordinary, renamed, untracked and conflicted entries with spaces and unicode', () => {
    const h = 'N... 100644 100644 100644 1111111 2222222'
    const out = [
      '# branch.head main',
      `1 M. ${h} src/with space/héllo wörld.ts`,
      `1 .M ${h} 日本語.txt`,
      `2 R. N... 100644 100644 100644 1111111 2222222 R100 new name.txt`,
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 1 2 3 both changed.txt',
      '? new file.txt',
      '! ignored.log',
      '',
    ].join(NUL)
    const files = parseStatus(out).files
    expect(files).toEqual([
      { path: 'src/with space/héllo wörld.ts', x: 'M', y: '.', untracked: false, conflicted: false },
      { path: '日本語.txt', x: '.', y: 'M', untracked: false, conflicted: false },
      { path: 'new name.txt', orig: 'old name.txt', x: 'R', y: '.', untracked: false, conflicted: false },
      { path: 'both changed.txt', x: 'U', y: 'U', untracked: false, conflicted: true },
      { path: 'new file.txt', x: '.', y: '.', untracked: true, conflicted: false },
    ])
  })
})

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 111..222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -10,2 +10,3 @@ fn',
  ' ten',
  '+ten and a half',
  ' eleven',
  '\\ No newline at end of file',
  '',
].join('\n')

describe('parseDiff', () => {
  it('numbers lines and counts changes', () => {
    const d = parseDiff(DIFF, 'a.txt')
    expect(d).toMatchObject({ additions: 2, deletions: 1, binary: false, isNew: false })
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks[0]!.lines).toEqual([
      { type: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'two', oldNo: 2 },
      { type: 'add', text: 'TWO', newNo: 2 },
      { type: 'ctx', text: 'three', oldNo: 3, newNo: 3 },
    ])
    expect(d.hunks[1]).toMatchObject({ header: '@@ -10,2 +10,3 @@ fn', oldStart: 10, newStart: 10 })
    expect(d.hunks[1]!.lines).toHaveLength(3)
  })

  it('knows renames, new files, deleted files and binaries', () => {
    expect(parseDiff('diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n@@ -1 +1 @@\n-a\n+b\n', 'y').renamedFrom).toBe('x')
    expect(parseDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+a\n', 'n').isNew).toBe(true)
    expect(parseDiff('diff --git a/n b/n\ndeleted file mode 100644\n--- a/n\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n', 'n').isDeleted).toBe(true)
    expect(parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n', 'i.png').binary).toBe(true)
  })

  it('picks the section of the asked path when git printed several', () => {
    const text = 'diff --git a/old b/old\ndeleted file mode 100644\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+x\n'
    expect(parseDiff(text, 'new').isNew).toBe(true)
  })

  it('caps the lines and the length of a line', () => {
    const body = Array.from({ length: 6000 }, (_, i) => `+line ${i}`).join('\n')
    const d = parseDiff(`diff --git a/b b/b\n@@ -0,0 +1,6000 @@\n${body}\n`, 'b')
    expect(d.hunks[0]!.lines).toHaveLength(5000)
    expect(d.note).toMatch(/first 5000/)
    const long = parseDiff(`diff --git a/b b/b\n@@ -0,0 +1 @@\n+${'x'.repeat(5000)}\n`, 'b')
    expect(long.hunks[0]!.lines[0]!.text.length).toBe(2001)
  })

  it('builds a patch for one hunk and refuses a changed header', () => {
    const patch = hunkPatch(DIFF, { index: 1, header: '@@ -10,2 +10,3 @@ fn' })!
    expect(patch).toBe('diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -10,2 +10,3 @@ fn\n ten\n+ten and a half\n eleven\n\\ No newline at end of file\n')
    expect(hunkPatch(DIFF, { index: 1, header: '@@ -9,2 +9,3 @@' })).toBeNull()
    expect(hunkPatch(DIFF, { index: 5, header: '@@' })).toBeNull()
    expect(splitDiff(DIFF).hunks).toHaveLength(2)
  })
})

describe('parseLog and parseNameStatus', () => {
  it('reads commits with refs and bodies', () => {
    const rec = (h: string, subject: string, refs: string, body: string) => ['H' + h, h, 'Ann', '2026-01-02T03:04:05+00:00', subject, refs, body].join('\x1f') + '\x1e'
    const list = parseLog(`${rec('aaa', 'first | subject', 'HEAD -> main, tag: v1', 'body\nmore')}\n${rec('bbb', 'second', '', '')}`)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ hash: 'Haaa', short: 'aaa', author: 'Ann', subject: 'first | subject', refs: ['HEAD -> main', 'tag: v1'], body: 'body\nmore' })
    expect(list[1]!.refs).toEqual([])
  })

  it('reads name-status with renames', () => {
    expect(parseNameStatus(['M', 'a b.txt', 'R100', 'old.txt', 'new.txt', 'A', 'c.txt', ''].join(NUL))).toEqual([
      { status: 'M', path: 'a b.txt' },
      { status: 'R', orig: 'old.txt', path: 'new.txt' },
      { status: 'A', path: 'c.txt' },
    ])
  })
})

describe('command construction', () => {
  const repo = { root: process.platform === 'win32' ? 'C:\\r' : '/r', prefix: '' }

  it('keeps paths after "--" and never builds a shell string', () => {
    const args = diffArgs({ side: 'unstaged' }, ['--help', 'a; b', '-x'])
    expect(args.slice(args.indexOf('--'))).toEqual(['--', '--help', 'a; b', '-x'])
    expect(diffArgs({ side: 'commit', commit: 'abc123' }, ['f']).slice(0, 2)).toEqual(['show', '--format='])
    expect(gitArgs(['status'])).toEqual(['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false', 'status'])
  })

  it('refuses paths outside the project', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'C:\\x', '', '.git/config', 'a\0b', 'a//b']) expect(() => safeRepoPath(repo, bad)).toThrow()
    expect(() => safeRepoPath(repo, 42)).toThrow()
    expect(safeRepoPath(repo, 'a\\b c.txt')).toBe('a/b c.txt')
    expect(safeRepoPath(repo, '--help')).toBe('--help')
    expect(() => safeRepoPath({ ...repo, prefix: 'sub/' }, 'other/x')).toThrow()
    expect(safeRepoPath({ ...repo, prefix: 'sub/' }, 'sub/x')).toBe('sub/x')
  })

  it('checks commit messages and adds nothing to them', () => {
    expect(() => normalizeMessage('   ')).toThrow()
    expect(() => normalizeMessage(5)).toThrow()
    expect(normalizeMessage('subject\r\n\r\nbody  \n\n')).toBe('subject\n\nbody\n')
  })
})

describe('against a real repository', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'operant-gitsvc-'))
  const repo = join(root, 'repo')
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, windowsHide: true, encoding: 'utf8' })
  const write = (name: string, text: string) => {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), text)
  }
  const saved: Record<string, string | undefined> = {}

  beforeAll(() => {
    for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') })) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
    mkdirSync(repo)
    sh('init', '-q')
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('is not a repository outside one', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'operant-nogit2-'))
    try {
      expect(await gitStatus(plain)).toBeNull()
      expect(await findRepo(plain)).toBeNull()
      await expect(gitLog(plain)).rejects.toThrow(/not a git repository/)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('handles an empty repository, then a first commit', async () => {
    expect(await gitLog(repo)).toEqual([])
    expect(await gitLastMessage(repo)).toBe('')
    write('a.txt', 'one\ntwo\nthree\n')
    write('--help', 'tricky\n')
    write('semi; colon.txt', 'x\n')
    write('sub/deep file.txt', 'deep\n')
    const st = await gitStatus(repo)
    expect(st!.branch).toBe('main')
    expect(st!.files.map((f) => f.path).sort()).toEqual(['--help', 'a.txt', 'semi; colon.txt', 'sub/deep file.txt'])
    expect(st!.files.every((f) => f.untracked)).toBe(true)
    await expect(gitCommit(repo, 'nothing staged', false)).rejects.toThrow(/Nothing is staged/)
    expect((await gitStage(repo, ['--help', 'semi; colon.txt', 'a.txt', 'sub/deep file.txt'])).ok).toBe(true)
    expect((await gitStatus(repo))!.files.every((f) => f.x === 'A')).toBe(true)
    expect((await gitUnstage(repo, ['--help'])).ok).toBe(true)
    expect((await gitStatus(repo))!.files.find((f) => f.path === '--help')!.untracked).toBe(true)
    const r = await gitCommit(repo, 'First commit\n\nwith a body', false)
    expect(r.ok).toBe(true)
    expect(r.hash).toMatch(/^[0-9a-f]{7,}$/)
    const log = await gitLog(repo)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ subject: 'First commit', author: 'Tester', body: 'with a body' })
    expect(sh('log', '-1', '--format=%B').trim()).toBe('First commit\n\nwith a body')
  })

  it('shows unstaged, staged and untracked diffs', async () => {
    write('a.txt', 'one\nTWO\nthree\nfour\n')
    let d = await gitDiff(repo, { path: 'a.txt', side: 'unstaged' })
    expect(d).toMatchObject({ additions: 2, deletions: 1 })
    expect((await gitDiff(repo, { path: 'a.txt', side: 'staged' })).hunks).toEqual([])
    await gitStage(repo, ['a.txt'])
    d = await gitDiff(repo, { path: 'a.txt', side: 'staged' })
    expect(d.additions).toBe(2)
    const u = await gitDiff(repo, { path: '--help', side: 'untracked' })
    expect(u).toMatchObject({ isNew: true, additions: 1 })
    expect(u.hunks[0]!.lines[0]).toEqual({ type: 'add', text: 'tricky', newNo: 1 })
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 0, 2, 0]))
    expect((await gitDiff(repo, { path: 'bin.dat', side: 'untracked' })).binary).toBe(true)
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(1_200_000))
    expect((await gitDiff(repo, { path: 'big.txt', side: 'untracked' })).note).toMatch(/too large/)
    await expect(gitDiff(repo, { path: '../outside', side: 'unstaged' })).rejects.toThrow()
    await expect(gitDiff(repo, { path: 'a.txt', side: 'commit', commit: '--output=x' })).rejects.toThrow(/commit id/)
    rmSync(join(repo, 'bin.dat'))
    rmSync(join(repo, 'big.txt'))
    await gitStage(repo, ['--help'])
    await gitCommit(repo, 'Second', false)
  })

  it('stages and unstages single hunks', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    write('h.txt', lines.join('\n') + '\n')
    await gitStage(repo, ['h.txt'])
    await gitCommit(repo, 'h', false)
    lines[1] = 'CHANGED 2'
    lines[35] = 'CHANGED 36'
    write('h.txt', lines.join('\n') + '\n')
    const d = await gitDiff(repo, { path: 'h.txt', side: 'unstaged' })
    expect(d.hunks).toHaveLength(2)
    const second = { path: 'h.txt', index: 1, header: d.hunks[1]!.header }
    expect((await gitStageHunk(repo, second, true)).ok).toBe(true)
    const staged = await gitDiff(repo, { path: 'h.txt', side: 'staged' })
    expect(staged.hunks).toHaveLength(1)
    expect(staged.hunks[0]!.lines.some((l) => l.text === 'CHANGED 36')).toBe(true)
    expect((await gitDiff(repo, { path: 'h.txt', side: 'unstaged' })).hunks).toHaveLength(1)
    expect((await gitStageHunk(repo, { path: 'h.txt', index: 0, header: staged.hunks[0]!.header }, false)).ok).toBe(true)
    expect((await gitDiff(repo, { path: 'h.txt', side: 'staged' })).hunks).toHaveLength(0)
    await expect(gitStageHunk(repo, { path: 'h.txt', index: 0, header: '@@ -1 +1 @@' }, true)).rejects.toThrow(/changed since/)
    await gitDiscard(repo, ['h.txt'])
  })

  it('amends, and honours a failing hook', async () => {
    write('c.txt', 'c\n')
    await gitStage(repo, ['c.txt'])
    const hooks = join(repo, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
    const bad = await gitCommit(repo, 'blocked', false)
    expect(bad.ok).toBe(false)
    expect(bad.output).toMatch(/hook says no/)
    rmSync(join(hooks, 'pre-commit'))
    expect((await gitCommit(repo, 'Third', false)).ok).toBe(true)
    expect(await gitLastMessage(repo)).toBe('Third')
    expect((await gitCommit(repo, 'Third, reworded', true)).ok).toBe(true)
    expect((await gitLog(repo)).map((c) => c.subject).slice(0, 2)).toEqual(['Third, reworded', 'h'])
  })

  it('discards tracked changes and an untracked file by its name only', async () => {
    write('a.txt', 'changed\n')
    write('junk.txt', 'junk\n')
    write('keep.txt', 'keep\n')
    await expect(gitDiscard(repo, ['nothing.txt'])).rejects.toThrow(/no changes to discard/)
    expect((await gitDiscard(repo, ['a.txt', 'junk.txt'])).ok).toBe(true)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n')
    expect(existsSync(join(repo, 'junk.txt'))).toBe(false)
    expect(existsSync(join(repo, 'keep.txt'))).toBe(true)
    await gitStage(repo, ['keep.txt'])
    expect((await gitDiscard(repo, ['keep.txt'])).ok).toBe(true)
    expect(existsSync(join(repo, 'keep.txt'))).toBe(false)
    expect((await gitStatus(repo))!.files).toEqual([])
  })

  it('detects a rename and shows commit details', async () => {
    sh('mv', 'c.txt', 'renamed c.txt')
    await gitStage(repo, ['renamed c.txt', 'c.txt'])
    const st = await gitStatus(repo)
    const f = st!.files.find((x) => x.path === 'renamed c.txt')!
    expect(f).toMatchObject({ x: 'R', orig: 'c.txt' })
    const d = await gitDiff(repo, { path: 'renamed c.txt', orig: 'c.txt', side: 'staged' })
    expect(d.renamedFrom).toBe('c.txt')
    expect((await gitUnstage(repo, ['renamed c.txt'])).ok).toBe(true)
    expect((await gitStatus(repo))!.files.map((x) => `${x.x}${x.y}${x.path}`).sort()).toEqual(['..renamed c.txt', '.Dc.txt'].sort())
    await gitDiscard(repo, ['renamed c.txt'])
    await gitDiscard(repo, ['c.txt'])
    const log = await gitLog(repo)
    const details = await gitCommitDetails(repo, log[0]!.hash)
    expect(details.files).toEqual([{ status: 'A', path: 'c.txt' }])
    const cd = await gitDiff(repo, { path: 'c.txt', side: 'commit', commit: log[0]!.hash })
    expect(cd.isNew).toBe(true)
    await expect(gitCommitDetails(repo, 'nope; rm')).rejects.toThrow(/commit id/)
  })

  it('lists, creates and switches branches, and refuses a clashing switch', async () => {
    expect((await gitBranches(repo)).current).toBe('main')
    await expect(gitCreateBranch(repo, '--force')).rejects.toThrow(/not a valid/)
    await expect(gitCreateBranch(repo, 'a b')).rejects.toThrow(/not a valid/)
    await expect(gitCreateBranch(repo, 'x; echo')).rejects.toThrow(/not a valid/)
    expect((await gitCreateBranch(repo, 'feature/one')).ok).toBe(true)
    let b = await gitBranches(repo)
    expect(b.current).toBe('feature/one')
    expect(b.branches.map((x) => x.name).sort()).toEqual(['feature/one', 'main'])
    write('a.txt', 'on feature\n')
    await gitStage(repo, ['a.txt'])
    await gitCommit(repo, 'feature change', false)
    expect((await gitCheckout(repo, 'main')).ok).toBe(true)
    write('a.txt', 'dirty on main\n')
    const clash = await gitCheckout(repo, 'feature/one')
    expect(clash.ok).toBe(false)
    expect(clash.output).toMatch(/Commit, stash or discard/)
    await expect(gitCheckout(repo, 'missing')).rejects.toThrow(/no branch/)
    await expect(gitCheckout(repo, '-f')).rejects.toThrow(/not a valid/)
    await gitDiscard(repo, ['a.txt'])
    expect((await gitCheckout(repo, 'feature/one')).ok).toBe(true)
    b = await gitBranches(repo)
    expect(b.current).toBe('feature/one')
  })

  it('works from a folder inside the repository and hides what lies outside it', async () => {
    write('sub/in.txt', 'in\n')
    write('outside.txt', 'out\n')
    const st = await gitStatus(join(repo, 'sub'))
    expect(st!.files.map((f) => f.path)).toEqual(['sub/in.txt'])
    await expect(gitStage(join(repo, 'sub'), ['outside.txt'])).rejects.toThrow(/inside the project/)
  })
})
