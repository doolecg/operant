import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  GitBranches,
  GitCommit,
  GitCommitDetails,
  GitCommitFile,
  GitCommitResult,
  GitDiff,
  GitDiffLine,
  GitDiffRequest,
  GitFileEntry,
  GitHunk,
  GitHunkRef,
  GitResult,
  GitStatus,
} from '../shared/git'
import { spawnHidden } from './proc'

// The Git page's service. Every process goes through core/proc.ts (no console windows), arguments are always an
// array (never a shell string), user-given paths come after `--` and are checked to lie inside the project folder,
// and git never waits on a prompt or a pager.

const READ_TIMEOUT = 20_000
const NET_TIMEOUT = 120_000
const MAX_OUT = 3 * 1024 * 1024
const MAX_FILES = 2000
const MAX_DIFF_LINES = 5000
const MAX_LINE_CHARS = 2000
const MAX_UNTRACKED_BYTES = 1024 * 1024
const MAX_MESSAGE = 100_000

export class GitError extends Error {}

const failure = (msg: string): never => {
  throw new GitError(msg)
}

// ---------------------------------------------------------------- running git

export interface GitRun {
  code: number | null
  out: string
  err: string
  // The output hit the size cap and git was stopped.
  capped: boolean
}

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    ...(base.GIT_SSH_COMMAND || base.GIT_SSH ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
  }
}

// The arguments git is started with: no pager, paths printed as they are, no colour.
export const gitArgs = (args: string[]): string[] => ['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args]

export function runGit(args: string[], o: { cwd: string; timeoutMs?: number; maxBytes?: number; quiet?: boolean; env?: NodeJS.ProcessEnv }): Promise<GitRun> {
  const max = o.maxBytes ?? MAX_OUT
  return new Promise((done) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let capped = false
    let child
    try {
      child = spawnHidden('git', gitArgs(args), {
        cwd: o.cwd,
        env: gitEnv(o.env),
        shell: false,
        timeout: o.timeoutMs ?? READ_TIMEOUT,
        source: 'git',
        ...(o.quiet ? { quiet: true } : {}),
      })
    } catch (e) {
      return done({ code: null, out: '', err: e instanceof Error ? e.message : String(e), capped: false })
    }
    child.stdout?.on('data', (b: Buffer) => {
      if (capped) return
      size += b.length
      out.push(b)
      if (size > max) {
        capped = true
        child.kill()
      }
    })
    child.stderr?.on('data', (b: Buffer) => {
      if (err.reduce((n, x) => n + x.length, 0) < 256 * 1024) err.push(b)
    })
    child.on('error', (e) => done({ code: null, out: '', err: e.message, capped }))
    child.on('close', (code) => done({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), capped }))
  })
}

const words = (r: GitRun): string => `${r.out}${r.out && r.err ? '\n' : ''}${r.err}`.trim()

// Per repository, one changing action at a time: two git processes writing the index fight over its lock.
const queues = new Map<string, Promise<unknown>>()
function exclusive<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn)
  queues.set(key, next.catch(() => undefined))
  return next
}

const AUTH_FAILURE = /could not read (username|password)|authentication failed|terminal prompts disabled|permission denied \(publickey|host key verification failed|invalid credentials/i

function withHints(r: GitRun): string {
  const text = words(r) || (r.code === null ? 'git did not finish in time' : 'git gave no reason')
  return AUTH_FAILURE.test(text) ? `${text}\n\nGit cannot ask for a password here. Sign in once from a terminal (for example by running "git fetch" there), then try again.` : text
}

// ---------------------------------------------------------------- the repository and paths

export interface Repo {
  root: string
  // The project folder relative to the repository folder, "" when they are the same, else "sub/dir/".
  prefix: string
}

export async function findRepo(folder: string): Promise<Repo | null> {
  const r = await runGit(['rev-parse', '--show-toplevel', '--show-prefix'], { cwd: folder, quiet: true, timeoutMs: 10_000 })
  if (r.code !== 0) return null
  const [top = '', prefix = ''] = r.out.split(/\r?\n/)
  return { root: resolve(top.trim()), prefix: prefix.trim() }
}

async function requireRepo(folder: string): Promise<Repo> {
  return (await findRepo(folder)) ?? failure('This folder is not a git repository.')
}

const sameCase = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)

