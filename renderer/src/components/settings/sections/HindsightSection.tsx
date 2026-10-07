import { useState } from 'react'
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react'
import type { HindsightAdapter, HindsightStatus, HindsightTestResult } from '@shared/types'
import type { HindsightMode } from '@shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorText } from '@/components/memory/ui'
import {
  useHindsightAct,
  useHindsightAdapters,
  useHindsightKeyActions,
  useHindsightKeys,
  useHindsightStatus,
  useHindsightTest,
  useSaveSettings,
  useSettings,
} from '@/lib/queries'
import { cn } from '@/lib/utils'
import { CommitInput, ConfirmDialog, NumberField, Row } from '../parts'

const URL_RE = /^https?:\/\/\S+$/i

export const MODE_LABEL: Record<HindsightMode, string> = { local: 'Local', lan: 'Shared', remote: 'Remote' }

const MODES: Array<{ id: HindsightMode; title: string; hint: string }> = [
  { id: 'local', title: 'Local', hint: 'Operant runs Hindsight on this PC, reachable from this PC only (127.0.0.1). The default.' },
  { id: 'lan', title: 'Shared', hint: 'Operant runs Hindsight on this PC bound to a network address you pick, so other machines can connect.' },
  { id: 'remote', title: 'Remote', hint: 'Hindsight runs elsewhere (a server, Docker, another PC). Operant only connects; it never starts or stops it.' },
]

const STATE_LABEL: Record<HindsightStatus['state'], string> = { running: 'Up', stopped: 'Stopped', 'no-uv': 'uv missing', error: 'Not answering' }

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? <Check /> : <Copy />} {done ? 'Copied' : 'Copy'}
    </Button>
  )
}

// The key is write-only: it is typed or generated here, stored encrypted by the app, and never read back.
function KeyField({ slot, saved, canGenerate }: { slot: 'shared' | 'remote'; saved: boolean; canGenerate: boolean }) {
  const actions = useHindsightKeyActions()
  const [draft, setDraft] = useState('')
  const [fresh, setFresh] = useState('')
  const error = actions.set.error ?? actions.clear.error ?? actions.generate.error
  const save = () =>
    actions.set.mutate({ slot, key: draft }, { onSuccess: () => { setDraft(''); setFresh('') } })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`hindsight-key-${slot}`}
          type="password"
          autoComplete="off"
          aria-label="Hindsight API key"
          className="w-72"
          placeholder={saved ? 'Key saved. Type to replace it' : slot === 'shared' ? 'API key (required to share safely)' : 'API key (optional)'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && draft.trim() && save()}
        />
        <Button variant="outline" size="sm" disabled={!draft.trim() || actions.set.isPending} onClick={save}>
          Save key
        </Button>
        {canGenerate && (
          <Button variant="outline" size="sm" disabled={actions.generate.isPending} onClick={() => actions.generate.mutate(undefined, { onSuccess: (k) => setFresh(k) })}>
            {saved ? 'Generate a new key' : 'Generate a key'}
          </Button>
        )}
        {saved && (
          <>
            <Badge variant="outline" className="text-emerald-400">
              Key saved
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => { setFresh(''); actions.clear.mutate(slot) }}>
              Remove key
            </Button>
          </>
        )}
      </div>
      {fresh && (
        <div role="status" className="bg-muted flex flex-wrap items-center gap-2 rounded-md p-2 text-xs">
          <span>New key, shown once. Copy it to the other machines now:</span>
          <code className="font-mono break-all">{fresh}</code>
          <CopyButton text={fresh} label="Copy the new API key" />
        </div>
      )}
      {error != null && (
        <p role="alert" className="text-destructive text-xs">
          {errorText(error)}
        </p>
      )}
    </div>
  )
}

