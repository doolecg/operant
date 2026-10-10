import { Download, Loader2, RefreshCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { bridge } from '@/lib/bridge'
import { timeAgo } from '@/lib/format'
import { useSaveSettings, useSettings, useUpdateStatus } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Row } from '../parts'
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
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null

  return (
    <>
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
          <Row label="Channel" hint="Dev also offers the test builds made from the dev branch before they are released." htmlFor="channel">
            <Select value={s.updates.channel} onValueChange={(v) => save.mutate({ updates: { channel: v as 'stable' | 'beta' } })}>
              <SelectTrigger id="channel" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="beta">Dev</SelectItem>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Closing</CardTitle>
          <CardDescription>Closing a terminal or Operant asks first when something would stop. "Don't ask again" in those dialogs turns the question off here.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Ask before closing a terminal" htmlFor="confirm-tile">
            <Switch id="confirm-tile" checked={s.confirm.closeTile} onCheckedChange={(v) => save.mutate({ confirm: { closeTile: v } })} />
          </Row>
          <Row label="Ask before closing Operant" htmlFor="confirm-app">
            <Switch id="confirm-app" checked={s.confirm.closeApp} onCheckedChange={(v) => save.mutate({ confirm: { closeApp: v } })} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
          <CardDescription>A Windows notification when Claude finishes or waits for you, shown only while you are looking at another window or tile. Clicking it opens that tile.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Notify when Claude finishes" htmlFor="notify-finished">
            <Switch id="notify-finished" checked={s.notify.finished} onCheckedChange={(v) => save.mutate({ notify: { finished: v } })} />
          </Row>
          <Row label="Notify when Claude needs me" hint="A permission request or a question." htmlFor="notify-needs">
            <Switch id="notify-needs" checked={s.notify.needs} onCheckedChange={(v) => save.mutate({ notify: { needs: v } })} />
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