// A path from the page, checked and written the way git wants it ("/" separators). It must stay inside the project.
export function safeRepoPath(repo: Repo, p: unknown): string {
  if (typeof p !== 'string' || !p || p.includes('\0')) return failure('A file path is missing')
  const slashed = p.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[a-z]:/i.test(slashed) || isAbsolute(p)) return failure(`${p}: use a path inside the project`)
  const parts = slashed.split('/')
  if (parts.some((s) => s === '..' || s === '.git' || s === '')) return failure(`${p}: use a path inside the project`)
  const full = resolve(repo.root, slashed)
  const inside = relative(resolve(repo.root, repo.prefix), full)
  if (inside.startsWith('..') || isAbsolute(inside)) return failure(`${p}: use a path inside the project`)
  return slashed
}

const safePaths = (repo: Repo, paths: unknown): string[] => {
  if (!Array.isArray(paths) || paths.length === 0) return failure('Choose at least one file')
  if (paths.length > 5000) return failure('Too many files at once')
  return [...new Set(paths.map((p) => safeRepoPath(repo, p)))]
}

// Branch names: what `git check-ref-format --branch` allows, and never a leading dash (it would read as an option).
export async function checkBranchName(repo: Repo, name: unknown): Promise<string> {
  if (typeof name !== 'string' || !name.trim()) return failure('Give the branch a name')
  const n = name.trim()
  if (n.startsWith('-') || n.length > 200 || /[\0-\x20~^:?*[\\\x7f]/.test(n)) return failure(`"${n}" is not a valid branch name`)
  const r = await runGit(['check-ref-format', '--branch', n], { cwd: repo.root, quiet: true, timeoutMs: 10_000 })
  if (r.code !== 0) return failure(`"${n}" is not a valid branch name`)
  return n
}

// ---------------------------------------------------------------- status

// `git status --porcelain=v2 --branch -z` read into a status. The files are in git's order, all of them.
export function parseStatus(out: string): Omit<GitStatus, 'root'> {
  let head = ''
  let oid = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFileEntry[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!
    if (!rec) continue
    if (rec.startsWith('# ')) {
      if (rec.startsWith('# branch.head ')) head = rec.slice(14)
      else if (rec.startsWith('# branch.oid ')) oid = rec.slice(13)
      else if (rec.startsWith('# branch.upstream ')) upstream = rec.slice(18)
      else if (rec.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(rec)
        if (m) [ahead, behind] = [Number(m[1]), Number(m[2])]
      }
      continue
    }
    let m: RegExpExecArray | null
    if (rec[0] === '1' && (m = /^1 (..) (?:\S+ ){6}([\s\S]*)$/.exec(rec))) {
      files.push({ path: m[2]!, x: m[1]![0]!, y: m[1]![1]!, untracked: false, conflicted: false })
    } else if (rec[0] === '2' && (m = /^2 (..) (?:\S+ ){7}([\s\S]*)$/.exec(rec))) {
      files.push({ path: m[2]!, orig: parts[++i] ?? '', x: m[1]![0]!, y: m[1]![1]!, untracked: false, conflicted: false })
    } else if (rec[0] === 'u' && (m = /^u (..) (?:\S+ ){8}([\s\S]*)$/.exec(rec))) {
      files.push({ path: m[2]!, x: m[1]![0]!, y: m[1]![1]!, untracked: false, conflicted: true })
    } else if (rec[0] === '?') {
      files.push({ path: rec.slice(2), x: '.', y: '.', untracked: true, conflicted: false })
    }
  }
  const detached = head === '(detached)'
  return {
    branch: detached ? oid.slice(0, 7) : head,
    detached,
    upstream,
    ahead,
    behind,
    files,
    more: 0,
  }
}

const inProject = (repo: Repo, p: string): boolean => !repo.prefix || sameCase(p).startsWith(sameCase(repo.prefix))

async function readStatus(repo: Repo): Promise<Omit<GitStatus, 'root'>> {
  const r = await runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: repo.root, quiet: true, timeoutMs: READ_TIMEOUT, maxBytes: 8 * 1024 * 1024 })
  if (r.code !== 0 && !r.capped) return failure(r.err.trim().split(/\r?\n/)[0] || 'git status failed')
  const s = parseStatus(r.out)
  const all = s.files.filter((f) => inProject(repo, f.path))
  return { ...s, files: all.slice(0, MAX_FILES), more: Math.max(0, all.length - MAX_FILES) }
}

