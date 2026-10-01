import { useState } from 'react'
import { Copy, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { Preset } from '@shared/types'
import { PresetEditor } from '@/components/presets/PresetEditor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  useDeletePreset,
  useDuplicatePreset,
  usePresets,
  usePresetUsage,
  useResetPreset,
  useRestoreBuiltinPresets,
  useSettings,
} from '@/lib/queries'
import { ConfirmDialog } from '../parts'

type Confirm = { kind: 'delete' | 'reset'; preset: Preset }

const summary = (p: Preset) =>
  p.agent === 'shell'
    ? 'Plain shell'
    : [p.agent === 'claude' ? p.model : `Codex ${p.model}`, p.effort && `effort ${p.effort}`, p.permissionMode, p.cacheTtl !== 'auto' && `${p.cacheTtl} cache`]
        .filter(Boolean)
        .join(' · ')

export function PresetsSection() {
  const presets = usePresets()
  const usage = usePresetUsage()
  const settings = useSettings()
  const duplicate = useDuplicatePreset()
  const remove = useDeletePreset()
  const reset = useResetPreset()
  const restore = useRestoreBuiltinPresets()
  const [editing, setEditing] = useState<Preset | 'new' | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (done) setNotice(done)
      return true
    } catch (e) {
      setError(decodeIpcError(e).message)
      return false
    }
  }

  const doDuplicate = (p: Preset) =>
    run(async () => {
      const copy = await duplicate.mutateAsync([p.id])
      setEditing(copy)
    })

  const doConfirm = async () => {
    if (!confirm) return
    const { kind, preset } = confirm
    const ok = await run(
      () => (kind === 'delete' ? remove.mutateAsync([preset.id]) : reset.mutateAsync([preset.id])),
      kind === 'delete' ? `Deleted ${preset.name}.` : `${preset.name} is back to its built-in values.`,
    )
    if (ok) setConfirm(null)
  }

  const list = presets.data ?? []
  const target = confirm ? usage.get(confirm.preset.id) : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Presets</CardTitle>
        <CardDescription>
          Launch settings and a role text for new operators. Deleting a preset keeps its operators; they show as custom.
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={restore.isPending}
            onClick={() => void run(() => restore.mutateAsync([]), 'Built-in presets restored.')}
          >
            <RotateCcw /> Restore built-ins
          </Button>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> New preset
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-muted-foreground text-sm">
            {notice}
          </p>
        )}
        {presets.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">No presets. Restore the built-ins or create one.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.map((p) => {
              const u = usage.get(p.id)
              return (
                <li key={p.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.builtin && <Badge variant="secondary">Built-in</Badge>}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">{summary(p)}</div>
                    <div className="text-muted-foreground text-xs">
                      {u ? `${u.operators} operator${u.operators === 1 ? '' : 's'}` : 'No operators'}
                      {u && u.modified > 0 ? ` · ${u.modified} modified` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${p.name}`} title="Edit" onClick={() => setEditing(p)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Duplicate ${p.name}`} title="Duplicate" onClick={() => void doDuplicate(p)}>
                      <Copy />
                    </Button>
                    {p.builtin && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Reset ${p.name} to built-in`}
                        title="Reset to built-in"
                        onClick={() => setConfirm({ kind: 'reset', preset: p })}
                      >
                        <RotateCcw />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${p.name}`}
                      title="Delete"
                      onClick={() => setConfirm({ kind: 'delete', preset: p })}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {editing && (
        <PresetEditor
          open
          preset={editing === 'new' ? null : editing}
          operators={editing === 'new' ? 0 : (usage.get(editing.id)?.operators ?? 0)}
          unmodified={editing === 'new' ? 0 : (usage.get(editing.id)?.operators ?? 0) - (usage.get(editing.id)?.modified ?? 0)}
          defaultModel={settings.data?.defaultModels.claude ?? 'sonnet'}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={confirm != null}
        title={confirm?.kind === 'delete' ? `Delete ${confirm.preset.name}?` : `Reset ${confirm?.preset.name} to built-in?`}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete preset' : 'Reset preset'}
        destructive={confirm?.kind === 'delete'}
        busy={remove.isPending || reset.isPending}
        error={error}
        onConfirm={() => void doConfirm()}
        onClose={() => {
          setConfirm(null)
          setError(null)
        }}
      >
        {confirm?.kind === 'delete' ? (
          <p>
            {u(target?.operators)} will keep their settings and role text but lose the link to this preset: they show as custom and
            nothing can revert them to it.
            {confirm.preset.builtin ? ' Restore built-ins brings it back.' : ' This cannot be undone.'}
          </p>
        ) : (
          <p>
            The launch settings and role text go back to the shipped values, replacing your edits.{' '}
            {target && target.operators > 0
              ? `${target.operators} operator${target.operators === 1 ? ' uses' : 's use'} it; they are not changed, so some may then show as modified.`
              : ''}
          </p>
        )}
      </ConfirmDialog>
    </Card>
  )
}

const u = (n = 0) => `${n} operator${n === 1 ? '' : 's'}`
