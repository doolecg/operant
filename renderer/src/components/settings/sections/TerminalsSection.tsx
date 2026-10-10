import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CLI_NAME, MAIN_CLIS, featureRows } from '@/lib/capabilities'
import { useAppInfo, useCapabilities, useRefreshCapabilities, useSaveSettings, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { CommitInput, Row } from '../parts'
import type { MainCli } from '@shared/settings'
import { CLAUDE_EFFORTS } from '@shared/models'

export function TerminalsSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const info = useAppInfo()
  const caps = useCapabilities()
  const refresh = useRefreshCapabilities()
  const s = settings.data
  if (!s) return null

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Terminals</CardTitle>
          <CardDescription>The CLI new terminal tiles start with, the default Claude model and the shell. Applies to terminals started from now on.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Main CLI" hint="New tiles start with this CLI. The top bar switches it too." htmlFor="main-cli">
            <Select value={s.mainCli} onValueChange={(v) => save.mutate({ mainCli: v as MainCli })}>
              <SelectTrigger id="main-cli" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAIN_CLIS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CLI_NAME[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Default Claude model" hint="The model new Claude tiles start with. Set from the last model picked on a Claude tile." htmlFor="default-model">
            <div className="flex items-center gap-2">
              <CommitInput
                id="default-model"
                className="w-64 font-mono text-xs"
                placeholder="sonnet"
                value={s.defaultModels.claude}
                onCommit={(v) => save.mutate({ defaultModels: { claude: v.trim() || 'sonnet' } })}
              />
              <Select value={s.defaultEfforts.claude || 'none'} onValueChange={(v) => save.mutate({ defaultEfforts: { claude: v === 'none' ? '' : v } })}>
                <SelectTrigger id="default-effort" aria-label="Default Claude effort" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No effort</SelectItem>
                  {CLAUDE_EFFORTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Row>
          <Row label="Shell" hint="Leave empty for the system default. Applies to terminals started from now on." htmlFor="shell">
            <CommitInput
              id="shell"
              className="w-64 font-mono text-xs"
              placeholder={info.data?.platform === 'win32' ? 'powershell.exe' : '/bin/bash'}
              value={s.shell.file}
              onCommit={(v) => save.mutate({ shell: { file: v } })}
            />
          </Row>
          <Row label="Shell arguments" htmlFor="shell-args">
            <CommitInput
              id="shell-args"
              className="w-64 font-mono text-xs"
              placeholder={info.data?.platform === 'win32' ? '-NoLogo' : '-l'}
              value={s.shell.args}
              onCommit={(v) => save.mutate({ shell: { args: v } })}
              disabled={!s.shell.file}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="text-base">CLI capabilities</CardTitle>
            <CardDescription>What Operant found on this PC. A CLI that is missing or cannot be probed is shown as not installed; the rest of the app keeps working.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw className={cn(refresh.isPending && 'animate-spin')} />
            Retry
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {caps.isError && (
            <p role="alert" className="text-destructive text-sm md:col-span-2">
              The capability check failed. Retry, or restart Operant.
            </p>
          )}
          {caps.data &&
            (['claude', 'opencode'] as const).map((id) => {
              const cap = caps.data[id]
              return (
                <div key={id} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{CLI_NAME[id]}</span>
                    {cap.installed ? (
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {cap.version ?? 'installed'}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">Not installed</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">{cap.command}</p>
                  {!cap.installed && cap.error && <p className="text-destructive text-xs">{cap.error}</p>}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    {cap.installed &&
                      featureRows(cap).map((r) => (
                        <div key={r.label} className="contents">
                          <dt className="text-muted-foreground">{r.label}</dt>
                          <dd className={r.on ? '' : 'text-muted-foreground'}>{r.value}</dd>
                        </div>
                      ))}
                  </dl>
                </div>
              )
            })}
        </CardContent>
      </Card>
    </>
  )
}