function TestResult({ r }: { r: HindsightTestResult }) {
  return (
    <div role="status" aria-label="Test result" className={cn('rounded-md border p-2 text-xs', r.ok ? 'border-emerald-500/40' : 'border-destructive/50')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={r.ok ? 'text-emerald-400' : 'text-destructive'}>
          {r.ok ? 'Connected' : r.reachable ? 'Reachable, not usable' : 'Not reachable'}
        </Badge>
        <span>{r.url}</span>
        {r.reachable && <span>{r.latencyMs} ms</span>}
        {r.reachable && r.auth === 'denied' && <span>Key refused</span>}
        {r.ok && <span>{r.open ? 'Server needs no key' : 'Key required and accepted'}</span>}
        {r.info && <span>{r.info}</span>}
      </div>
      {r.error && <p className="text-destructive mt-1">{r.error}</p>}
    </div>
  )
}

function Adapters({ list, value, onChange }: { list: HindsightAdapter[]; value: string; onChange: (v: string) => void }) {
  const known = list.some((a) => a.address === value)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id="hindsight-adapter" aria-label="Network address to bind" className="w-80">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!known && <SelectItem value={value}>{value} (saved, not found on this PC)</SelectItem>}
        {list.map((a) => (
          <SelectItem key={a.address} value={a.address}>
            {a.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function HindsightSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const status = useHindsightStatus()
  const adapters = useHindsightAdapters()
  const keys = useHindsightKeys()
  const test = useHindsightTest()
  const act = useHindsightAct()
  const [urlError, setUrlError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const s = settings.data
  if (!s) return null
  const h = s.hindsight
  const list = adapters.data ?? []
  const st = status.data
  const set = (patch: Partial<typeof h>) => save.mutate({ hindsight: patch })

  const commitUrl = (v: string) => {
    const url = v.trim()
    if (url && !URL_RE.test(url)) return setUrlError('Use a full http:// or https:// address.')
    setUrlError('')
    save.mutate({ hindsight: { url }, hindsightUrl: url })
  }

  const bound = list.find((a) => a.address === h.bindHost)
  const shareIp = h.bindHost === '0.0.0.0' ? (list.find((a) => a.tailscale) ?? list.find((a) => !a.loopback && !a.all))?.address : h.bindHost
  const shareUrl = shareIp && !bound?.loopback ? `http://${shareIp}:${h.port}` : ''
  const sharedKey = keys.data?.shared ?? false
  const exposed = h.mode === 'lan' && !bound?.loopback && !sharedKey
  const modeBadge = st?.mode ? MODE_LABEL[st.mode] : MODE_LABEL[h.mode]

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Hindsight</CardTitle>
          <CardDescription>
            Where the Hindsight memory server runs. Jobs read and write project memory there, and the Memory page lists it. Changing the mode never moves the memories already
            written.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div role="group" aria-label="Hindsight status" className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">{modeBadge}</Badge>
            <Badge variant="outline" className={cn(st?.state === 'running' ? 'text-emerald-400' : 'text-destructive')}>
              {st ? STATE_LABEL[st.state] : 'Checking'}
            </Badge>
            <span className="text-muted-foreground text-xs">{st?.detail}</span>
            {st?.managed && (
              <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate(st.state === 'running' ? 'restart' : 'start')}>
                {act.isPending && <Loader2 className="animate-spin" />}
                {st.state === 'running' ? 'Restart' : 'Start'}
              </Button>
            )}
          </div>
          {st?.pendingRestart && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 p-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
              The running server may not use these shared settings (address, port or key). Restart it to apply them.
            </p>
          )}
          {act.data && act.data.state === 'error' && (
            <p role="alert" className="text-destructive text-xs">
              {act.data.detail}
            </p>
          )}

          <div role="radiogroup" aria-label="Hosting mode" className="divide-y rounded-md border">
            {MODES.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-start gap-3 p-3">
                <input
                  type="radio"
                  name="hindsight-mode"
                  className="mt-1"
                  checked={h.mode === m.id}
                  onChange={() => save.mutate({ hindsight: { mode: m.id } })}
                />
                <span>
                  <span className="text-sm font-medium">{m.title}</span>
                  <span className="text-muted-foreground block text-xs">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {h.mode === 'lan' && (
            <div className="divide-y">
              <Row label="Network address" hint="The address other machines reach this PC on. Tailscale addresses are marked." htmlFor="hindsight-adapter">
                <Adapters list={list} value={h.bindHost} onChange={(v) => set({ bindHost: v })} />
              </Row>
              {h.bindHost === '0.0.0.0' && (
                <p role="alert" className="flex items-start gap-2 py-3 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                  All adapters means every network this PC is on, including public Wi-Fi. Prefer one adapter, such as the Tailscale one.
                </p>
              )}
              <Row label="Port" htmlFor="hindsight-port" hint="Operant itself reaches the server on 127.0.0.1 at this port.">
                <NumberField id="hindsight-port" value={h.port} min={1} max={65535} className="w-28" onCommit={(v) => set({ port: v })} />
              </Row>
              <div className="space-y-2 py-3">
                <div className="text-sm">API key</div>
                <p className="text-muted-foreground text-xs">
                  Other machines send it as <code>Authorization: Bearer &lt;key&gt;</code>. The key is stored encrypted by Operant and is not shown again after it is saved.
                </p>
                <KeyField slot="shared" saved={sharedKey} canGenerate />
              </div>
              {shareUrl ? (
                <div className="space-y-1.5 py-3">
                  <div className="text-sm">Address for other machines</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="bg-muted rounded px-2 py-1 text-xs" aria-label="Address for other machines">
                      {shareUrl}
                    </code>
                    <CopyButton text={shareUrl} label="Copy the address for other machines" />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Windows Firewall may block it: allow inbound TCP on port {h.port} for this PC (a Tailscale address is usually already reachable from your other devices).
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground py-3 text-xs">{bound?.loopback ? 'On 127.0.0.1 only this PC can connect.' : 'No network address found to share.'}</p>
              )}
              {exposed && (
                <div role="alert" className="space-y-2 py-3 text-xs">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                    {h.openBind
                      ? 'No API key: anyone who can reach this address can read and write every project memory.'
                      : 'Sharing needs an API key. Set or generate one above, or allow an open server below.'}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => (h.openBind ? set({ openBind: false }) : setConfirmOpen(true))}>
                    {h.openBind ? 'Require a key again' : 'Allow without a key'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {h.mode === 'remote' && (
            <div className="divide-y">
              <div className="py-3">
                <Row label="Hindsight URL" hint="The full http:// or https:// address of the server." htmlFor="hindsight-url">
                  <CommitInput id="hindsight-url" value={h.url} placeholder="http://server:9077" className="w-72" aria-invalid={urlError !== ''} onCommit={commitUrl} />
                </Row>
                {urlError && (
                  <p role="alert" className="text-destructive text-xs">
                    {urlError}
                  </p>
                )}
              </div>
              <div className="space-y-2 py-3">
                <div className="text-sm">API key</div>
                <p className="text-muted-foreground text-xs">Sent as a Bearer header when the server requires one. Stored encrypted by Operant and not shown again.</p>
                <KeyField slot="remote" saved={keys.data?.remote ?? false} canGenerate={false} />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending && <Loader2 className="animate-spin" />}
                Test connection
              </Button>
              <span className="text-muted-foreground text-xs">Checks the saved settings.</span>
            </div>
            {test.data && <TestResult r={test.data} />}
            {test.error != null && (
              <p role="alert" className="text-destructive text-xs">
                {errorText(test.error)}
              </p>
            )}
          </div>

          {save.error != null && (
            <p role="alert" className="text-destructive text-xs">
              {errorText(save.error)}
            </p>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        title="Share Hindsight without an API key?"
        confirmLabel="Allow an open server"
        onConfirm={() => {
          set({ openBind: true })
          setConfirmOpen(false)
        }}
        onClose={() => setConfirmOpen(false)}
      >
        <p>
          Without a key, anyone who can reach {shareUrl || 'this PC on the chosen address'} can read, change and delete every project memory. Only do this on a network you trust
          completely.
        </p>
        <p>A key can be added at any time.</p>
      </ConfirmDialog>
    </>
  )
}
