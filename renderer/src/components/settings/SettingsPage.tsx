import { useEffect, useState, type ReactNode } from 'react'
import { Download, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { DEFAULT_SETTINGS, KEY_ACTIONS, type KeyAction, type Settings } from '@shared/settings'
import type { UpdateStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { bridge } from '@/lib/bridge'
import { timeAgo } from '@/lib/format'
import { eventToAccel, formatAccel } from '@/lib/keys'
import { useAppInfo, useSaveSettings, useSettings, useUpdateStatus } from '@/lib/queries'
import { cn } from '@/lib/utils'

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-sm">
          {label}
        </Label>
        {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// A text field that saves when it loses focus or on Enter, so typing doesn't save every keystroke.
function CommitInput({
  id,
  value,
  onCommit,
  className,
  ...rest
}: { id: string; value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => draft !== value && onCommit(draft)
  return (
    <Input
      id={id}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), commit())}
      className={className}
      {...rest}
    />
  )
}

function KeyRecorder({ value, onChange }: { value: string; onChange: (accel: string) => void }) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (e.key === 'Backspace' || e.key === 'Delete') {
        onChange('')
        return setRecording(false)
      }
      const accel = eventToAccel(e)
      if (!accel) return
      onChange(accel)
      setRecording(false)
    }
    // Capture phase, so the app's own shortcuts don't fire while recording.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('min-w-36 justify-center font-mono text-xs', recording && 'border-primary text-primary')}
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
    >
      {recording ? 'Press keys…' : formatAccel(value)}
    </Button>
  )
}

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
        current: s.message ?? 'Operant 2 is up to date',
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

export function SettingsPage() {
  const settings = useSettings()
  const update = useUpdateStatus()
  const info = useAppInfo()
  const save = useSaveSettings()
  const s: Settings | undefined = settings.data

  if (!s) return <div className="text-muted-foreground p-8 text-sm">Loading settings…</div>

  const setKey = (id: KeyAction, accel: string) => {
    // One accelerator per action: taking a key from another action unbinds it there.
    const clash = KEY_ACTIONS.find((a) => a.id !== id && accel && s.keybinds[a.id] === accel)
    save.mutate({ keybinds: { [id]: accel, ...(clash ? { [clash.id]: '' } : {}) } })
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-6 p-8">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-muted-foreground text-sm">Changes apply straight away and are saved.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spending</CardTitle>
            <CardDescription>Spend is estimated from operator transcripts at list prices.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row label="Daily budget (USD)" hint="Warns in the activity feed once today's spend reaches it. 0 turns it off." htmlFor="budget">
              <CommitInput
                id="budget"
                type="number"
                min={0}
                step="0.5"
                className="w-28 text-right tabular-nums"
                value={String(s.dailyBudgetUsd)}
                onCommit={(v) => save.mutate({ dailyBudgetUsd: Number(v) || 0 })}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Operators</CardTitle>
            <CardDescription>Defaults for new operators, and the shell every operator runs in.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row label="Default Claude Code model" hint="An alias like sonnet or opus, or a full model id." htmlFor="m-claude">
              <CommitInput
                id="m-claude"
                className="w-48 font-mono"
                value={s.defaultModels.claude}
                onCommit={(v) => save.mutate({ defaultModels: { claude: v } })}
              />
            </Row>
            <Row label="Default Codex model" htmlFor="m-codex">
              <CommitInput
                id="m-codex"
                className="w-48 font-mono"
                value={s.defaultModels.codex}
                onCommit={(v) => save.mutate({ defaultModels: { codex: v } })}
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Keyboard shortcuts</CardTitle>
            <CardDescription>Click a shortcut, then press the new keys. Backspace unbinds, Esc cancels.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => save.mutate({ keybinds: DEFAULT_SETTINGS.keybinds })}>
                <RotateCcw /> Reset all
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="divide-y">
            {KEY_ACTIONS.map((a) => (
              <Row key={a.id} label={a.label}>
                <KeyRecorder value={s.keybinds[a.id]} onChange={(accel) => setKey(a.id, accel)} />
              </Row>
            ))}
          </CardContent>
        </Card>

        <p className="text-muted-foreground pb-4 text-center text-xs">Operant {info.data?.version ?? ''}</p>
      </div>
    </ScrollArea>
  )
}
