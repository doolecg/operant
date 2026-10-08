import { describe, expect, it } from 'vitest'
import { decideTermKey, dropText, findFileLinks, imagePasteBytes, type TermKeyInput } from './terminal-keys'

const base: TermKeyInput = { mac: false, ctrlKey: true, metaKey: false, altKey: false, code: 'KeyC', hasSelection: true, live: true, bound: false }

describe('decideTermKey', () => {
  it('copies with a selection and sends Ctrl+C to the terminal without one', () => {
    expect(decideTermKey(base)).toBe('copy')
    expect(decideTermKey({ ...base, hasSelection: false })).toBe('terminal')
  })
  it('pastes on Ctrl+V only while the session is live', () => {
    expect(decideTermKey({ ...base, code: 'KeyV' })).toBe('paste')
    expect(decideTermKey({ ...base, code: 'KeyV', live: false })).toBe('terminal')
  })
  it('uses Cmd on macOS and lets Ctrl through', () => {
    const mac = { ...base, mac: true, ctrlKey: false, metaKey: true }
    expect(decideTermKey(mac)).toBe('copy')
    expect(decideTermKey({ ...mac, code: 'KeyV' })).toBe('paste')
    expect(decideTermKey({ ...mac, metaKey: false, ctrlKey: true })).toBe('terminal')
  })
  it('lets a bound shortcut go to the app first', () => {
    expect(decideTermKey({ ...base, bound: true })).toBe('app')
  })
  it('leaves Alt chords alone', () => {
    expect(decideTermKey({ ...base, altKey: true })).toBe('terminal')
  })
})

describe('imagePasteBytes', () => {
  it('sends Alt+V to Claude off macOS, Ctrl+V otherwise', () => {
    expect(imagePasteBytes(false, true)).toBe('\x1bv')
    expect(imagePasteBytes(true, true)).toBe('\x16')
    expect(imagePasteBytes(false, false)).toBe('\x16')
  })
})

describe('findFileLinks', () => {
  it('finds windows, unix and relative paths and trims trailing punctuation', () => {
    const l = findFileLinks('saved C:\\tmp\\a b.png, and /home/u/x.ts. also ./src/y.ts')
    expect(l.map((x) => x.text)).toEqual(['C:\\tmp\\a', '/home/u/x.ts', './src/y.ts'])
  })
  it('does not double-match a unix tail of a windows path', () => {
    expect(findFileLinks('C:/a/b/c.txt')).toHaveLength(1)
  })
  it('strips :line and :line:col from the path', () => {
    const l = findFileLinks('at C:\\p\\a.ts:12:5 and /home/u/x.ts:7 and ./y.ts:3')
    expect(l.map((x) => x.path)).toEqual(['C:\\p\\a.ts', '/home/u/x.ts', './y.ts'])
    expect(l[0]!.text).toBe('C:\\p\\a.ts:12:5')
  })
  it('does not link URLs', () => {
    expect(findFileLinks('see https://example.com/a/b.html and http://x/y')).toEqual([])
  })
  it('links plain relative paths with an extension', () => {
    expect(findFileLinks('error in src/a.ts:4 here').map((x) => x.path)).toEqual(['src/a.ts'])
    expect(findFileLinks('use the a/b folder')).toEqual([])
  })
})

describe('dropText', () => {
  it('quotes paths with spaces', () => {
    expect(dropText(['a.txt', 'C:\\My Docs\\b.txt'])).toBe('a.txt "C:\\My Docs\\b.txt"')
  })
})
