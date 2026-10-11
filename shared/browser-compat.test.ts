import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings'
import { cleanUserAgent, compatWarnings, corsResponseHeaders, isLocalDevHost, mergeResponseHeaders, proxyConfig, sanitizeCrewBrowser, shouldIgnoreCertError } from './browser-compat'

describe('cert host rules', () => {
  it('auto covers only local dev hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', 'app.test', 'nas.local', 'API.LOCAL']) expect(isLocalDevHost(h)).toBe(true)
    for (const h of ['example.com', 'localhost.evil.com', 'test', '10.0.0.1', '']) expect(isLocalDevHost(h)).toBe(false)
  })
  it('on and off override auto', () => {
    expect(shouldIgnoreCertError('on', 'example.com')).toBe(true)
    expect(shouldIgnoreCertError('off', 'localhost')).toBe(false)
    expect(shouldIgnoreCertError('auto', 'localhost')).toBe(true)
    expect(shouldIgnoreCertError('auto', 'example.com')).toBe(false)
  })
})

describe('user agent', () => {
  it('strips Electron and the app name', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) operant2/3.0.4 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36'
    expect(cleanUserAgent(ua, 'operant2')).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
  })
})

describe('cors', () => {
  it('echoes the origin with credentials, wildcard otherwise', () => {
    const a = corsResponseHeaders('http://localhost:5173', 'x-a, content-type')
    expect(a['Access-Control-Allow-Origin']).toEqual(['http://localhost:5173'])
    expect(a['Access-Control-Allow-Credentials']).toEqual(['true'])
    expect(a['Access-Control-Allow-Headers']).toEqual(['x-a, content-type'])
    const b = corsResponseHeaders(undefined, undefined)
    expect(b['Access-Control-Allow-Origin']).toEqual(['*'])
    expect(b['Access-Control-Allow-Credentials']).toBeUndefined()
  })
  it('replaces existing headers case-insensitively', () => {
    const m = mergeResponseHeaders({ 'access-control-allow-origin': ['https://x'], 'content-type': ['a'] }, corsResponseHeaders('https://y', undefined))
    expect(m['access-control-allow-origin']).toBeUndefined()
    expect(m['Access-Control-Allow-Origin']).toEqual(['https://y'])
    expect(m['content-type']).toEqual(['a'])
  })
})

describe('crew options', () => {
  it('sanitizes bad input', () => {
    const o = sanitizeCrewBrowser({ ignoreCertErrors: 'x', relaxCors: 'yes', proxy: 'not a proxy', userAgent: 'a\r\nb', headers: [{ name: 'X-Ok', value: 'v\r\nInjected: 1' }, { name: 'Bad Name', value: 'v' }, { name: 'Host', value: 'v' }, 5] })
    expect(o).toEqual({ ignoreCertErrors: 'auto', relaxCors: false, proxy: '', userAgent: 'ab', headers: [{ name: 'X-Ok', value: 'vInjected: 1' }] })
  })
  it('keeps good input and drops bad crew keys', () => {
    const s = sanitizeSettings({ browser: { autonomy: 'full', perCrew: { '3': { ignoreCertErrors: 'on', relaxCors: true, proxy: 'http://127.0.0.1:8080' }, abc: {} } } }).browser
    expect(s.autonomy).toBe('full')
    expect(Object.keys(s.perCrew)).toEqual(['3'])
    expect(s.perCrew['3']).toMatchObject({ ignoreCertErrors: 'on', relaxCors: true, proxy: 'http://127.0.0.1:8080' })
    expect(DEFAULT_SETTINGS.browser.autonomy).toBe('confirm')
  })
  it('proxy config and warnings', () => {
    expect(proxyConfig('')).toEqual({ mode: 'direct' })
    expect(proxyConfig('socks5://h:1080')).toEqual({ mode: 'fixed_servers', proxyRules: 'socks5://h:1080' })
    expect(compatWarnings({ ...sanitizeCrewBrowser({}), relaxCors: true, ignoreCertErrors: 'on' })).toEqual({ relaxCors: true, ignoreCerts: true })
    expect(compatWarnings(sanitizeCrewBrowser({}))).toEqual({ relaxCors: false, ignoreCerts: false })
  })
})
