import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAppUrl, isTrustedSender } from './guard'

const indexFile = join(process.cwd(), 'out', 'renderer', 'index.html')
const indexUrl = pathToFileURL(indexFile).href
const packaged = { indexFile }
const dev = { devUrl: 'http://localhost:5173', indexFile }

describe('isAppUrl', () => {
  it('accepts the packaged renderer file, with a hash or query', () => {
    expect(isAppUrl(indexUrl, packaged)).toBe(true)
    expect(isAppUrl(`${indexUrl}#/x?y=1`, packaged)).toBe(true)
  })

  it('refuses other files, web pages and junk', () => {
    expect(isAppUrl('file:///etc/passwd', packaged)).toBe(false)
    expect(isAppUrl('https://example.com/', packaged)).toBe(false)
    expect(isAppUrl('about:blank', packaged)).toBe(false)
    expect(isAppUrl('not a url', packaged)).toBe(false)
    expect(isAppUrl(undefined, packaged)).toBe(false)
  })

  it('accepts only the dev server origin in dev', () => {
    expect(isAppUrl('http://localhost:5173/some/page', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl(indexUrl, dev)).toBe(false)
  })
})

describe('isTrustedSender', () => {
  const ok = { sender: { id: 7 }, senderFrame: { url: indexUrl } }

  it('accepts the main window showing the app', () => {
    expect(isTrustedSender(ok, 7, packaged)).toBe(true)
  })

  it('refuses another window, a foreign frame, a missing frame and no window', () => {
    expect(isTrustedSender({ ...ok, sender: { id: 8 } }, 7, packaged)).toBe(false)
    expect(isTrustedSender({ ...ok, senderFrame: { url: 'https://evil.example/' } }, 7, packaged)).toBe(false)
    expect(isTrustedSender({ sender: { id: 7 }, senderFrame: null }, 7, packaged)).toBe(false)
    expect(isTrustedSender(ok, null, packaged)).toBe(false)
  })
})