// Null for a folder that is not a git repository.
export async function gitStatus(folder: string): Promise<GitStatus | null> {
  const repo = await findRepo(folder)
  if (!repo) return null
  return { root: repo.root, ...(await readStatus(repo)) }
}

// ---------------------------------------------------------------- diffs

export interface SplitDiff {
  header: string[]
  hunks: string[][]
}

// One file's diff text cut into its header lines and its hunks, lines exactly as git wrote them.
export function splitDiff(text: string): SplitDiff {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const header: string[] = []
  const hunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('@@ ')) hunks.push([line])
    else if (hunks.length) hunks.at(-1)!.push(line)
    else header.push(line)
  }
  return { header, hunks }
}

// A whole `git diff` output holds one section per file: the one for `path` (or the first).
function pickSection(text: string, path: string): string {
  const starts: number[] = []
  const re = /^diff --git /gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) starts.push(m.index)
  if (starts.length <= 1) return text
  const sections = starts.map((s, i) => text.slice(s, starts[i + 1] ?? text.length))
  return sections.find((s) => s.includes(`\n+++ b/${path}\n`) || s.includes(`\nrename to ${path}\n`) || s.includes(`\n--- a/${path}\n`)) ?? sections[0]!
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(text: string, path: string): GitDiff {
  const { header, hunks: raw } = splitDiff(pickSection(text, path))
  const diff: GitDiff = { path, isNew: false, isDeleted: false, binary: false, additions: 0, deletions: 0, hunks: [] }
  for (const h of header) {
    if (h.startsWith('new file mode')) diff.isNew = true
    else if (h.startsWith('deleted file mode')) diff.isDeleted = true
    else if (h.startsWith('rename from ')) diff.renamedFrom = h.slice(12)
    else if (/^Binary files .* differ$/.test(h) || h === 'GIT binary patch') diff.binary = true
  }
  let budget = MAX_DIFF_LINES
  for (const lines of raw) {
    const m = HUNK.exec(lines[0]!)
    if (!m) continue
    const hunk: GitHunk = { header: lines[0]!.replace(/\r$/, ''), oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }
    let a = hunk.oldStart
    let b = hunk.newStart
    for (const l of lines.slice(1)) {
      if (l.startsWith('\\')) continue
      if (budget <= 0) {
        diff.note = `Only the first ${MAX_DIFF_LINES} lines are shown`
        break
      }
      budget--
      const t = l[0]
      let text1 = l.slice(1).replace(/\r$/, '')
      if (text1.length > MAX_LINE_CHARS) text1 = `${text1.slice(0, MAX_LINE_CHARS)}…`
      let line: GitDiffLine
      if (t === '+') {
        line = { type: 'add', text: text1, newNo: b++ }
        diff.additions++
      } else if (t === '-') {
        line = { type: 'del', text: text1, oldNo: a++ }
        diff.deletions++
      } else line = { type: 'ctx', text: text1, oldNo: a++, newNo: b++ }
      hunk.lines.push(line)
    }
    diff.hunks.push(hunk)
    if (budget <= 0) break
  }
  return diff
}

