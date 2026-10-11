import { describe, expect, it } from 'vitest'
import {
  capDownloads,
  certificateKey,
  downloadPercent,
  formatBytes,
  isRiskyFile,
  MAX_DOWNLOADS_PER_CREW,
  originOf,
  permissionKey,
  permissionLabel,
  permissionPolicy,
  promptForTab,
  promptTitle,
  safeFileName,
  uniqueFileName,
  type BrowserDownload,
  type BrowserPrompt,
} from './browser-prompts'

const dl = (id: string, state: BrowserDownload['state']): BrowserDownload => ({ id, crewId: 1, url: 'https://x/', filename: id, path: id, state, received: 0, total: 0 })
const prompt = (id: string, tabId: number): BrowserPrompt => ({ id, crewId: 1, tabId, kind: 'alert', origin: 'https://a.test' })

describe('permissions', () => {
  it('grants harmless ones, asks for hardware and data, refuses the rest', () => {
    expect(permissionPolicy('fullscreen')).toBe('allow')
    expect(permissionPolicy('geolocation')).toBe('ask')
    expect(permissionPolicy('media')).toBe('ask')
    expect(permissionPolicy('openExternal')).toBe('deny')
    expect(permissionPolicy('usb')).toBe('deny')
    expect(permissionPolicy('something-new')).toBe('deny')
  })

  it('labels what the site wants', () => {
    expect(permissionLabel('geolocation')).toBe('know your location')
    expect(permissionLabel('media', ['video', 'audio'])).toBe('use your camera and microphone')
    expect(permissionLabel('media', ['video'])).toBe('use your camera')
    expect(permissionLabel('media', ['audio'])).toBe('use your microphone')
    expect(permissionLabel('media')).toBe('use your camera or microphone')
    expect(permissionLabel('weird')).toBe('use "weird"')
  })

  it('keys remembered answers by origin, permission and media kind', () => {
    expect(permissionKey('https://a.test', 'geolocation')).toBe('https://a.test|geolocation')
    expect(permissionKey('https://a.test', 'media', ['video', 'audio'])).toBe(permissionKey('https://a.test', 'media', ['audio', 'video']))
    expect(permissionKey('https://a.test', 'media', ['video'])).not.toBe(permissionKey('https://a.test', 'media', ['audio']))
  })
})

describe('origins and certificates', () => {
  it('reads the origin of a url', () => {
    expect(originOf('https://a.test:8443/x?y=1')).toBe('https://a.test:8443')
    expect(originOf('file:///C:/x.html')).toBe('file:')
    expect(originOf('not a url')).toBe('not a url')
  })

  it('keys a certificate by lowercase host and fingerprint', () => {
    expect(certificateKey('A.Test', 'sha256/abc')).toBe('a.test|sha256/abc')
  })
})

describe('download file names', () => {
  it('strips path and reserved characters', () => {
    expect(safeFileName('a/b\\c:d.txt')).toBe('a_b_c_d.txt')
    expect(safeFileName('..hidden.')).toBe('hidden')
    expect(safeFileName('')).toBe('download')
    expect(safeFileName('con.txt')).toBe('_con.txt')
    expect(safeFileName('x'.repeat(400)).length).toBe(150)
  })

  it('numbers a name that is taken', () => {
    const taken = new Set(['a.txt', 'a (1).txt', 'noext', 'noext (1)'])
    expect(uniqueFileName('b.txt', (n) => taken.has(n))).toBe('b.txt')
    expect(uniqueFileName('a.txt', (n) => taken.has(n))).toBe('a (2).txt')
    expect(uniqueFileName('noext', (n) => taken.has(n))).toBe('noext (2)')
    expect(uniqueFileName('.gitignore', (n) => n === '.gitignore')).toBe('.gitignore (1)')
  })

  it('flags files that must not be run by a click', () => {
    expect(isRiskyFile('setup.EXE')).toBe(true)
    expect(isRiskyFile('run.ps1')).toBe(true)
    expect(isRiskyFile('photo.png')).toBe(false)
    expect(isRiskyFile('exe')).toBe(false)
  })
})

describe('progress', () => {
  it('computes a percentage, or null without a size', () => {
    expect(downloadPercent({ received: 50, total: 200 })).toBe(25)
    expect(downloadPercent({ received: 500, total: 200 })).toBe(100)
    expect(downloadPercent({ received: 50, total: 0 })).toBeNull()
  })

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(-1)).toBe('')
  })

  it('caps the list, dropping finished downloads first', () => {
    const list = [dl('active-old', 'progressing')]
    for (let i = 0; i < MAX_DOWNLOADS_PER_CREW + 3; i++) list.unshift(dl(`done${String(i)}`, 'completed'))
    list.push(dl('active-last', 'progressing'))
    const out = capDownloads(list)
    expect(out.length).toBe(MAX_DOWNLOADS_PER_CREW)
    expect(out.some((d) => d.id === 'active-old')).toBe(true)
    expect(out.some((d) => d.id === 'active-last')).toBe(true)
  })
})

describe('prompt text and selection', () => {
  it('words each kind', () => {
    const base = { origin: 'https://a.test' }
    expect(promptTitle({ ...base, kind: 'alert' })).toBe('https://a.test says')
    expect(promptTitle({ ...base, kind: 'permission', permission: 'geolocation', permissionLabel: 'know your location' })).toBe('https://a.test wants to know your location')
    expect(promptTitle({ ...base, kind: 'auth', realm: 'Admin' })).toBe('https://a.test asks you to sign in (Admin)')
    expect(promptTitle({ ...base, kind: 'auth' })).toBe('https://a.test asks you to sign in')
    expect(promptTitle({ ...base, kind: 'certificate' })).toContain('cannot be trusted')
    expect(promptTitle({ ...base, kind: 'beforeunload' })).toContain('leave this page')
  })

  it('picks the oldest prompt of the showing tab', () => {
    const list = [prompt('p1', 2), prompt('p2', 1), prompt('p3', 1)]
    expect(promptForTab(list, 1)?.id).toBe('p2')
    expect(promptForTab(list, 3)).toBeUndefined()
    expect(promptForTab(list, null)).toBeUndefined()
  })
})
