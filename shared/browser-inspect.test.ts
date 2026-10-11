import { describe, expect, it } from 'vitest'
import {
  addBookmark,
  bookmarkKey,
  cookiesForOrigin,
  cookieUrl,
  describeCookie,
  describeEmulation,
  DEFAULT_EMULATION,
  draftOfCookie,
  editBookmark,
  emptyCookieDraft,
  emulationPlan,
  filterConsole,
  filterCookies,
  filterNet,
  findBookmark,
  formatDuration,
  formatSize,
  isDefaultEmulation,
  maskValue,
  MASKED_VALUE,
  normalizeEmulation,
  originOf,
  parseBookmarks,
  pushRing,
  redactUrl,
  removeBookmark,
  siteCount,
  statusClass,
  validateCookieDraft,
  type Bookmark,
  type ConsoleEntry,
  type CookieInfo,
  type NetEntry,
} from './browser-inspect'

const net = (o: Partial<NetEntry>): NetEntry => ({ id: '1', at: 0, method: 'GET', url: 'https://a.test/x', type: 'fetch', ...o })
const con = (o: Partial<ConsoleEntry>): ConsoleEntry => ({ at: 0, level: 'log', text: 'hi', ...o })
const cookie = (o: Partial<CookieInfo>): CookieInfo => ({ name: 'sid', value: 'SECRET', domain: '.a.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax', ...o })

describe('pushRing', () => {
  it('keeps the newest entries in place', () => {
    const buf: number[] = []
    for (let i = 0; i < 7; i++) pushRing(buf, i, 3)
    expect(buf).toEqual([4, 5, 6])
  })
})

describe('log filters', () => {
  it('filters console by level and text', () => {
    const list = [con({ level: 'log', text: 'hello world' }), con({ level: 'error', text: 'boom' }), con({ level: 'warn', text: 'hello deprecated', url: 'https://a.test/app.js' })]
    expect(filterConsole(list, {})).toHaveLength(3)
    expect(filterConsole(list, { levels: ['error', 'warn'] }).map((e) => e.level)).toEqual(['error', 'warn'])
    expect(filterConsole(list, { text: 'HELLO' })).toHaveLength(2)
    expect(filterConsole(list, { text: 'hello app.js' })).toHaveLength(1)
  })
  it('classes and filters network entries', () => {
    const list = [net({ id: 'a', status: 200 }), net({ id: 'b', status: 301 }), net({ id: 'c', status: 404 }), net({ id: 'd', status: 503 }), net({ id: 'e', error: 'net::ERR_FAILED' }), net({ id: 'f' })]
    expect(list.map(statusClass)).toEqual(['2xx', '3xx', '4xx', '5xx', 'failed', 'pending'])
    expect(filterNet(list, { status: '4xx' }).map((e) => e.id)).toEqual(['c'])
    expect(filterNet(list, { status: 'failed' }).map((e) => e.id)).toEqual(['c', 'd', 'e'])
    expect(filterNet(list, { text: 'post' })).toHaveLength(0)
    expect(filterNet([net({ method: 'POST', url: 'https://a.test/api' })], { text: 'post api' })).toHaveLength(1)
  })
  it('formats size and duration', () => {
    expect(formatSize(undefined)).toBe('')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 kB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatDuration(120.4)).toBe('120 ms')
    expect(formatDuration(1500)).toBe('1.50 s')
  })
  it('redacts query values from URLs', () => {
    expect(redactUrl('https://a.test/p?token=abc&x=1#frag')).toBe('https://a.test/p?token=…&x=…')
    expect(redactUrl('not a url?secret=1')).toBe('not a url')
  })
})

