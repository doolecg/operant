import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAppInfo, useSaveSettings, useSettings } from '@/lib/queries'
import type { ClockFormat, MediaSize } from '@shared/media'
import { Row } from '../parts'
import { UiScaleSelect } from '../UiScaleControl'

export function TopBarSection() {
  const settings = useSettings()
  const info = useAppInfo()
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null
  const t = s.topBar
  const set = (patch: Partial<typeof t>) => save.mutate({ topBar: patch })
  const windows = info.data?.platform === 'win32'

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Display</CardTitle>
          <CardDescription>The whole interface scales live: text, icons, dialogs and the terminals.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="UI scale" hint="Automatic follows the window size." htmlFor="top-ui-scale">
            <UiScaleSelect id="top-ui-scale" className="w-36" />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Media controls</CardTitle>
          <CardDescription>
            Shows what Windows is playing (Spotify, a browser tab, any media session) in the top bar, with its buttons. The bar appears only while something is playing.
            {!windows && ' Windows only: this PC does not have it.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Show media controls" htmlFor="top-media">
            <Switch id="top-media" checked={t.mediaControls} disabled={!windows} onCheckedChange={(v) => set({ mediaControls: v })} />
          </Row>
          <Row label="Size" hint="Compact shows the cover and title, and slides the controls in on hover. Full keeps every control and the artist in view." htmlFor="top-media-size">
            <Select value={t.mediaSize} onValueChange={(v) => set({ mediaSize: v as MediaSize })}>
              <SelectTrigger id="top-media-size" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clock</CardTitle>
          <CardDescription>The time pill (click it to copy the full date and time, hover for the month).</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Time format" htmlFor="top-clock-format">
            <Select value={t.clockFormat} onValueChange={(v) => set({ clockFormat: v as ClockFormat })}>
              <SelectTrigger id="top-clock-format" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Windows locale</SelectItem>
                <SelectItem value="24">24 hour</SelectItem>
                <SelectItem value="12">12 hour</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Show seconds" htmlFor="top-clock-seconds">
            <Switch id="top-clock-seconds" checked={t.clockSeconds} onCheckedChange={(v) => set({ clockSeconds: v })} />
          </Row>
          <Row label="Show the date" hint="Like Tue 7 Oct. Hidden automatically when the window is narrow." htmlFor="top-clock-date">
            <Switch id="top-clock-date" checked={t.clockDate} onCheckedChange={(v) => set({ clockDate: v })} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Panels</CardTitle>
          <CardDescription>The button and keys in the top bar (Alt+B, Alt+Z) hide the project list too. The choice is remembered.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Hide the project list" htmlFor="layout-sidebar">
            <Switch id="layout-sidebar" checked={s.layout.sidebarHidden} onCheckedChange={(v) => save.mutate({ layout: { sidebarHidden: v } })} />
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
