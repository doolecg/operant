import { useEffect, useState } from 'react'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_CREW_BROWSER, sanitizeCrewBrowser, type CertMode, type CrewBrowserOptions } from '@shared/browser-compat'
import { call, useCrews, useSaveSettings, useSettings } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { CommitInput, ConfirmDialog, Row } from '../parts'

const headersToText = (o: CrewBrowserOptions) => o.headers.map((h) => `${h.name}: ${h.value}`).join('\n')
const textToHeaders = (t: string) =>
  t
    .split('\n')
    .map((l) => {
      const i = l.indexOf(':')
      return i > 0 ? { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : null
    })
    .filter((h): h is { name: string; value: string } => h !== null)

function HeadersInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Textarea
      id="browser-headers"
      aria-label="Custom request headers"
      className="h-20 w-80 font-mono text-xs"
      spellCheck={false}
      placeholder="Name: value, one per line"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  )
}

export function BrowserSection() {
  const settings = useSettings().data
  const save = useSaveSettings()
  const crews = (useCrews().data ?? []).filter((c) => c.kind !== 'playground')
  const [crewId, setCrewId] = useState<string>('')
  const [compatId, setCompatId] = useState<string>('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const b = settings?.browser
  if (!b) return null
  const crew = crews.find((c) => String(c.id) === crewId)
  const compatCrew = crews.find((c) => String(c.id) === compatId) ?? crews[0]
  const opts: CrewBrowserOptions = compatCrew ? (b.perCrew[String(compatCrew.id)] ?? DEFAULT_CREW_BROWSER) : DEFAULT_CREW_BROWSER
  const setOpts = (patch: Partial<CrewBrowserOptions>) => {
    if (!compatCrew) return
    save.mutate({ browser: { perCrew: { ...b.perCrew, [String(compatCrew.id)]: sanitizeCrewBrowser({ ...opts, ...patch }) } } })
  }

  const clear = async () => {
    if (!crew) return
    setBusy(true)
    setError(null)
    try {
      const { cookies } = await call('browser:clearData', crew.id)
      toast(`Cleared the browser data of ${crew.name}: ${cookies} ${cookies === 1 ? 'cookie' : 'cookies'}.`)
      setConfirming(false)
    } catch (e) {
      setError(decodeIpcError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Browser</CardTitle>
          <CardDescription>Each project has its own browser tile with its own saved logins. Open it from the globe button on the project row.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Let the AI use the browser" hint="Claude tiles can open pages, click and type in the project's browser. You can take control at any time. Takes effect after restart." htmlFor="browser-ai">
            <Switch id="browser-ai" checked={b.aiControl} onCheckedChange={(v) => save.mutate({ browser: { aiControl: v } })} />
          </Row>
          <Row label="Home page" hint="Where a new browser or tab starts. Must be an http or https address." htmlFor="browser-home">
            <CommitInput id="browser-home" value={b.homeUrl} className="w-80" spellCheck={false} onCommit={(v) => save.mutate({ browser: { homeUrl: v } })} />
          </Row>
          <Row label="Search address" hint="Used for text that is not an address. %s stands for what you typed." htmlFor="browser-search">
            <CommitInput id="browser-search" value={b.searchUrl} className="w-80" spellCheck={false} onCommit={(v) => save.mutate({ browser: { searchUrl: v } })} />
          </Row>
          <Row label="AI autonomy" hint="Ask first: the AI asks you before sensitive browser actions. Full: it acts on its own." htmlFor="browser-autonomy">
            <Select value={b.autonomy} onValueChange={(v) => save.mutate({ browser: { autonomy: v === 'full' ? 'full' : 'confirm' } })}>
              <SelectTrigger id="browser-autonomy" className="w-48" aria-label="AI autonomy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="confirm">Ask first</SelectItem>
                <SelectItem value="full">Full</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Site compatibility</CardTitle>
          <CardDescription>Options for pages that need more than the defaults, set for one project at a time. They apply to open tabs straight away.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Project" htmlFor="browser-compat-project">
            <Select value={compatCrew ? String(compatCrew.id) : ''} onValueChange={setCompatId}>
              <SelectTrigger id="browser-compat-project" className="w-48" aria-label="Project for site compatibility">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {crews.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {compatCrew && (
            <>
              <Row label="Ignore certificate errors" hint="Auto only lets localhost, 127.0.0.1, ::1, .test and .local through. On accepts every bad certificate, so use it only for sites you trust." htmlFor="browser-certs">
                <Select value={opts.ignoreCertErrors} onValueChange={(v) => setOpts({ ignoreCertErrors: v as CertMode })}>
                  <SelectTrigger id="browser-certs" className="w-48" aria-label="Ignore certificate errors">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (local sites only)</SelectItem>
                    <SelectItem value="on">On (every site)</SelectItem>
                    <SelectItem value="off">Off</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Relax cross-origin checks (CORS)" hint="Lets pages in this project call APIs on other origins. For local development only; the toolbar shows a warning while it is on." htmlFor="browser-cors">
                <Switch id="browser-cors" checked={opts.relaxCors} onCheckedChange={(v) => setOpts({ relaxCors: v })} />
              </Row>
              <Row label="Proxy" hint="For example http://127.0.0.1:8080 or socks5://host:1080. Empty means no proxy." htmlFor="browser-proxy">
                <CommitInput id="browser-proxy" value={opts.proxy} className="w-80" spellCheck={false} onCommit={(v) => setOpts({ proxy: v })} />
              </Row>
              <Row label="Custom request headers" hint="Sent with every request of this project's browser. Stored in plain text." htmlFor="browser-headers">
                <HeadersInput value={headersToText(opts)} onCommit={(v) => setOpts({ headers: textToHeaders(v) })} />
              </Row>
              <Row label="User agent" hint="Empty uses a normal Chrome user agent." htmlFor="browser-ua">
                <CommitInput id="browser-ua" value={opts.userAgent} className="w-80" spellCheck={false} onCommit={(v) => setOpts({ userAgent: v })} />
              </Row>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Browser data</CardTitle>
          <CardDescription>Cookies, logins and site data are kept per project. Clearing one project leaves the others alone.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Clear browser data" hint="Signs the project out of every site." htmlFor="browser-clear-project">
            <div className="flex items-center gap-2">
              <Select value={crewId} onValueChange={setCrewId}>
                <SelectTrigger id="browser-clear-project" className="w-48" aria-label="Project">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {crews.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="destructive" size="sm" disabled={!crew} onClick={() => setConfirming(true)}>
                {crew ? `Clear browser data for ${crew.name}` : 'Clear browser data'}
              </Button>
            </div>
          </Row>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirming}
        title={`Clear browser data for ${crew?.name ?? ''}?`}
        confirmLabel="Clear"
        busy={busy}
        error={error}
        onConfirm={() => void clear()}
        onClose={() => {
          setConfirming(false)
          setError(null)
        }}
      >
        <p>Every cookie, login and saved site data of this project's browser goes, and its cache. Open tabs stay open but are signed out. The count of cookies removed is shown when it is done.</p>
      </ConfirmDialog>
    </>
  )
}
