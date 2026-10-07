import { useState } from 'react'
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { McpServer, McpState } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useCrews, useMcpServers, useRefreshMcp, useRemoveMcp, useSetMcpEnabled } from '@/lib/queries'
import { ConfirmDialog } from '../parts'
import { McpServerDialog } from './McpServerDialog'

export const MCP_STATE_LABEL: Record<McpState, string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs auth',
  disabled: 'Disabled',
  pending: 'Needs approval',
  unknown: 'Not checked',
}
const STATE_VARIANT: Record<McpState, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  connected: 'default',
  failed: 'destructive',
  'needs-auth': 'secondary',
  disabled: 'outline',
  pending: 'secondary',
  unknown: 'outline',
}
const CLI_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' } as const
const NO_PROJECT = 'none'
const LAST_CREW = 'operant.lastCrew'

function lastCrew(): string {
  try {
    return localStorage.getItem(LAST_CREW) ?? NO_PROJECT
  } catch {
    return NO_PROJECT
  }
}

export function McpStatusBadge({ server }: { server: Pick<McpServer, 'state' | 'error'> }) {
  return (
    <div className="space-y-0.5">
      <Badge variant={STATE_VARIANT[server.state]} aria-label={`Status ${MCP_STATE_LABEL[server.state]}`}>
        {MCP_STATE_LABEL[server.state]}
      </Badge>
      {server.error && (
        <p className="text-muted-foreground max-w-56 text-[11px] leading-tight break-words" title={server.error}>
          {server.error.length > 90 ? `${server.error.slice(0, 90)}…` : server.error}
        </p>
      )}
    </div>
  )
}

// The MCP servers both CLIs can use, with live status; add, edit, enable, disable and remove for the ones in a CLI's own config.
export function McpSection() {
  const crews = useCrews()
  const [project, setProject] = useState(lastCrew)
  const crewId = project !== NO_PROJECT && crews.data?.some((c) => String(c.id) === project) ? Number(project) : null
  const servers = useMcpServers(crewId)
  const refresh = useRefreshMcp(crewId)
  const setEnabled = useSetMcpEnabled(crewId)
  const remove = useRemoveMcp(crewId)
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null)
  const [deleting, setDeleting] = useState<McpServer | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(decodeIpcError(e).message)
      return false
    }
  }
  const checking = servers.isFetching || refresh.isPending
  const list = servers.data?.servers ?? []
  const missing = servers.data ? (Object.entries(servers.data.installed) as Array<['claude' | 'opencode', boolean]>).filter(([, ok]) => !ok) : []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>MCP servers</CardTitle>
          <CardDescription>
            Read from each CLI&apos;s own config. A job whose seats pick a server that is down still starts, and its brief says which one is down.
          </CardDescription>
          <CardAction className="flex items-center gap-2">
            <Select value={crewId == null ? NO_PROJECT : String(crewId)} onValueChange={setProject}>
              <SelectTrigger aria-label="Project" className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>No project (user level)</SelectItem>
                {(crews.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled={checking} onClick={() => void run(() => refresh.mutateAsync([]))}>
              {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> Add server
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {missing.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {missing.map(([cli]) => CLI_LABEL[cli]).join(' and ')} {missing.length > 1 ? 'are' : 'is'} not installed, so its status cannot be checked.
            </p>
          )}
          {servers.isPending ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> Checking servers…
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr className="border-b">
                    <th className="py-2 pr-3 font-medium">Name</th>
                    <th className="py-2 pr-3 font-medium">CLI</th>
                    <th className="py-2 pr-3 font-medium">Scope</th>
                    <th className="py-2 pr-3 font-medium">Command or URL</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id} className="border-b align-top last:border-0">
                      <td className="py-2 pr-3 font-medium">
                        {s.name}
                        {s.builtin && <span className="text-muted-foreground ml-1.5 text-[10px] font-normal uppercase">built-in</span>}
                      </td>
                      <td className="py-2 pr-3">{CLI_LABEL[s.cli]}</td>
                      <td className="py-2 pr-3 capitalize">{s.scope}</td>
                      <td className="max-w-64 py-2 pr-3 font-mono text-xs break-all">{s.target}</td>
                      <td className="py-2 pr-3">
                        <McpStatusBadge server={s} />
                      </td>
                      <td className="py-2">
                        {s.editable && (
                          <div className="flex items-center justify-end gap-1">
                            <Switch
                              aria-label={`Enabled ${s.name}`}
                              checked={s.state !== 'disabled'}
                              onCheckedChange={(on) => void run(() => setEnabled.mutateAsync([s.id, on]))}
                            />
                            <Button variant="ghost" size="icon" className="size-7" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-7" aria-label={`Remove ${s.name}`} onClick={() => setDeleting(s)}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {editing && <McpServerDialog crewId={crewId} server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="Remove server"
        confirmLabel="Remove server"
        busy={remove.isPending}
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          void run(() => remove.mutateAsync([deleting.id])).then((ok) => {
            if (ok) setDeleting(null)
          })
        }
      >
        {deleting && (
          <p>
            Remove {deleting.name} from {CLI_LABEL[deleting.cli]} ({deleting.scope})? Seats that picked it keep the name and will report it as
            missing.
          </p>
        )}
      </ConfirmDialog>
    </div>
  )
}
