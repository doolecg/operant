import { expect, test } from 'claude-code/testing'

import { FILE_LIMIT, LIVE_MS, addFile, describeOther, folderOf, isLive, relativeTo, sameFile, trackerKey, trackerPrefix } from '../hooks/tracker'
import type { Tracker } from '../types'

const base: Tracker = { id: 'b', cwd: 'F:/repo', phase: 'working', at: 1_000, files: [] }

test('sessions of one folder share a prefix; a subfolder does not', () => {
  expect(trackerKey('F:\\Repo', 'a').startsWith(trackerPrefix('f:/repo'))).toBe(true)
  expect(trackerKey('F:/repo/sub', 'a').startsWith(trackerPrefix('F:/repo'))).toBe(false)
  expect(folderOf('F:\\Repo\\')).toBe('f:/repo')
})

test('the same file is matched whatever its slashes and case', () => {
  expect(sameFile('F:\\repo\\App.tsx', 'f:/repo/app.tsx')).toBe(true)
  expect(sameFile('F:/repo/a.ts', 'F:/repo/b.ts')).toBe(false)
})

test('a file list keeps the newest first, without repeats, up to its limit', () => {
  let files = addFile([], 'F:/repo/a.ts', 1)
  files = addFile(files, 'F:/repo/b.ts', 2)
  files = addFile(files, 'F:/REPO/A.ts', 3)
  expect(files.map(f => f.path)).toEqual(['F:/REPO/A.ts', 'F:/repo/b.ts'])
  for (let i = 0; i < FILE_LIMIT + 5; i++) files = addFile(files, `F:/repo/f${i}.ts`, i)
  expect(files.length).toBe(FILE_LIMIT)
})

test('a finished session is never live, and a silent one stops being live', () => {
  expect(isLive(base, 1_000 + LIVE_MS - 1)).toBe(true)
  expect(isLive(base, 1_000 + LIVE_MS)).toBe(false)
  expect(isLive({ ...base, phase: 'done' }, 1_000)).toBe(false)
})

test('the band line names the other session, its file and the file count', () => {
  expect(describeOther(base, 'F:/repo')).toBe('Other session: working — no file edits yet')
  const edited: Tracker = { ...base, phase: 'idle', files: [{ path: 'F:/repo/src/app.ts', at: 2 }, { path: 'F:/repo/a.ts', at: 1 }] }
  expect(describeOther(edited, 'F:/repo')).toBe('Other session: idle — editing src/app.ts (2 files)')
  expect(relativeTo('F:/repo', 'G:/elsewhere/x.ts')).toBe('G:/elsewhere/x.ts')
})
