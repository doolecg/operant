import { describe, expect, it } from 'vitest'
import { splitAttachedImages } from './attached-images'

const block = (paths: string[]) => `\n\nAttached images (open each with your file-reading tool to see it):\n${paths.map((p) => `- ${p}`).join('\n')}`

describe('splitAttachedImages', () => {
  it('splits the block withImages appends', () => {
    const a = String.raw`C:\proj\.operant-attachments\ab12cd34\image-1.png`
    const b = '/proj/.operant-attachments/ab12cd34/image-2.jpg'
    expect(splitAttachedImages(`fix it${block([a, b])}`)).toEqual({ text: 'fix it', images: [a, b] })
  })
  it('leaves a task without the block alone', () => {
    expect(splitAttachedImages('plain')).toEqual({ text: 'plain', images: [] })
  })
  it('ignores paths outside an attachments folder and keeps the text then', () => {
    const t = `x${block(['/etc/passwd'])}`
    expect(splitAttachedImages(t)).toEqual({ text: t, images: [] })
  })
})
