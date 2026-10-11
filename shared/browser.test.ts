import { describe, expect, it } from 'vitest'
import { addVisit, DEFAULT_BROWSER_SETTINGS, isHistoryUrl, matchHistory, moveInList, nextZoom, partitionOf, toUrl } from './browser'

const S = 'https://search.example/?q=%s'

describe('toUrl', () => {
  it('keeps full http and https URLs', () => {
    expect(toUrl('https://example.com/a?b=1', S)).toBe('https://example.com/a?b=1')
    expect(toUrl('  http://example.com ', S)).toBe('http://example.com')
  })
  it('adds a scheme to hosts', () => {
    expect(toUrl('example.com', S)).toBe('https://example.com')
    expect(toUrl('example.com/path?x=1', S)).toBe('https://example.com/path?x=1')
  })
  it('uses http for localhost and IPs, with ports', () => {
    expect(toUrl('localhost:3000', S)).toBe('http://localhost:3000')
    expect(toUrl('localhost', S)).toBe('http://localhost')
    expect(toUrl('127.0.0.1:8080/x', S)).toBe('http://127.0.0.1:8080/x')
    expect(toUrl('example.com:8443', S)).toBe('https://example.com:8443')
  })
  it('searches for words', () => {
    expect(toUrl('hello world', S)).toBe('https://search.example/?q=hello%20world')
    expect(toUrl('cats', S)).toBe('https://search.example/?q=cats')
    expect(toUrl('what is a+b', 'https://s.example/q=')).toBe('https://s.example/q=what%20is%20a%2Bb')
  })
  it('refuses unsafe schemes and empty input', () => {
    expect(toUrl('javascript:alert(1)', S)).toBeNull()
    expect(toUrl('JavaScript:alert(1)', S)).toBeNull()
    expect(toUrl('file:///C:/secret.txt', S)).toBeNull()
    expect(toUrl('data:text/html,<b>x</b>', S)).toBeNull()
    expect(toUrl('chrome://settings', S)).toBeNull()
    expect(toUrl('   ', S)).toBeNull()
  })
  it('allows about:blank', () => {
    expect(toUrl('about:blank', S)).toBe('about:blank')
  })
})

describe('browser helpers', () => {
  it('names one partition per project', () => {
    expect(partitionOf(7)).toBe('persist:browser-crew-7')
  })
  it('defaults have a %s search', () => {
    expect(DEFAULT_BROWSER_SETTINGS.searchUrl).toContain('%s')
    expect(DEFAULT_BROWSER_SETTINGS.aiControl).toBe(true)
  })
})

describe('history and zoom helpers', () => {
  const e = (url: string, title: string, visits = 1, at = 1) => ({ url, title, visits, at })

  it('addVisit moves to the front, counts visits and caps the list', () => {
    let list = addVisit([], 'https://a.com/', 'A', 1)
    list = addVisit(list, 'https://b.com/', 'B', 2)
    list = addVisit(list, 'https://a.com/', '', 3)
    expect(list.map((x) => x.url)).toEqual(['https://a.com/', 'https://b.com/'])
    expect(list[0]).toMatchObject({ visits: 2, title: 'A', at: 3 })
    expect(addVisit(list, 'https://c.com/', 'C', 4, 2)).toHaveLength(2)
  })
  it('only web pages are history', () => {
    expect(isHistoryUrl('https://a.com/x')).toBe(true)
    expect(isHistoryUrl('view-source:https://a.com')).toBe(false)
    expect(isHistoryUrl('about:blank')).toBe(false)
  })
  it('matchHistory needs every word and ranks host prefix, then visits', () => {
    const list = [e('https://docs.example.com/a', 'Guide to cats', 1), e('https://example.com/', 'Example', 5), e('https://other.org/example', 'Other', 9)]
    expect(matchHistory(list, 'example').map((x) => x.url)).toEqual(['https://example.com/', 'https://other.org/example', 'https://docs.example.com/a'])
    expect(matchHistory(list, 'guide cats')).toHaveLength(1)
    expect(matchHistory(list, 'zzz')).toEqual([])
    expect(matchHistory(list, '   ')).toEqual([])
    expect(matchHistory(list, 'example', 1)).toHaveLength(1)
  })
  it('nextZoom snaps to steps', () => {
    expect(nextZoom(100, 'in')).toBe(110)
    expect(nextZoom(100, 'out')).toBe(90)
    expect(nextZoom(137, 'in')).toBe(150)
    expect(nextZoom(500, 'in')).toBe(500)
    expect(nextZoom(25, 'out')).toBe(25)
    expect(nextZoom(250, 'reset')).toBe(100)
  })
  it('moveInList lands the item at the target index', () => {
    expect(moveInList([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4])
    expect(moveInList([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3])
    expect(moveInList([1, 2, 3], 1, 99)).toEqual([1, 3, 2])
    expect(moveInList([1, 2, 3], 9, 0)).toEqual([1, 2, 3])
  })
})
