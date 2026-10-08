import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACH_DIR, removeAllAttachments, removeAttachmentsOf, saveImages, withImages } from './attachments'

const dirs: string[] = []
const tmp = () => dirs[dirs.push(mkdtempSync(join(tmpdir(), 'att-'))) - 1]!
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('saveImages', () => {
  it('writes the images and lists them in the task', () => {
    const folder = tmp()
    const { paths } = saveImages(folder, [{ mime: 'image/png', data: Buffer.from('x').toString('base64') }])
    expect(paths).toHaveLength(1)
    expect(existsSync(paths[0]!)).toBe(true)
    expect(withImages('fix', paths)).toContain(paths[0]!)
  })
  it('rejects other types and leaves nothing behind', () => {
    const folder = tmp()
    expect(() => saveImages(folder, [{ mime: 'text/html', data: 'eA==' }])).toThrow()
    expect(existsSync(join(folder, ATTACH_DIR)) ? readdirSync(join(folder, ATTACH_DIR)).length : 0).toBe(0)
  })
})

describe('attachment cleanup', () => {
  it('removes the folders a task points at and nothing else', () => {
    const folder = tmp()
    const { paths } = saveImages(folder, [{ mime: 'image/png', data: 'eA==' }])
    const other = join(folder, 'keep')
    mkdirSync(other)
    removeAttachmentsOf(folder, `${withImages('t', paths)}
- ${join(other, 'x.png')}`)
    expect(existsSync(paths[0]!)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })
  it('lists the folder in .git/info/exclude', () => {
    const folder = tmp()
    mkdirSync(join(folder, '.git'))
    saveImages(folder, [{ mime: 'image/png', data: 'eA==' }])
    expect(readFileSync(join(folder, '.git', 'info', 'exclude'), 'utf8')).toContain(`${ATTACH_DIR}/`)
  })
})

describe('attachments with a .git file or a project delete', () => {
  it('excludes through a worktree .git file, and skips quietly on a broken one', () => {
    const folder = tmp()
    const real = tmp()
    mkdirSync(join(real, 'info'), { recursive: true })
    writeFileSync(join(folder, '.git'), `gitdir: ${real}\n`)
    saveImages(folder, [{ mime: 'image/png', data: 'eA==' }])
    expect(readFileSync(join(real, 'info', 'exclude'), 'utf8')).toContain(`${ATTACH_DIR}/`)
    const broken = tmp()
    writeFileSync(join(broken, '.git'), 'nonsense')
    expect(() => saveImages(broken, [{ mime: 'image/png', data: 'eA==' }])).not.toThrow()
  })
  it('removes every attachment folder of a project', () => {
    const folder = tmp()
    saveImages(folder, [{ mime: 'image/png', data: 'eA==' }])
    removeAllAttachments(folder)
    expect(existsSync(join(folder, ATTACH_DIR))).toBe(false)
    expect(() => removeAllAttachments(join(folder, 'missing'))).not.toThrow()
  })
})