describe('emulation', () => {
  it('starts with nothing emulated', () => {
    expect(isDefaultEmulation(DEFAULT_EMULATION)).toBe(true)
    const plan = emulationPlan(DEFAULT_EMULATION)
    expect(plan.metrics).toBeNull()
    expect(plan.userAgent).toBe('')
    expect(plan.colorScheme).toBe('')
    expect(plan.network).toEqual({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    expect(describeEmulation(DEFAULT_EMULATION)).toBe('')
  })
  it('plans a mobile preset with its user agent', () => {
    const plan = emulationPlan({ preset: 'mobile', colorScheme: 'dark', throttle: 'fast3g' })
    expect(plan.metrics).toMatchObject({ width: 412, mobile: true })
    expect(plan.userAgent).toContain('Mobile')
    expect(plan.colorScheme).toBe('dark')
    expect(plan.network.latency).toBeGreaterThan(0)
    expect(describeEmulation({ preset: 'mobile', colorScheme: 'dark', throttle: 'fast3g' })).toBe('Mobile (412 x 915) · Dark · Fast 3G')
  })
  it('lets an explicit user agent win over the preset', () => {
    expect(emulationPlan({ preset: 'tablet', colorScheme: 'system', throttle: 'none', userAgent: 'X/1' }).userAgent).toBe('X/1')
  })
  it('goes offline', () => {
    expect(emulationPlan({ preset: 'none', colorScheme: 'system', throttle: 'offline' }).network.offline).toBe(true)
  })
  it('clamps a custom size and drops junk', () => {
    const e = normalizeEmulation({ preset: 'custom', width: 10, height: 99999, deviceScaleFactor: 9, mobile: 1, userAgent: '  UA\n ', colorScheme: 'purple', throttle: 'x' })
    expect(e).toEqual({ preset: 'custom', width: 200, height: 4000, deviceScaleFactor: 4, mobile: false, userAgent: 'UA', colorScheme: 'system', throttle: 'none' })
    expect(normalizeEmulation(null)).toEqual(DEFAULT_EMULATION)
    expect(normalizeEmulation({ preset: 'mobile', width: 5 }).width).toBeUndefined()
  })
})

describe('cookies', () => {
  it('masks values until revealed', () => {
    expect(maskValue('SECRET', false)).toBe(MASKED_VALUE)
    expect(maskValue('a', false)).toBe(MASKED_VALUE)
    expect(maskValue('SECRET', true)).toBe('SECRET')
    expect(maskValue('', false)).toBe('')
  })
  it('never puts the value in a description', () => {
    const c = cookie({})
    const line = describeCookie(c)
    expect(line).not.toContain('SECRET')
    expect(line).toBe('sid @ a.test/ [secure, httpOnly, sameSite=lax, session]')
  })
  it('builds the cookie URL', () => {
    expect(cookieUrl({ domain: '.a.test', path: '/app', secure: true })).toBe('https://a.test/app')
    expect(cookieUrl({ domain: 'localhost', path: 'x' })).toBe('http://localhost/x')
  })
  it('matches cookies to an origin', () => {
    const list = [cookie({ domain: '.a.test' }), cookie({ domain: 'www.a.test' }), cookie({ domain: 'b.test' }), cookie({ domain: 'notа.test' })]
    expect(cookiesForOrigin(list, 'https://www.a.test').map((c) => c.domain)).toEqual(['.a.test', 'www.a.test'])
    expect(cookiesForOrigin(list, 'https://a.test')).toHaveLength(1)
    expect(cookiesForOrigin(list, 'garbage')).toEqual([])
    expect(originOf('https://a.test:8080/x?y')).toBe('https://a.test:8080')
    expect(originOf('about:blank')).toBeNull()
  })
  it('searches names and domains but not values', () => {
    const list = [cookie({ name: 'session', value: 'zzz' }), cookie({ name: 'theme', value: 'dark' })]
    expect(filterCookies(list, 'sess')).toHaveLength(1)
    expect(filterCookies(list, 'zzz')).toHaveLength(0)
    expect(siteCount([cookie({}), cookie({ domain: 'a.test' }), cookie({ domain: 'b.test' })])).toBe(2)
  })
  it('validates a draft', () => {
    const ok = { ...emptyCookieDraft('a.test'), name: 'x', value: 'y' }
    expect(validateCookieDraft(ok)).toBeNull()
    expect(validateCookieDraft({ ...ok, name: '' })).toMatch(/name/)
    expect(validateCookieDraft({ ...ok, name: 'a b' })).toMatch(/name/)
    expect(validateCookieDraft({ ...ok, value: 'a;b' })).toMatch(/value/)
    expect(validateCookieDraft({ ...ok, domain: 'bad domain' })).toMatch(/domain/)
    expect(validateCookieDraft({ ...ok, path: 'x' })).toMatch(/path/)
    expect(validateCookieDraft({ ...ok, sameSite: 'no_restriction' })).toMatch(/Secure/)
    expect(validateCookieDraft({ ...ok, sameSite: 'no_restriction', secure: true })).toBeNull()
    expect(draftOfCookie(cookie({ expires: 5 })).expires).toBe(5)
  })
})

describe('bookmarks', () => {
  const b = (id: string, url: string, title = ''): Bookmark => ({ id, url, title, at: 1 })
  it('adds once per page and ignores non-web pages', () => {
    let list: readonly Bookmark[] = []
    list = addBookmark(list, b('1', 'https://a.test/x/', 'A'))
    expect(list).toHaveLength(1)
    expect(addBookmark(list, b('2', 'https://a.test/x#top', 'A again'))).toBe(list)
    expect(addBookmark(list, b('3', 'about:blank'))).toBe(list)
    expect(addBookmark(list, b('4', 'https://b.test', '  '))[0]?.title).toBe('https://b.test')
    expect(findBookmark(list, 'https://A.test/x')?.id).toBe('1')
    expect(bookmarkKey('https://a.test/#x')).toBe('https://a.test')
  })
  it('edits and removes', () => {
    const list = [b('1', 'https://a.test', 'A'), b('2', 'https://b.test', 'B')]
    expect(editBookmark(list, '1', { title: ' New ' })[0]?.title).toBe('New')
    expect(editBookmark(list, '1', { url: 'javascript:alert(1)' })[0]?.url).toBe('https://a.test')
    expect(editBookmark(list, '1', { url: 'https://c.test', title: '' })[0]).toMatchObject({ url: 'https://c.test', title: 'https://c.test' })
    expect(removeBookmark(list, '1').map((x) => x.id)).toEqual(['2'])
  })
  it('parses a stored file defensively', () => {
    expect(parseBookmarks('nope')).toEqual([])
    expect(parseBookmarks([{ id: '1', url: 'https://a.test', title: 'A', at: 3 }, { id: 2 }, null, { id: '3', url: 'file:///x' }, { id: '4', url: 'https://d.test' }])).toEqual([
      { id: '1', url: 'https://a.test', title: 'A', at: 3 },
      { id: '4', url: 'https://d.test', title: 'https://d.test', at: 0 },
    ])
  })
})
