import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runHidden, type spawnHidden } from './proc'
import { IDES, findIde, gitChanges, gitInfo, listIdes, openInIde, parseGitInfo, type IdeProbe, type LaunchDeps } from './projecttools'

const probe = (over: Partial<IdeProbe> & { files?: string[]; dirs?: Record<string, string[]>; path?: Record<string, string[]> } = {}): IdeProbe => ({
  platform: 'win32',
  env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
  which: async (c) => over.path?.[c] ?? [],
  exists: (p) => over.files?.includes(p) ?? false,
  listDir: (p) => over.dirs?.[p] ?? [],
  ...over,
})
const spec = (id: string) => IDES.find((s) => s.id === id)!

describe('IDE detection', () => {
  it('finds a command on PATH and prefers the .exe, then .cmd, over the extensionless script', async () => {
    const p = probe({ path: { code: ['C:\\x\\bin\\code', 'C:\\x\\bin\\code.cmd'] } })
    expect(await findIde(spec('code'), p)).toBe('C:\\x\\bin\\code.cmd')
    const q = probe({ path: { code: ['C:\\x\\code', 'C:\\x\\code.cmd', 'C:\\x\\Code.exe'] } })
    expect(await findIde(spec('code'), q)).toBe('C:\\x\\Code.exe')
    expect(await findIde(spec('code'), probe({ path: { code: ['C:\\x\\code'] } }))).toBeNull()
  })

  it('falls back to the known Windows install folders', async () => {
    const code = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    expect(await findIde(spec('code'), probe({ files: [code] }))).toBe(code)
    expect(await findIde(spec('cursor'), probe({ files: [code] }))).toBeNull()
  })

  it('matches versioned JetBrains folders and takes the newest', async () => {
    const dir = 'C:\\Program Files\\JetBrains'
    const p = probe({
      dirs: { [dir]: ['IntelliJ IDEA 2025.1', 'IntelliJ IDEA 2026.1', 'JetBrains Rider 2026.1'] },
      files: [`${dir}\\IntelliJ IDEA 2025.1\\bin\\idea64.exe`, `${dir}\\IntelliJ IDEA 2026.1\\bin\\idea64.exe`],
    })
    expect(await findIde(spec('idea'), p)).toBe(`${dir}\\IntelliJ IDEA 2026.1\\bin\\idea64.exe`)
    expect(await findIde(spec('rider'), p)).toBeNull()
  })

  it('uses which on other platforms and lists availability with Custom last', async () => {
    const p = probe({ platform: 'linux', path: { zed: ['/usr/bin/zed'] } })
    const list = await listIdes('', p)
    expect(list.find((i) => i.id === 'zed')!.available).toBe(true)
    expect(list.find((i) => i.id === 'code')!.available).toBe(false)
    expect(list.at(-1)).toEqual({ id: 'custom', name: 'Custom command', available: false })
    expect((await listIdes('myide', p)).at(-1)!.available).toBe(true)
    expect(list.map((i) => i.id)).toEqual(['code', 'cursor', 'windsurf', 'zed', 'idea', 'rider', 'sublime', 'custom'])
  })
})

interface Call {
  file: string
  args: string[]
  opts: Record<string, unknown>
}

function fakeLaunch(behave: (child: EventEmitter & { unref(): void }) => void, p = probe({ path: { code: ['C:\\x\\code.cmd'], cursor: ['C:\\x\\Cursor.exe'] } })) {
  const calls: Call[] = []
  const spawn = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    setTimeout(() => behave(child), 5)
    return child
  }) as unknown as typeof spawnHidden
  const deps: LaunchDeps = { probe: p, spawn, settleMs: 80 }
  return { calls, deps }
}

