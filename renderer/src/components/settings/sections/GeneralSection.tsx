import { Download, Loader2, RefreshCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'
import { ModelEffortSelect } from '@/components/jobs/ModelEffortSelect'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { bridge } from '@/lib/bridge'
import { timeAgo } from '@/lib/format'
import { useAppInfo, useSaveSettings, useSettings, useUpdateStatus } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { CommitInput, Row } from '../parts'
import { UiScaleSelect } from '../UiScaleControl'
import { useState } from 'react'

function UpdateRow({ status }: { status?: UpdateStatus }) {
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try {
      await bridge().invoke('update:check')
    } finally {
      setChecking(false)
    }
  }
  const s = status
  const line = !s
    ? '…'
    : {
        idle: 'Not checked yet',
        unsupported: s.message ?? 'Updates are unavailable',
        checking: 'Checking for updates…',
        current: s.message ?? 'Operant 3 is up to date',
        downloading: `Downloading ${s.version}…`,
        ready: `Version ${s.version} is ready to install`,
        installing: `Installing ${s.version}…`,
        error: s.message ?? 'Update check failed',
      }[s.state]

  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className={cn('text-sm', s?.state === 'error' && 'text-destructive')}>{line}</div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          You have {s?.currentVersion ?? '…'}
          {s?.checkedAt ? ` · checked ${timeAgo(s.checkedAt)}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {s?.url && (
          <Button variant="ghost" size="sm" onClick={() => void bridge().invoke('app:openExternal', s.url!)}>
            Release notes
          </Button>
        )}
        {s?.state === 'ready' ? (
          <Button size="sm" onClick={() => void bridge().invoke('update:install')}>
            <Download /> Restart to update
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={check}
            disabled={checking || s?.state === 'unsupported' || s?.state === 'checking' || s?.state === 'downloading'}
          >
            {checking || s?.state === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check now
          </Button>
        )}
      </div>
    </div>
  )
}

export function GeneralSection() {
  const settings = useSettings()
  const update = useUpdateStatus()
  const info = useAppInfo()
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operators</CardTitle>
          <CardDescription>Defaults for new operators, and the shell every operator runs in.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row
            label="Main CLI"
            hint="The CLI the Master Terminal starts, and the one the Plus menu, the MCP Add dialog and new seats pick first. Each of those can still be changed where you use it. The learning AI keeps its own setting."
            htmlFor="main-cli"
          >
            <Select
              value={s.mainCli}
              onValueChange={(v) => save.mutate({ mainCli: v as 'claude' | 'opencode', mainModel: '', mainEffort: '' })}
            >
              <SelectTrigger id="main-cli" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Default model" hint="The model and effort the main CLI starts with. Leave the default to let the CLI choose. Applies to anything started from now on.">
            <ModelEffortSelect
              label="Main"
              cli={s.mainCli}
              model={s.mainModel}
              onModelChange={(v) => save.mutate(s.mainCli === 'claude' ? { mainModel: v, defaultModels: { claude: v || 'sonnet' } } : { mainModel: v })}
              effort={s.mainEffort}
              onEffortChange={(v) => save.mutate({ mainEffort: v })}
            />
          </Row>
          <Row label="Shell" hint="Leave empty for the system default. Applies to operators started from now on." htmlFor="shell">
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
          <Row
            label="Use my Claude hooks and plugins in runs"
            hint="Off: runs and short model calls skip your Claude hooks and plugins, so no console windows pop up. On: they run, but a hook that starts a console program opens a visible window, because a background run has no console of its own (Windows cannot give it a hidden one). Applies to runs started from now on; learning and the Discord front desk never use hooks."
            htmlFor="run-hooks"
          >
            <Switch
              id="run-hooks"
              checked={s.runs.useClaudeHooks}
              onCheckedChange={(v) => save.mutate({ runs: { useClaudeHooks: v } })}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Display</CardTitle>
          <CardDescription>Automatic grows the interface with the window, so a maximized screen looks as roomy as a small one. Ctrl+= and Ctrl+- step it, Ctrl+0 returns to automatic.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="UI scale" htmlFor="ui-scale">
            <UiScaleSelect id="ui-scale" className="w-36" />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Updates</CardTitle>
          <CardDescription>New versions come from GitHub releases and download in the background.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <UpdateRow status={update.data} />
          <Row label="Channel" hint="Beta also offers pre-release versions." htmlFor="channel">
            <Select value={s.updates.channel} onValueChange={(v) => save.mutate({ updates: { channel: v as 'stable' | 'beta' } })}>
              <SelectTrigger id="channel" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="beta">Beta</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Check for updates" htmlFor="interval">
            <Select value={String(s.updates.checkHours)} onValueChange={(v) => save.mutate({ updates: { checkHours: Number(v) } })}>
              <SelectTrigger id="interval" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Every hour</SelectItem>
                <SelectItem value="3">Every 3 hours</SelectItem>
                <SelectItem value="6">Every 6 hours</SelectItem>
                <SelectItem value="12">Every 12 hours</SelectItem>
                <SelectItem value="24">Once a day</SelectItem>
                <SelectItem value="0">Only at startup</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Install downloaded updates when Operant quits" htmlFor="on-quit">
            <Switch
              id="on-quit"
              checked={s.updates.installOnQuit}
              onCheckedChange={(v) => save.mutate({ updates: { installOnQuit: v } })}
            />
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
