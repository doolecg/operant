import { basename } from 'node:path'
import type { Preset, Team, ExportText } from '../shared/types'
import type { Settings } from '../shared/settings'
import { sanitizeSettings } from '../shared/settings'
import type { LearnChange, LearnStatus, Lesson, SkillDraft } from '../shared/learn'
import type { AuxStatus, BackupEntry, BackupPartName, MemoryDiagnostics, MemoryExport, PresetImportItem, RecallOutput, ResetResult, SuperpowersStatus } from '../shared/ops'
import { AUTO_PREFIX, MANUAL_PREFIX, buildBackup, deleteBackup, listBackups, pruneAuto, readBackupFile, restoreBackup, writeBackup } from './backup'
import { AuxBudget } from './aux-budget'
import type { CrewIndexes } from './codegraph'
import { detectSuperpowers } from './superpowers'
import { exportPresets, parsePresetFile } from './preset-files'
import { recallMemory } from './memory-recall'
import { exportMemory, memoryDiagnostics, resetMemory, type MemoryAdminDeps, type MemoryHindsight } from './memory-admin'
import type { LearnService } from './learn'
import type { Store } from './store'
import type { IndexStatus } from '../shared/types'

// The calls the learn, memory, aux, CodeGraph, backup, superpowers and preset-file handlers need from the app.
export interface OpsDeps {
  store: Store
  learn: LearnService
  hindsight: MemoryHindsight
  aux: AuxBudget
  indexes: CrewIndexes
  settings: () => Settings
  saveSettings: (next: Settings) => Settings
  backupDir: string
  claudeDir: string
  now: () => number
  log?: (kind: string, message: string) => void
}

export class OpsError extends Error {}

const bad = (m: string) => new OpsError(m)

export class Ops {
  constructor(private readonly d: OpsDeps) {}

  private crewFor(folder: string): { id: number; name: string; folder: string } {
    const c = this.d.store.listCrews().find((x) => x.folder === folder)
    if (!c) throw bad('That folder is not a project Operant knows')
    return c
  }

  private admin(): MemoryAdminDeps {
    const d = this.d
    return {
      learn: d.learn,
      hindsight: d.hindsight,
      crews: () => d.store.listCrews().map((c) => ({ id: c.id, name: c.name, folder: c.folder })),
      memory: () => d.settings().memory,
      learnMode: () => d.settings().learn.mode,
      aux: d.aux,
      now: d.now,
    }
  }

  // Memory

  async recall(query: string, crewId?: number): Promise<RecallOutput> {
    const folder = crewId == null ? null : (this.d.store.getCrew(crewId)?.folder ?? null)
    return recallMemory(this.d.hindsight, folder, query, this.d.settings().memory)
  }

  exportMemory(): Promise<MemoryExport> {
    return exportMemory(this.admin())
  }

  reset(req: { scope: 'soul' | 'project' | 'all'; crewId?: number; confirm: boolean }): Promise<ResetResult> {
    return resetMemory(this.admin(), req)
  }

  async diagnostics(learnStatus: LearnStatus): Promise<MemoryDiagnostics> {
    return memoryDiagnostics(this.admin(), learnStatus)
  }

  aux(): AuxStatus {
    return this.d.aux.status()
  }

  // CodeGraph: only the folder of a project Operant knows is indexed.

  codegraphStatus(folder: string): IndexStatus {
    return this.d.indexes.status(this.crewFor(folder).folder)
  }

  async codegraphRebuild(folder: string): Promise<IndexStatus> {
    const c = this.crewFor(folder)
    this.d.log?.('index', `CodeGraph rebuild started for ${c.name}`)
    const r = await this.d.indexes.rebuild(c.folder)
    this.d.log?.('index', `CodeGraph rebuilt for ${c.name}: ${r.files} files, ${r.symbols} symbols`)
    return r
  }

  // Backup

  // The whole backup: settings (memory and aux settings included, secrets never), presets, teams and learn data.
  private bundle(label: string) {
    const d = this.d
    return buildBackup(
      {
        'settings.json': d.settings(),
        'presets.json': d.store.listPresets(),
        'teams.json': d.store.listTeams(),
        'learn.json': { lessons: d.learn.lessons({}), drafts: d.learn.drafts(), changes: d.learn.changeRecords({}) },
      },
      label,
      d.now(),
    )
  }

  createBackup(label = ''): { name: string; path: string; bytes: number } {
    const path = writeBackup(this.d.backupDir, this.bundle(label || 'Manual backup'), MANUAL_PREFIX)
    const bytes = readBackupFile(this.d.backupDir, basename(path)).length
    this.d.log?.('backup', `Backup created: ${basename(path)}`)
    return { name: basename(path), path, bytes }
  }

