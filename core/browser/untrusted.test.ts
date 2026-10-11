import { describe, expect, it } from 'vitest'
import { carriesPageText, UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted } from './untrusted'

describe('wrapUntrusted', () => {
  it('adds one note before and one after, keeping every item and other fields', () => {
    const image = { type: 'image', data: 'x', mimeType: 'image/png' }
    const out = wrapUntrusted({ content: [{ type: 'text', text: 'hello' }, image], isError: false }) as { content: unknown[]; isError: boolean }
    expect(out.isError).toBe(false)
    expect(out.content).toEqual([{ type: 'text', text: UNTRUSTED_OPEN }, { type: 'text', text: 'hello' }, image, { type: 'text', text: UNTRUSTED_CLOSE }])
  })

  it('leaves results without text alone', () => {
    const r = { content: [{ type: 'image', data: 'x' }] }
    expect(wrapUntrusted(r)).toBe(r)
    const e = { content: [] }
    expect(wrapUntrusted(e)).toBe(e)
    const odd = { something: 1 }
    expect(wrapUntrusted(odd)).toBe(odd)
  })

  it('knows which tools carry page text', () => {
    for (const n of ['browser_snapshot', 'browser_get_page_text', 'browser_get_html', 'browser_console_messages', 'browser_click', 'browser_run_playwright_script']) expect(carriesPageText(n), n).toBe(true)
    for (const n of ['browser_status', 'browser_get_cookies', 'browser_take_screenshot', 'browser_emulate_device']) expect(carriesPageText(n), n).toBe(false)
  })
})
