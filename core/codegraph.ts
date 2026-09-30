import { createRequire } from 'node:module'
import type { CodeGraph as CodeGraphClass } from '@colbymchenry/codegraph'
import type { IndexStatus } from '../shared/types'

export type { IndexStatus }

type CodeGraphStatic = typeof CodeGraphClass

// Loaded lazily, and a missing library only disables indexing, not the app. In development the npm
// SDK resolves the per-platform bundle; packaged builds pass the bundle's entry file directly.
let loaded: CodeGraphStatic | Error | null = null
function load(libraryPath?: string): CodeGraphStatic {
  if (!loaded) {
    try {
      const req = createRequire(import.meta.url ?? __filename)
      loaded = (req(libraryPath ?? '@colbymchenry/codegraph') as { CodeGraph: CodeGraphStatic }).CodeGraph
    } catch (err) {
      loaded = err instanceof Error ? err : new Error(String(err))
    }
  }
  if (loaded instanceof Error) throw loaded
  return loaded
}

// One CodeGraph index per crew folder. Indexing only happens when asked, because
// creating a .codegraph/ folder in someone's project is their decision.
export class CrewIndexes {
  private readonly indexing = new Set<string>()

  constructor(private readonly libraryPath?: string) {}

  status(folder: string): IndexStatus {
    const base = { initialized: false, indexing: this.indexing.has(folder), files: 0, symbols: 0, edges: 0 }
    try {
      const CodeGraph = load(this.libraryPath)
      if (!CodeGraph.isInitialized(folder)) return base
      const g = CodeGraph.openSync(folder, { readOnly: true })
      try {
        const s = g.getStats()
        return { ...base, initialized: true, files: s.fileCount, symbols: s.nodeCount, edges: s.edgeCount }
      } finally {
        g.close()
      }
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async index(folder: string): Promise<IndexStatus> {
    if (this.indexing.has(folder)) return this.status(folder)
    this.indexing.add(folder)
    try {
      const CodeGraph = load(this.libraryPath)
      const g = CodeGraph.isInitialized(folder) ? await CodeGraph.open(folder) : await CodeGraph.init(folder)
      try {
        await (CodeGraph.isInitialized(folder) && g.getStats().fileCount > 0 ? g.sync() : g.indexAll())
      } finally {
        g.close()
      }
    } finally {
      this.indexing.delete(folder)
    }
    return this.status(folder)
  }
}
