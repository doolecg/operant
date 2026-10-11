import { describe, expect, it } from 'vitest'
import { assessCall, confirmSummary, isDownloadUrl, isPaymentUrl, redactCode } from './risk'

const risk = (name: string, args: Record<string, unknown> = {}) => assessCall({ name, args }).risk

describe('assessCall', () => {
  it('asks before clicking submit, pay, buy or delete targets', () => {
    for (const element of ['Submit button', 'Pay now', 'Buy now button', 'Place order', 'Delete account', 'Complete your order', 'Download report', 'Cancel subscription', 'Checkout link']) {
      expect(risk('browser_click', { element, target: 'e3' }), element).toBe('confirm')
    }
  })

  it('lets ordinary clicks through', () => {
    for (const element of ['Menu button', 'Next page', 'Sign in link', 'Search', 'Close dialog', 'Accordion header']) {
      expect(risk('browser_click', { element, target: 'e3' }), element).toBe('allow')
    }
  })

  it('also reads a CSS selector target', () => {
    expect(risk('browser_click', { target: 'button:has-text("Pay")' })).toBe('confirm')
    expect(risk('browser_click', { target: '#nav' })).toBe('allow')
    expect(risk('browser_click', { target: 'e12' })).toBe('allow')
  })

  it('asks before typing into password and card fields, in type and in fill_form', () => {
    expect(risk('browser_type', { element: 'Password textbox', target: 'e5', text: 'hunter2' })).toBe('confirm')
    expect(risk('browser_type', { element: 'Card number', target: 'e6', text: '4111' })).toBe('confirm')
    expect(risk('browser_type', { element: 'Email textbox', target: 'e7', text: 'a@b.test' })).toBe('allow')
    expect(risk('browser_fill_form', { fields: [{ name: 'Email', target: 'e1', type: 'textbox', value: 'a' }, { name: 'Password', target: 'e2', type: 'textbox', value: 'x' }] })).toBe('confirm')
    expect(risk('browser_fill_form', { fields: [{ name: 'Name', target: 'e1', type: 'textbox', value: 'a' }] })).toBe('allow')
  })

  it('asks for every script tool', () => {
    for (const name of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_run_playwright_script']) expect(risk(name, {})).toBe('confirm')
  })

  it('asks before opening payment pages and downloads', () => {
    expect(risk('browser_navigate', { url: 'https://shop.example/checkout?cart=1' })).toBe('confirm')
    expect(risk('browser_navigate', { url: 'https://www.paypal.com/signin' })).toBe('confirm')
    expect(risk('browser_navigate', { url: 'https://example.com/files/setup.exe' })).toBe('confirm')
    expect(risk('browser_navigate', { url: 'https://example.com/docs/intro' })).toBe('allow')
    expect(risk('browser_navigate', { url: 'not a url' })).toBe('allow')
    expect(risk('browser_tabs', { action: 'new', url: 'https://shop.example/payment' })).toBe('confirm')
    expect(risk('browser_tabs', { action: 'list' })).toBe('allow')
  })

  it('asks for uploads, blind coordinate clicks and session changes', () => {
    expect(risk('browser_file_upload', { paths: ['C:\\a.txt'] })).toBe('confirm')
    expect(risk('browser_file_upload', {})).toBe('allow')
    expect(risk('browser_mouse_click_xy', { x: 1, y: 2 })).toBe('confirm')
    expect(risk('browser_set_cookies', {})).toBe('confirm')
    expect(risk('browser_clear_storage', {})).toBe('confirm')
    expect(risk('browser_get_cookies', { includeValues: true })).toBe('confirm')
    expect(risk('browser_get_cookies', {})).toBe('allow')
    expect(risk('browser_grant_permissions', { permissions: ['geolocation'] })).toBe('confirm')
    expect(risk('browser_grant_permissions', { reset: true })).toBe('allow')
    expect(risk('browser_set_offline', { offline: true })).toBe('allow')
    expect(risk('browser_set_compat', { relaxCors: true })).toBe('confirm')
    expect(risk('browser_set_compat', { ignoreCertErrors: 'on' })).toBe('confirm')
    expect(risk('browser_set_compat', { relaxCors: false })).toBe('allow')
    expect(risk('browser_set_compat', { ignoreCertErrors: 'auto' })).toBe('allow')
    expect(risk('browser_set_compat', { relaxCors: false, ignoreCertErrors: 'off' })).toBe('allow')
    expect(confirmSummary({ name: 'browser_set_compat', args: { relaxCors: true, ignoreCertErrors: 'on' } })).toContain('relaxed CORS and ignore certificate errors')
    expect(risk('browser_list_downloads')).toBe('allow')
    expect(risk('browser_read_download', { id: 'd1' })).toBe('allow')
    expect(risk('browser_set_geolocation', { latitude: 1, longitude: 2 })).toBe('allow')
  })

  it('the grant summary names permissions and host, never a URL query', () => {
    const s = confirmSummary({ name: 'browser_grant_permissions', args: { permissions: ['geolocation', 'notifications'], origin: 'https://a.test/x?token=abc123' } })
    expect(s).toBe('Grant geolocation, notifications to a.test')
    expect(confirmSummary({ name: 'browser_grant_permissions', args: { permissions: ['geolocation'] } })).toContain('the current site')
  })

  it('allows reading and navigating tools', () => {
    for (const name of ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_get_page_text', 'browser_get_html', 'browser_hover', 'browser_press_key', 'browser_emulate_device', 'browser_status']) {
      expect(risk(name, { element: 'Delete' }), name).toBe('allow')
    }
  })
})

describe('url checks', () => {
  it('spots payment paths and hosts', () => {
    expect(isPaymentUrl('https://a.test/cart/checkout')).toBe(true)
    expect(isPaymentUrl('https://a.test/billing')).toBe(true)
    expect(isPaymentUrl('https://checkout.stripe.com/c/pay/cs_1')).toBe(true)
    expect(isPaymentUrl('https://a.test/blog/payment-trends-2024')).toBe(false)
    expect(isPaymentUrl('https://a.test/shoppay')).toBe(false)
  })

  it('spots downloadable files', () => {
    expect(isDownloadUrl('https://a.test/x.zip?dl=1')).toBe(true)
    expect(isDownloadUrl('https://a.test/page.html')).toBe(false)
  })
})

describe('confirmSummary', () => {
  it('never holds typed text or password values', () => {
    const s = confirmSummary({ name: 'browser_type', args: { element: 'Password textbox', target: 'e5', text: 'hunter2-secret' } })
    expect(s).toContain('Password textbox')
    expect(s).not.toContain('hunter2')
    const f = confirmSummary({ name: 'browser_fill_form', args: { fields: [{ name: 'Password', target: 'e1', type: 'textbox', value: 'hunter2-secret' }] } })
    expect(f).not.toContain('hunter2')
  })

  it('drops the query of a URL', () => {
    const s = confirmSummary({ name: 'browser_navigate', args: { url: 'https://shop.example/checkout?token=abc123' } })
    expect(s).toContain('shop.example/checkout')
    expect(s).not.toContain('abc123')
  })

  it('blanks secret-looking strings in scripts', () => {
    const code = "await page.fill('#pw', 'hunter2');\nawait page.fill('#password', 'hunter2');\nawait page.click('#go')"
    expect(redactCode(code)).not.toContain('hunter2')
    const s = confirmSummary({ name: 'browser_run_code_unsafe', args: { code } })
    expect(s.startsWith('Run Playwright code')).toBe(true)
    expect(s).not.toContain('hunter2')
  })

  it('names the click target and the reason', () => {
    expect(confirmSummary({ name: 'browser_click', args: { element: 'Place order', target: 'e4' } })).toMatch(/^Click "Place order" \(/)
  })
})
