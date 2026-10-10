import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lesson, MemoryFile } from '../shared/learn'
import { scrubLogLine } from './agents'
import { claudeProjectsDir } from './paths'
import { encodeProjectDir } from './transcripts'

// The project's personal-memory folder, as Claude Code keeps it: projects/<encoded cwd>/memory.
export const memoryDirFor = (folder: string): string => join(claudeProjectsDir(), encodeProjectDir(folder), 'memory')

const INDEX = 'MEMORY.md'
const one = (s: string) => s.replace(/\s+/g, ' ').trim()

// A lesson's file is named after it, so writing it again updates the file instead of adding a second one.
// User-level facts get their own prefix and type, apart from the project's.
export const memoryFileName = (l: Pick<Lesson, 'id' | 'scope'>): string => `operant_${l.scope === 'user' ? 'user' : 'lesson'}_${l.id}.md`

function render(l: Lesson): { name: string; description: string; text: string } {
  const type = l.scope === 'user' ? 'user' : l.kind === 'correction' ? 'feedback' : 'project'
  const name = one(scrubLogLine(l.text)).slice(0, 60)
  const n = l.sourceJobs.length
  const description = `${l.kind} learned by Operant${n ? ` from ${n} session${n === 1 ? '' : 's'}` : ''}`
  const where = [l.files.length ? `Files: ${l.files.join(', ')}` : '', l.symbols.length ? `Symbols: ${l.symbols.join(', ')}` : ''].filter(Boolean)
  const text = `---\nname: ${name.replace(/\n/g, ' ')}\ndescription: ${description}\ntype: ${type}\n---\n\n${scrubLogLine(l.text)}\n${where.length ? `\n${where.join('\n')}\n` : ''}`
  return { name, description, text }
}

function putPointer(dir: string, file: string, line: string): void {
  const path = join(dir, INDEX)
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const at = lines.findIndex((x) => x.includes(`](${file})`))
  if (at >= 0) lines[at] = line
  else lines.push(line)
  writeFileSync(path, `${lines.join('\n').replace(/\s+$/, '')}\n`)
}

function dropPointer(dir: string, file: string): void {
  const path = join(dir, INDEX)
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((x) => !x.includes(`](${file})`))
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`)
}

export class PersonalMemory {
  constructor(private readonly dirFor: (folder: string) => string = memoryDirFor) {}

  // Creates or updates the lesson's file and its pointer line in MEMORY.md. Throws when the folder is not writable.
  write(folder: string, l: Lesson): string {
    const dir = this.dirFor(folder)
    mkdirSync(dir, { recursive: true })
    const file = memoryFileName(l)
    const r = render(l)
    writeFileSync(join(dir, file), r.text)
    putPointer(dir, file, `- [${r.name}](${file}) — ${r.description}`)
    return file
  }

  remove(folder: string, l: Pick<Lesson, 'id' | 'scope'>): void {
    const dir = this.dirFor(folder)
    const file = memoryFileName(l)
    rmSync(join(dir, file), { force: true })
    dropPointer(dir, file)
  }

  // Whether the folder can be written (created when missing).
  check(folder: string): string | null {
    try {
      mkdirSync(this.dirFor(folder), { recursive: true })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  list(folder: string): MemoryFile[] {
    const dir = this.dirFor(folder)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== INDEX)
      .sort()
      .map((file) => {
        const raw = readFileSync(join(dir, file), 'utf8')
        const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
        const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m?.[1] ?? '')?.[1]?.trim() ?? ''
        return { file, name: field('name') || file, description: field('description'), type: field('type'), body: (m?.[2] ?? raw).trim() }
      })
  }
}