  // Called by the updater before it installs: keeps the newest five automatic snapshots.
  snapshotBeforeUpdate(toVersion: string): string {
    const path = writeBackup(this.d.backupDir, this.bundle(`Before the update to ${toVersion}`), AUTO_PREFIX)
    const removed = pruneAuto(this.d.backupDir)
    this.d.log?.('backup', `Snapshot before update to ${toVersion}: ${basename(path)}${removed.length ? `; removed ${removed.length} older` : ''}`)
    return path
  }

  listBackups(): BackupEntry[] {
    return listBackups(this.d.backupDir)
  }

  // Verifies the file first. Refused without confirm; a checksum mismatch changes nothing.
  async restoreBackup(name: string, confirm: boolean): Promise<BackupPartName[]> {
    if (confirm !== true) throw bad('Restoring replaces your settings, presets, teams and learn data: confirm it first')
    const text = readBackupFile(this.d.backupDir, name)
    const d = this.d
    const applied = await restoreBackup(text, {
      'settings.json': (v) => {
        d.saveSettings(sanitizeSettings(v))
      },
      'presets.json': (v) => this.restorePresets(v as Preset[]),
      'teams.json': (v) => this.restoreTeams(v as Team[]),
      'learn.json': (v) => {
        const r = d.learn.restoreRecords(v as { lessons: Lesson[]; drafts: SkillDraft[]; changes: LearnChange[] })
        if (r.dropped) d.log?.('backup', `Restore left out ${r.dropped} learn rows of projects that are not here`)
      },
    })
    d.log?.('backup', `Restored ${basename(name)}: ${applied.join(', ')}`)
    return applied as BackupPartName[]
  }

  deleteBackup(name: string): void {
    deleteBackup(this.d.backupDir, name)
  }

  // Built-ins are matched by their key and get their values back; user presets are matched by name, and a user
  // preset the backup does not hold is removed.
  private restorePresets(list: Preset[]): void {
    const { store } = this.d
    const keep = new Set<number>()
    for (const p of list) {
      const values = { name: p.name, agent: p.agent, model: p.model, effort: p.effort, permissionMode: p.permissionMode, tools: p.tools, allow: p.allow, deny: p.deny, cacheTtl: p.cacheTtl, contextCap: p.contextCap, mcp: p.mcp, roleText: p.roleText }
      const existing = p.builtin ? store.getPresetByBuiltin(p.builtin) : store.listPresets().find((x) => x.builtin == null && x.name === p.name)
      if (existing) {
        keep.add(existing.id)
        store.updatePreset(existing.id, values as Parameters<Store['updatePreset']>[1])
      } else if (!p.builtin) {
        keep.add(store.createPreset(values as Parameters<Store['createPreset']>[0]).id)
      }
    }
    for (const p of store.listPresets()) if (p.builtin == null && !keep.has(p.id)) store.deletePreset(p.id)
  }

  private restoreTeams(list: Team[]): void {
    const { store } = this.d
    const keep = new Set<number>()
    for (const t of list) {
      const existing = t.builtin ? store.listTeams().find((x) => x.builtin === t.builtin) : store.listTeams().find((x) => x.builtin == null && x.name === t.name)
      if (existing) {
        keep.add(existing.id)
        store.updateTeam(existing.id, { name: t.name, rules: t.rules, description: t.description })
      } else if (!t.builtin) {
        keep.add(store.createTeam({ name: t.name, rules: t.rules, description: t.description }).id)
      }
    }
    for (const t of store.listTeams()) if (t.builtin == null && !keep.has(t.id)) store.deleteTeam(t.id)
  }

  // Superpowers

  superpowers(): SuperpowersStatus {
    return detectSuperpowers(this.d.claudeDir)
  }

  // Preset files

  presetExport(presetId?: number): ExportText {
    const { store } = this.d
    if (presetId == null) return exportPresets(store.listPresets())
    const p = store.getPreset(presetId)
    if (!p) throw bad(`Preset ${presetId} not found`)
    return exportPresets([p])
  }

  presetPreview(text: string): PresetImportItem[] {
    return parsePresetFile(text, this.d.store.listPresets().map((p) => p.name))
  }

  // Adds the presets a file holds that are not here yet; the rest are reported, not changed.
  presetImport(text: string): PresetImportItem[] {
    const items = this.presetPreview(text)
    for (const it of items) {
      if (it.action !== 'add' || !it.input) continue
      this.d.store.createPreset(it.input as Parameters<Store['createPreset']>[0])
      this.d.log?.('preset', `Preset ${it.name} imported`)
    }
    return items
  }
}
