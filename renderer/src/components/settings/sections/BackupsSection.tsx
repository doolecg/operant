import { useState } from 'react'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { BackupEntry } from '@shared/ops'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useBackups, useCreateBackup, useDeleteBackup, useRestoreBackup } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '../parts'

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const formatDate = (ms: number) => new Date(ms).toLocaleString()

type Confirm = { kind: 'restore' | 'delete'; entry: BackupEntry }

export function BackupsSection() {
  const backups = useBackups()
  const create = useCreateBackup()
  const restore = useRestoreBackup()
  const remove = useDeleteBackup()
  const [label, setLabel] = useState('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = [...(backups.data ?? [])].sort((a, b) => b.modified - a.modified)
  const lastPreUpdate = list.find((b) => b.kind === 'pre-update')

  const doCreate = async () => {
    try {
      const r = await create.mutateAsync(label.trim() ? [label.trim()] : [])
      setLabel('')
      toast(`Backup created: ${r.name} (${formatBytes(r.bytes)}).`)
    } catch (e) {
      toast(decodeIpcError(e).message, true)
    }
  }

  const doConfirm = async () => {
    if (!confirm) return
    setError(null)
    try {
      if (confirm.kind === 'delete') {
        await remove.mutateAsync([confirm.entry.name])
        toast(`Deleted ${confirm.entry.name}.`)
      } else {
        const parts = await restore.mutateAsync([confirm.entry.name, true])
        toast(parts.length > 0 ? `Restored ${parts.join(', ')} from ${confirm.entry.name}.` : `Restored ${confirm.entry.name}.`)
      }
      setConfirm(null)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backups</CardTitle>
        <CardDescription>Snapshots of your settings, presets, teams and lessons. Operant also takes one before each update.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            aria-label="Backup label"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
          />
          <Button size="sm" disabled={create.isPending} onClick={() => void doCreate()}>
            <Plus /> Create backup
          </Button>
        </div>
        {lastPreUpdate && (
          <p className="text-muted-foreground text-xs">
            Last pre-update snapshot: <span className="font-mono">{lastPreUpdate.name}</span>, {formatDate(lastPreUpdate.modified)}.
          </p>
        )}
        {backups.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">No backups yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-4 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{b.name}</span>
                    <Badge variant="secondary">{b.kind === 'pre-update' ? (b === lastPreUpdate ? 'Last pre-update snapshot' : 'Pre-update') : 'Manual'}</Badge>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {formatDate(b.modified)} · {formatBytes(b.bytes)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`Restore ${b.name}`} title="Restore" onClick={() => setConfirm({ kind: 'restore', entry: b })}>
                    <RotateCcw />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${b.name}`} title="Delete" onClick={() => setConfirm({ kind: 'delete', entry: b })}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirm != null}
        title={confirm?.kind === 'delete' ? `Delete ${confirm.entry.name}?` : `Restore ${confirm?.entry.name}?`}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete backup' : 'Restore backup'}
        busy={remove.isPending || restore.isPending}
        error={error}
        onConfirm={() => void doConfirm()}
        onClose={() => {
          setConfirm(null)
          setError(null)
        }}
      >
        {confirm?.kind === 'delete' ? (
          <p>The backup file is removed. This cannot be undone.</p>
        ) : (
          <p>Your current settings, presets, teams and lessons are replaced by the ones in this backup.</p>
        )}
      </ConfirmDialog>
    </Card>
  )
}
