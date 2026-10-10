import { useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { McpCli, McpScope, OptionalMcpEntry, OptionalMcpId } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAddOptionalMcp, useOptionalMcp, useRecheckOptionalMcp, useRemoveOptionalMcp } from '@/lib/queries'

const CLI_LABEL: Record<McpCli, string> = { claude: 'Claude Code', opencode: 'OpenCode' }
const SCOPES: Record<McpCli, Array<{ id: McpScope; label: string }>> = {
  claude: [
    { id: 'user', label: 'User (every project)' },
    { id: 'local', label: 'Local (this project only)' },
    { id: 'project', label: 'Project (.mcp.json, shared with the repo)' },
  ],
  opencode: [
    { id: 'global', label: 'Global' },
    { id: 'project', label: 'This project' },
  ],
}
const DEFAULT_PICKS: Record<McpCli, { on: boolean; scope: McpScope }> = {
  claude: { on: true, scope: 'user' },
  opencode: { on: false, scope: 'global' },
}
const INSTALL_HINT: Record<string, string> = { uvx: 'install uv', npx: 'install Node.js', codegraph: 'install CodeGraph' }
const STATUS_LABEL: Record<OptionalMcpEntry['status'], string> = {
  'not-added': 'Not added',
  added: 'Added by Operant',
  found: 'Found in your config',
}

// The optional servers Operant can add. Nothing is added here until the user clicks Add.
export function OptionalMcpCard({ crewId }: { crewId: number | null }) {
  const entries = useOptionalMcp(crewId)
  const add = useAddOptionalMcp(crewId)
  const remove = useRemoveOptionalMcp(crewId)
  const recheck = useRecheckOptionalMcp(crewId)
  const [adding, setAdding] = useState<OptionalMcpId | null>(null)
  const [picks, setPicks] = useState(DEFAULT_PICKS)
  const [error, setError] = useState<string | null>(null)
  const busy = add.isPending || remove.isPending || recheck.isPending

  const check = async () => {
    setError(null)
    try {
      await recheck.mutateAsync()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  const submit = async (id: OptionalMcpId) => {
    const targets = (['claude', 'opencode'] as const)
      .filter((c) => picks[c].on)
      .map((c) => ({ cli: c, scope: picks[c].scope }))
    setError(null)
    try {
      await add.mutateAsync({ id, targets })
      setAdding(null)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  const drop = async (id: OptionalMcpId) => {
    setError(null)
    try {
      await remove.mutateAsync(id)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Optional integrations</CardTitle>
        <CardDescription>
          Operant works without these. Nothing is added until you click Add.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={busy} aria-label="Check optional integrations again" onClick={() => void check()}>
            {recheck.isPending && <Loader2 className="animate-spin" />}
            Check again
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {entries.isPending ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Checking…
          </p>
        ) : (
          (entries.data ?? []).map((e) => (
            <div key={e.id} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.name}</span>
                <Badge variant={e.status === 'not-added' ? 'outline' : 'secondary'}>{STATUS_LABEL[e.status]}</Badge>
                <span className="text-muted-foreground text-[11px] uppercase">optional</span>
              </div>
              <p className="text-muted-foreground text-sm">{e.description}</p>
              <p className="text-muted-foreground text-xs">What it enables: {e.enables}</p>
              <p className="text-xs">
                {e.runtime.ok ? (
                  <span>Runs with {e.runtime.command}: found.</span>
                ) : (
                  <span className="text-destructive">
                    Needs {e.runtime.command}: {INSTALL_HINT[e.runtime.command] ?? 'install Node.js'} to add it.
                  </span>
                )}
                {e.status === 'found' && e.foundAs && (
                  <span className="text-muted-foreground block">
                    {e.provided
                      ? `${e.foundIn}: ${e.foundAs}. Operant does not add or remove it.`
                      : `Found in your config as ${e.foundAs} (${e.foundIn}). Operant did not add it.`}
                  </span>
                )}
              </p>
              {e.blocked && e.status !== 'added' && <p className="text-muted-foreground text-xs">Cannot add now: {e.blocked}</p>}

              {adding === e.id && (
                <div className="bg-muted/40 space-y-2 rounded-md p-3">
                  {(['claude', 'opencode'] as const).map((cli) => (
                    <div key={cli} className="flex flex-wrap items-center gap-3 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Add to ${CLI_LABEL[cli]}`}
                          className="size-4"
                          checked={picks[cli].on}
                          onChange={(ev) => setPicks((p) => ({ ...p, [cli]: { ...p[cli], on: ev.target.checked } }))}
                        />
                        {CLI_LABEL[cli]}
                      </label>
                      {picks[cli].on && (
                        <Select value={picks[cli].scope} onValueChange={(v) => setPicks((p) => ({ ...p, [cli]: { ...p[cli], scope: v as McpScope } }))}>
                          <SelectTrigger aria-label={`${CLI_LABEL[cli]} scope`} className="h-8 w-64 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SCOPES[cli].map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy || !(picks.claude.on || picks.opencode.on)} onClick={() => void submit(e.id)}>
                      {add.isPending && <Loader2 className="animate-spin" />}
                      Write to the chosen CLIs
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {adding !== e.id && !e.provided && (
                  <Button size="sm" variant="outline" disabled={busy || e.blocked !== null} aria-label={`Add ${e.name}`} onClick={() => setAdding(e.id)}>
                    <Plus /> Add
                  </Button>
                )}
                {e.status === 'added' && (
                  <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${e.name} added by Operant`} onClick={() => void drop(e.id)}>
                    <Trash2 /> Remove
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