async function untrackedDiff(repo: Repo, path: string): Promise<GitDiff> {
  const base: GitDiff = { path, isNew: true, isDeleted: false, binary: false, additions: 0, deletions: 0, hunks: [] }
  const full = join(repo.root, path)
  let st
  try {
    st = await lstat(full)
  } catch (e) {
    return { ...base, note: e instanceof Error ? e.message : 'The file cannot be read' }
  }
  if (st.isSymbolicLink()) return { ...base, note: 'A link to another file' }
  if (!st.isFile()) return { ...base, note: 'Not a plain file (a folder or a repository of its own)' }
  if (st.size > MAX_UNTRACKED_BYTES) return { ...base, note: `New file of ${(st.size / 1048576).toFixed(1)} MB: too large to show` }
  const buf = await readFile(full).catch(() => null)
  if (!buf) return { ...base, note: 'The file cannot be read' }
  if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true }
  if (buf.length === 0) return { ...base, note: 'An empty file' }
  const lines = buf.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const shown = lines.slice(0, MAX_DIFF_LINES)
  const hunk: GitHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    newStart: 1,
    lines: shown.map((l, i) => ({ type: 'add', text: l.replace(/\r$/, '').slice(0, MAX_LINE_CHARS), newNo: i + 1 })),
  }
  return { ...base, additions: shown.length, hunks: [hunk], ...(lines.length > shown.length ? { note: `Only the first ${MAX_DIFF_LINES} lines are shown` } : {}) }
}

const HASH = /^[0-9a-f]{4,64}$/i

// The arguments of the git command that prints one file's diff for a side (exported for tests).
export function diffArgs(req: { side: 'staged' | 'unstaged' | 'commit'; commit?: string }, paths: string[]): string[] {
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '-U3']
  if (req.side === 'commit') return ['show', '--format=', '--first-parent', ...common, req.commit!, '--', ...paths]
  return ['diff', ...(req.side === 'staged' ? ['--cached'] : []), ...common, '--', ...paths]
}

export async function gitDiff(folder: string, req: GitDiffRequest): Promise<GitDiff> {
  const repo = await requireRepo(folder)
  const path = safeRepoPath(repo, req.path)
  const orig = req.orig ? safeRepoPath(repo, req.orig) : undefined
  if (req.side === 'untracked') return untrackedDiff(repo, path)
  if (req.side === 'commit' && !HASH.test(String(req.commit ?? ''))) return failure('That is not a commit id')
  if (req.side !== 'staged' && req.side !== 'unstaged' && req.side !== 'commit') return failure('Unknown diff side')
  const r = await runGit(diffArgs({ side: req.side, commit: req.commit }, orig ? [orig, path] : [path]), { cwd: repo.root, quiet: true, maxBytes: MAX_OUT })
  if (r.code !== 0 && !r.capped) return failure(r.err.trim().split(/\r?\n/)[0] || 'git diff failed')
  let text = r.out
  if (r.capped) text = text.slice(0, text.lastIndexOf('\n') + 1)
  const d = parseDiff(text, path)
  if (r.capped) d.note = 'The diff is too large: only the beginning is shown'
  return d
}

// ---------------------------------------------------------------- staging

async function entriesOf(repo: Repo, paths: string[]): Promise<GitFileEntry[]> {
  const st = await readStatus(repo)
  return st.files.filter((f) => paths.includes(f.path))
}

async function hasHead(repo: Repo): Promise<boolean> {
  return (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo.root, quiet: true, timeoutMs: 10_000 })).code === 0
}

const done = (r: GitRun): GitResult => ({ ok: r.code === 0, output: r.code === 0 ? words(r) : withHints(r) })

export async function gitStage(folder: string, paths: string[]): Promise<GitResult> {
  const repo = await requireRepo(folder)
  const list = safePaths(repo, paths)
  return exclusive(repo.root, async () => done(await runGit(['add', '-A', '--', ...list], { cwd: repo.root, timeoutMs: 60_000 })))
}

