// Splits the "Attached images" block (appended by core/attachments withImages) off a task's text.
const BLOCK = /\n\nAttached images \(open each with your file-reading tool to see it\):\n((?:- [^\n]+\n?)+)\s*$/
const INSIDE = /[\\/]\.operant-attachments[\\/][^\\/\n]+[\\/][^\\/\n]+$/

export function splitAttachedImages(task: string): { text: string; images: string[] } {
  const m = BLOCK.exec(task)
  if (!m) return { text: task, images: [] }
  const images = m[1]!
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((p) => INSIDE.test(p))
  return images.length ? { text: task.slice(0, m.index), images } : { text: task, images: [] }
}
