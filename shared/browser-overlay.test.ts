import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildCursorScript, buildHighlightScript, isAriaRef, parseSnapshotRefs, toTarget, type OverlayTarget } from './browser-overlay'

class FakeEl {
  children: FakeEl[] = []
  attrs = new Map<string, string>()
  textContent = ''
  tagName = 'DIV'
  type = ''
  value = ''
  labels: FakeEl[] = []
  removed = false
  constructor(public rect = { left: 0, top: 0, width: 0, height: 0 }) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v)
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null
  }
  attachShadow() {
    return this
  }
  appendChild(c: FakeEl) {
    this.children.push(c)
    return c
  }
  remove() {
    this.removed = true
  }
  animate() {
    return {}
  }
  getBoundingClientRect() {
    return this.rect
  }
}

function runScript(script: string, page: FakeEl[] = []) {
  const root = new FakeEl()
  const hosts: FakeEl[] = []
  const timers: Array<() => void> = []
  const doc = {
    documentElement: root,
    body: root,
    createElement: () => {
      const e = new FakeEl()
      hosts.push(e)
      return e
    },
    querySelector: (sel: string) => {
      if (sel === '#bad(') throw new SyntaxError('bad selector')
      return sel === '#go' ? page[0] ?? null : null
    },
    querySelectorAll: (sel: string) => (sel.includes('button') ? page : []),
    getElementById: () => null,
  }
  const result = runInNewContext(script, { document: doc, setTimeout: (f: () => void) => timers.push(f), clearTimeout: () => undefined }) as string
  return { result: JSON.parse(result) as Record<string, unknown>, root, hosts, timers }
}

describe('parseSnapshotRefs', () => {
  it('maps refs to role and name', () => {
    const m = parseSnapshotRefs(
      ['- generic [ref=e1]:', '  - button "Save \\"all\\"" [ref=e12] [cursor=pointer]', '  - textbox "Email" [ref=e5]:', '  - link [ref=f1e3]'].join('\n'),
    )
    expect(m.get('e12')).toEqual({ role: 'button', name: 'Save "all"' })
    expect(m.get('e5')).toEqual({ role: 'textbox', name: 'Email' })
    expect(m.get('f1e3')).toEqual({ role: 'link', name: '' })
    expect(m.get('e1')).toEqual({ role: 'generic', name: '' })
  })
})

describe('toTarget', () => {
  it('tells refs from selectors', () => {
    expect(isAriaRef('e12')).toBe(true)
    expect(isAriaRef('f2e7')).toBe(true)
    expect(isAriaRef('#e12')).toBe(false)
    const hints = new Map([['e12', { role: 'button', name: 'Save' }]])
    expect(toTarget('e12', hints)).toEqual({ kind: 'ref', ref: 'e12', role: 'button', name: 'Save' })
    expect(toTarget('e99', hints)).toEqual({ kind: 'ref', ref: 'e99', role: undefined, name: undefined })
    expect(toTarget(' #go ')).toEqual({ kind: 'selector', selector: '#go' })
    expect(toTarget(undefined)).toBeNull()
    expect(toTarget('x'.repeat(501))).toBeNull()
  })
})

describe('overlay scripts', () => {
  const box: OverlayTarget = { kind: 'box', x: 10, y: 40, w: 100, h: 30 }

  it('are valid JavaScript', () => {
    expect(() => new Function(buildHighlightScript(box, 'Click "Save"', 1500))).not.toThrow()
    expect(() => new Function(buildCursorScript(5, 6, 1500))).not.toThrow()
  })

  it('highlights a box, adds one detached host, and removes it when the timer fires', () => {
    const { result, root, timers } = runScript(buildHighlightScript(box, 'Click', 1500))
    expect(result).toEqual({ found: true, x: 10, y: 40, w: 100, h: 30 })
    expect(root.children).toHaveLength(1)
    expect(root.children[0]?.getAttribute('style')).toContain('pointer-events:none')
    expect(timers).toHaveLength(1)
    timers[0]?.()
    expect(root.children[0]?.removed).toBe(true)
  })

  it('finds a selector and reports its rect', () => {
    const el = new FakeEl({ left: 3, top: 4, width: 50, height: 20 })
    const { result } = runScript(buildHighlightScript({ kind: 'selector', selector: '#go' }, '', 1500), [el])
    expect(result).toEqual({ found: true, x: 3, y: 4, w: 50, h: 20 })
  })

  it('reports not found for a bad selector, a hidden element or a ref without a hint', () => {
    expect(runScript(buildHighlightScript({ kind: 'selector', selector: '#bad(' }, '', 1500)).result).toEqual({ found: false })
    const hidden = new FakeEl()
    expect(runScript(buildHighlightScript({ kind: 'selector', selector: '#go' }, '', 1500), [hidden]).result).toEqual({ found: false })
    expect(runScript(buildHighlightScript({ kind: 'ref', ref: 'e1' }, '', 1500)).result).toEqual({ found: false })
  })

  it('finds a ref by role and name', () => {
    const save = new FakeEl({ left: 1, top: 2, width: 30, height: 10 })
    save.textContent = ' Save '
    const other = new FakeEl({ left: 9, top: 9, width: 30, height: 10 })
    other.textContent = 'Cancel'
    const r = runScript(buildHighlightScript({ kind: 'ref', ref: 'e12', role: 'button', name: 'Save' }, 'x', 1500), [other, save])
    expect(r.result).toEqual({ found: true, x: 1, y: 2, w: 30, h: 10 })
  })

  it('draws the cursor', () => {
    const { result, root, timers } = runScript(buildCursorScript(60, 55, 1500))
    expect(result).toEqual({ ok: true })
    expect(root.children).toHaveLength(1)
    expect(timers).toHaveLength(1)
  })

  it('clamps the duration', () => {
    expect(buildCursorScript(1, 1, 999_999)).toContain('"ms":10000')
    expect(buildCursorScript(1, 1, 1)).toContain('"ms":300')
  })

  it('keeps a label out of the code path', () => {
    const evil = '"});alert(1);//'
    const { result } = runScript(buildHighlightScript(box, evil, 1500))
    expect(result.found).toBe(true)
  })
})