export async function gitUnstage(folder: string, paths: string[]): Promise<GitResult> {
  const repo = await requireRepo(folder)
  const list = safePaths(repo, paths)
  return exclusive(repo.root, async () => {
    const withOrig = [...new Set([...list, ...(await entriesOf(repo, list)).flatMap((f) => (f.orig ? [f.orig] : []))])]
    const args = (await hasHead(repo)) ? ['restore', '--staged', '--', ...withOrig] : ['rm', '--cached', '-r', '-q', '--', ...withOrig]
    return done(await runGit(args, { cwd: repo.root, timeoutMs: 60_000 }))
  })
}

// Throws the changes of the named files away: tracked files go back to the last commit, new (added) files are removed,
// and an untracked file is deleted with `git clean` limited to that one path. The page asks the person first.
export async function gitDiscard(folder: string, paths: string[]): Promise<GitResult> {
  const repo = await requireRepo(folder)
  const list = safePaths(repo, paths)
  return exclusive(repo.root, async () => {
    const entries = await entriesOf(repo, list)
    const missing = list.filter((p) => !entries.some((e) => e.path === p))
    if (missing.length) return failure(`${missing[0]} has no changes to discard`)
    const head = await hasHead(repo)
    const notes: string[] = []
    for (const e of entries) {
      if (e.conflicted) return failure(`${e.path} is in conflict: resolve it in a terminal first`)
      let r: GitRun
      if (e.untracked) r = await runGit(['clean', '-f', '-q', '--', e.path], { cwd: repo.root })
      else if (e.x === 'A' || !head) r = await runGit(['rm', '-f', '-q', '--', e.path], { cwd: repo.root })
      else if (e.orig) {
        r = await runGit(['rm', '-f', '-q', '--', e.path], { cwd: repo.root })
        if (r.code === 0) r = await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', e.orig], { cwd: repo.root })
      } else r = await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', e.path], { cwd: repo.root })
      if (r.code !== 0) return { ok: false, output: withHints(r) }
      notes.push(words(r))
    }
    return { ok: true, output: notes.filter(Boolean).join('\n') }
  })
}

// Builds the patch for one hunk of a file's diff, or null when the hunk is not there any more.
export function hunkPatch(diffText: string, ref: Pick<GitHunkRef, 'index' | 'header'>): string | null {
  const { header, hunks } = splitDiff(diffText)
  const hunk = hunks[ref.index]
  if (!hunk || hunk[0]!.replace(/\r$/, '') !== ref.header) return null
  return `${[...header, ...hunk].join('\n')}\n`
}