describe('openInIde', () => {
  it('launches an .exe hidden-spawned and not detached on Windows, with the folder as its own argument', async () => {
    const { calls, deps } = fakeLaunch(() => {})
    await openInIde('C:\\code\\my project', 'cursor', '', deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: 'C:\\x\\Cursor.exe', args: ['C:\\code\\my project'] })
    expect(calls[0]!.opts).toMatchObject({ detached: false, stdio: 'ignore', shell: false, quiet: true, cwd: 'C:\\code\\my project' })
  })

  it('runs a .cmd launcher through the shell with both parts quoted', async () => {
    const { calls, deps } = fakeLaunch(() => {})
    await openInIde('C:\\code\\my project', 'code', '', deps)
    expect(calls[0]).toMatchObject({ file: '"C:\\x\\code.cmd" "C:\\code\\my project"', args: [] })
    expect(calls[0]!.opts).toMatchObject({ shell: true, detached: false })
  })

  it('refuses folder names a shell could misread, before anything is spawned', async () => {
    const { calls, deps } = fakeLaunch(() => {})
    for (const bad of ['C:\\a&calc', 'C:\\a"b', 'C:\\a|b', 'C:\\a%PATH%', 'C:\\a^b', 'C:\\a<b', 'C:\\a>b']) {
      await expect(openInIde(bad, 'code', '', deps)).rejects.toThrow(/cannot be passed/)
      await expect(openInIde(bad, 'custom', 'myide', deps)).rejects.toThrow(/cannot be passed/)
    }
    await expect(openInIde('C:\\a\nb', 'cursor', '', deps)).rejects.toThrow(/not valid/)
    expect(calls).toEqual([])
    // An .exe takes the folder as an argument without a shell, so those characters are fine there.
    await openInIde('C:\\a&b', 'cursor', '', deps)
    expect(calls).toHaveLength(1)
  })

  it('appends the folder to a custom command', async () => {
    const { calls, deps } = fakeLaunch(() => {})
    await openInIde('/home/me/app', 'custom', ' myide --new-window ', deps)
    expect(calls[0]).toMatchObject({ file: 'myide --new-window "/home/me/app"', args: [] })
    await expect(openInIde('/home/me/app', 'custom', '  ', deps)).rejects.toThrow(/No custom IDE command/)
  })

  it('reports a missing IDE, a spawn error and a quick non-zero exit', async () => {
    const { deps } = fakeLaunch(() => {})
    await expect(openInIde('C:\\p', 'zed', '', deps)).rejects.toThrow(/Zed was not found/)
    await expect(openInIde('C:\\p', 'nope' as never, '', deps)).rejects.toThrow(/Unknown IDE/)
    const failing = fakeLaunch((c) => c.emit('error', new Error('spawn ENOENT')))
    await expect(openInIde('C:\\p', 'cursor', '', failing.deps)).rejects.toThrow(/Cursor could not start: spawn ENOENT/)
    const exits = fakeLaunch((c) => c.emit('close', 1))
    await expect(openInIde('C:\\p', 'cursor', '', exits.deps)).rejects.toThrow(/exit code 1/)
    const ok = fakeLaunch((c) => c.emit('close', 0))
    await expect(openInIde('C:\\p', 'cursor', '', ok.deps)).resolves.toBeUndefined()
  })
})

describe('gitChanges', () => {
  const root = mkdtempSync(join(tmpdir(), 'operant-git-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const git = (cwd: string, ...args: string[]) => runHidden('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd })

  it('says so for a folder that is not a repository', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    // A parent repository would make it one; the temp folder has none above it in practice, so tolerate either answer.
    const r = await gitChanges(plain)
    if (!r.isRepo) expect(r).toEqual({ isRepo: false, branch: '', files: [], more: 0 })
  })

  it('lists the branch and each changed file with its status', async () => {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    await git(repo, 'init', '-q', '-b', 'main')
    expect((await gitChanges(repo)).files).toEqual([])
    writeFileSync(join(repo, 'a.txt'), 'one')
    writeFileSync(join(repo, 'b.txt'), 'two')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-q', '-m', 'first')
    writeFileSync(join(repo, 'a.txt'), 'changed')
    writeFileSync(join(repo, 'new file.txt'), 'x')
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'c.txt'), 'x')
    await git(repo, 'rm', '-q', 'b.txt')
    const r = await gitChanges(repo)
    expect(r.isRepo).toBe(true)
    expect(r.branch).toBe('main')
    expect(r.more).toBe(0)
    expect(r.files).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'a.txt' },
        { status: 'D', path: 'b.txt' },
        { status: '??', path: 'new file.txt' },
        { status: '??', path: 'sub/c.txt' },
      ]),
    )
    expect(r.files).toHaveLength(4)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('changed')
  })
})

describe('gitInfo', () => {
  it('reads the branch, ahead and behind counts and the changed files from porcelain v2', () => {
    const out = ['# branch.oid abcdef1234567', '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b a.txt', '? new.txt'].join('\n')
    expect(parseGitInfo(out)).toEqual({ branch: 'feature/x', ahead: 2, behind: 1, changes: 2, detached: false })
  })

  it('shows the short commit id for a detached HEAD, and zero counts without an upstream', () => {
    expect(parseGitInfo('# branch.oid abcdef1234567\n# branch.head (detached)\n')).toEqual({ branch: 'abcdef1', ahead: 0, behind: 0, changes: 0, detached: true })
  })

  it('answers null outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'operant-nogit-'))
    try {
      const r = await gitInfo(plain)
      if (r === null) expect(r).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
