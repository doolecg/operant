import { expect, test } from 'claude-code/testing'

import { cleanIdea, folderOf, ideaKey, isIdea, newId, parseEdit, shelfPrefix } from '../hooks/shelf'

test('a shelf is keyed by the project folder, and folders do not share a prefix with subfolders', () => {
  const backslash = String.fromCharCode(92)
  expect(folderOf(`F:${backslash}PROGRAMMING${backslash}Repo${backslash}`)).toBe('f:/programming/repo')
  expect(ideaKey('F:/Repo', 'abc').startsWith(shelfPrefix('f:/repo'))).toBe(true)
  expect(ideaKey('F:/Repo/sub', 'abc').startsWith(shelfPrefix('F:/Repo'))).toBe(false)
})

test('an empty idea is refused and a long one is cut', () => {
  expect(cleanIdea('   ')).toBe(null)
  expect(cleanIdea('  add dark mode  ')).toBe('add dark mode')
  expect(cleanIdea('x'.repeat(5000))?.length).toBe(2000)
})

test('stored values are checked before they are listed', () => {
  expect(isIdea({ text: 'a', at: 1 })).toBe(true)
  expect(isIdea({ text: 'a' })).toBe(false)
  expect(isIdea(null)).toBe(false)
})

test('ids are distinct for distinct random draws', () => {
  expect(newId(1000, 0.1) === newId(1000, 0.2)).toBe(false)
})

test('/idea edit <n> <text> is read as an edit, anything else as a new idea', () => {
  expect(parseEdit('edit 2 add dark mode')).toEqual({ n: 2, text: 'add dark mode' })
  expect(parseEdit('edit 1')).toEqual({ n: 1, text: '' })
  expect(parseEdit('add dark mode')).toBe(null)
  expect(parseEdit('edit x text')).toBe(null)
})