// Stages one hunk of a tracked file's unstaged changes (or, with `stage` false, unstages one hunk of its staged changes).
export async function gitStageHunk(folder: string, ref: GitHunkRef, stage: boolean): Promise<GitResult> {
  const repo = await requireRepo(folder)
  const path = safeRepoPath(repo, ref.path)
  if (!Number.isInteger(ref.index) || ref.index < 0 || typeof ref.header !== 'string') return failure('Choose a hunk')
  return exclusive(repo.root, async () => {
    const d = await runGit(diffArgs({ side: stage ? 'unstaged' : 'staged' }, [path]), { cwd: repo.root, quiet: true })
    if (d.code !== 0 || d.capped) return failure('The file is too large to stage by hunk: stage the whole file')
    const patch = hunkPatch(d.out, ref)
    if (patch === null) return failure('The file changed since it was shown: refresh and try again')
    if (patch.includes('�')) return failure('This file is not plain UTF-8 text: stage the whole file')
    const dir = await mkdtemp(join(tmpdir(), 'operant-patch-'))
    try {
      const file = join(dir, 'hunk.patch')
      await writeFile(file, patch, 'utf8')
      return done(await runGit(['apply', '--cached', '--whitespace=nowarn', ...(stage ? [] : ['--reverse']), file], { cwd: repo.root }))
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}

// ---------------------------------------------------------------- commit

export function normalizeMessage(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) return failure('Write a commit message first')
  if (message.includes('\0') || message.length > MAX_MESSAGE) return failure('That commit message cannot be used')
  return `${message.replace(/\r\n?/g, '\n').trimEnd()}\n`
}

// Commits what is staged with the message exactly as written: no trailers are added. Hooks run as usual, and their
// output (or the reason they refuse) comes back in `output`.
export async function gitCommit(folder: string, message: string, amend = false): Promise<GitCommitResult> {
  const repo = await requireRepo(folder)
  const text = normalizeMessage(message)
  return exclusive(repo.root, async () => {
    if (!amend && !(await readStatus(repo)).files.some((f) => !f.untracked && !f.conflicted && f.x !== '.')) return failure('Nothing is staged: stage files first')
    if (amend && !(await hasHead(repo))) return failure('There is no commit to amend yet')
    const dir = await mkdtemp(join(tmpdir(), 'operant-msg-'))
    try {
      const file = join(dir, 'COMMIT_MSG')
      await writeFile(file, text, 'utf8')
      const r = await runGit(['commit', '-F', file, ...(amend ? ['--amend'] : [])], { cwd: repo.root, timeoutMs: NET_TIMEOUT })
      if (r.code !== 0) return { ok: false, output: withHints(r) }
      const h = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: repo.root, quiet: true, timeoutMs: 10_000 })
      return { ok: true, output: words(r), hash: h.out.trim() }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}

export async function gitLastMessage(folder: string): Promise<string> {
  const repo = await requireRepo(folder)
  const r = await runGit(['log', '-1', '--format=%B', '--'], { cwd: repo.root, quiet: true, timeoutMs: 10_000 })
  return r.code === 0 ? r.out.trim() : ''
}

// ---------------------------------------------------------------- history

const FIELD = '\x1f'
const RECORD = '\x1e'
const LOG_FORMAT = ['%H', '%h', '%an', '%aI', '%s', '%D', '%b'].join('%x1f') + '%x1e'

export function parseLog(out: string): GitCommit[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const f = r.split(FIELD)
      return {
        hash: f[0] ?? '',
        short: f[1] ?? '',
        author: f[2] ?? '',
        date: f[3] ?? '',
        subject: f[4] ?? '',
        refs: (f[5] ?? '').split(', ').filter(Boolean),
        body: (f[6] ?? '').trim(),
      }
    })
}

export async function gitLog(folder: string, limit = 50, skip = 0): Promise<GitCommit[]> {
  const repo = await requireRepo(folder)
  const n = Math.min(300, Math.max(1, Math.trunc(Number(limit)) || 50))
  const s = Math.max(0, Math.trunc(Number(skip)) || 0)
  const r = await runGit(['log', `--max-count=${n}`, `--skip=${s}`, `--format=${LOG_FORMAT}`, '--'], { cwd: repo.root, quiet: true })
  if (r.code !== 0) return /does not have any commits|bad default revision|unknown revision/i.test(r.err) ? [] : failure(r.err.trim().split(/\r?\n/)[0] || 'git log failed')
  return parseLog(r.out)
}

// `git show --name-status -z -M` read into files.
export function parseNameStatus(out: string): GitCommitFile[] {
  const t = out.split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < t.length; i++) {
    const status = t[i]!.trim()
    if (!status) continue
    if (status[0] === 'R' || status[0] === 'C') {
      const orig = t[++i] ?? ''
      files.push({ status: status[0], orig, path: t[++i] ?? '' })
    } else files.push({ status: status[0]!, path: t[++i] ?? '' })
  }
  return files.filter((f) => f.path)
}

export async function gitCommitDetails(folder: string, hash: string): Promise<GitCommitDetails> {
  const repo = await requireRepo(folder)
  if (!HASH.test(String(hash))) return failure('That is not a commit id')
  const info = await runGit(['show', '-s', `--format=${LOG_FORMAT}`, hash, '--'], { cwd: repo.root, quiet: true })
  const commit = parseLog(info.out)[0]
  if (info.code !== 0 || !commit) return failure(info.err.trim().split(/\r?\n/)[0] || 'That commit was not found')
  const files = await runGit(['show', '--format=', '--name-status', '-z', '-M', '--first-parent', hash, '--'], { cwd: repo.root, quiet: true })
  return { commit, files: files.code === 0 ? parseNameStatus(files.out).slice(0, MAX_FILES) : [] }
}

// ---------------------------------------------------------------- branches

export async function gitBranches(folder: string): Promise<GitBranches> {
  const repo = await requireRepo(folder)
  const [refs, st] = await Promise.all([
    runGit(['for-each-ref', `--format=%(HEAD)%1f%(refname:short)%1f%(upstream:short)`, 'refs/heads'], { cwd: repo.root, quiet: true }),
    readStatus(repo),
  ])
  const branches = refs.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [head, name, upstream] = l.split(FIELD)
      return { name: name ?? '', current: head === '*', upstream: upstream || null }
    })
    .filter((b) => b.name)
  const { detached } = st
  return { current: st.branch, detached, branches }
}

export async function gitCheckout(folder: string, name: string): Promise<GitResult> {
  const repo = await requireRepo(folder)
  const n = await checkBranchName(repo, name)
  return exclusive(repo.root, async () => {
    const list = await gitBranches(folder)
    if (!list.branches.some((b) => b.name === n)) return failure(`There is no branch ${n}`)
    if (!list.detached && list.current === n) return { ok: true, output: `Already on ${n}` }
    const r = await runGit(['switch', '--no-guess', n], { cwd: repo.root, timeoutMs: 60_000 })
    if (r.code === 0) return { ok: true, output: words(r) }
    const text = words(r)
    const why = /would be overwritten|local changes|unmerged|conflict/i.test(text)
      ? 'Your uncommitted changes would be lost or clash with the other branch. Commit, stash or discard them first.\n\n'
      : ''
    return { ok: false, output: `${why}${text}` }
  })
}

export async function gitCreateBranch(folder: string, name: string): Promise<GitResult> {
  const repo = await requireRepo(folder)
  const n = await checkBranchName(repo, name)
  return exclusive(repo.root, async () => done(await runGit(['switch', '-c', n], { cwd: repo.root, timeoutMs: 60_000 })))
}

// ---------------------------------------------------------------- remotes

export async function gitFetch(folder: string): Promise<GitResult> {
  const repo = await requireRepo(folder)
  return exclusive(repo.root, async () => {
    const r = await runGit(['fetch', '--progress'], { cwd: repo.root, timeoutMs: NET_TIMEOUT })
    return done(r)
  })
}

// Fast-forward only: a diverged branch is not merged behind the person's back.
export async function gitPull(folder: string): Promise<GitResult> {
  const repo = await requireRepo(folder)
  return exclusive(repo.root, async () => {
    const st = await readStatus(repo)
    if (st.detached) return failure('HEAD is not on a branch: switch to a branch first')
    if (!st.upstream) return failure(`${st.branch} has no upstream branch to pull from`)
    const r = await runGit(['pull', '--ff-only', '--progress'], { cwd: repo.root, timeoutMs: NET_TIMEOUT })
    if (r.code === 0) return { ok: true, output: words(r) }
    const text = withHints(r)
    return { ok: false, output: /not possible to fast-forward|diverging|divergent/i.test(text) ? `${text}\n\nThe branch and its upstream have both changed. Merge or rebase in a terminal.` : text }
  })
}

export async function gitPush(folder: string): Promise<GitResult> {
  const repo = await requireRepo(folder)
  return exclusive(repo.root, async () => {
    const st = await readStatus(repo)
    if (st.detached) return failure('HEAD is not on a branch: switch to a branch first')
    let args = ['push', '--progress']
    if (!st.upstream) {
      const remotes = (await runGit(['remote'], { cwd: repo.root, quiet: true, timeoutMs: 10_000 })).out.split('\n').map((s) => s.trim())
      if (!remotes.includes('origin')) return failure('There is no remote named origin to push to: add one in a terminal')
      args = ['push', '--progress', '-u', 'origin', 'HEAD']
    }
    return done(await runGit(args, { cwd: repo.root, timeoutMs: NET_TIMEOUT }))
  })
}
