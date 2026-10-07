import { RotateCcw } from 'lucide-react'
import type { CacheTtl } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useResetSettings, useSaveSettings, useSettings } from '@/lib/queries'
import { NumberField, Row } from '../parts'

function TtlSelect({ id, value, onChange, autoLabel }: { id: string; value: CacheTtl; onChange: (v: CacheTtl) => void; autoLabel: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CacheTtl)}>
      <SelectTrigger id={id} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">{autoLabel}</SelectItem>
        <SelectItem value="5m">5 minutes</SelectItem>
        <SelectItem value="1h">1 hour</SelectItem>
      </SelectContent>
    </Select>
  )
}

export function TokensSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const reset = useResetSettings()
  const s = settings.data
  if (!s) return null
  const t = s.tokens
  const set = (patch: Partial<typeof t>) => save.mutate({ tokens: patch })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Spending limits</CardTitle>
          <CardDescription>
            Spend is estimated from operator transcripts at list prices. At a limit, operators finish their turn and then pause: no nudges, no new
            jobs. Nothing is killed mid-edit.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Daily budget (USD)" hint="All projects and scratch terminals together. 0 turns it off." htmlFor="budget">
            <NumberField
              id="budget"
              min={0}
              max={100000}
              step="0.5"
              value={s.dailyBudgetUsd}
              onCommit={(v) => save.mutate({ dailyBudgetUsd: v })}
            />
          </Row>
          <Row
            label="Default daily cap per operator (USD)"
            hint="An operator's own cap wins. 0 turns the default off."
            htmlFor="operator-cap"
          >
            <NumberField
              id="operator-cap"
              min={0}
              max={100000}
              step="0.5"
              value={t.operatorDailyCapUsd}
              onCommit={(v) => set({ operatorDailyCapUsd: v })}
            />
          </Row>
          <Row label="Warn at (% of a cap)" hint="Raises an activity event and an amber badge." htmlFor="warn-pct">
            <NumberField id="warn-pct" min={1} max={100} value={t.capWarnPct} onCommit={(v) => set({ capWarnPct: v })} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waste signals</CardTitle>
          <CardDescription>What the Cost tab flags. These only change what is reported, not what is spent.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row
            label="Cold turn threshold (%)"
            hint="A turn is cold when cache writes exceed this share of its context: the cache was rebuilt and the turn cost full price."
            htmlFor="cold-pct"
          >
            <NumberField id="cold-pct" min={1} max={100} value={t.coldThresholdPct} onCommit={(v) => set({ coldThresholdPct: v })} />
          </Row>
          <Row label="Output share warning (%)" hint="Flags an operator whose output is above this share of its cost." htmlFor="output-pct">
            <NumberField
              id="output-pct"
              min={1}
              max={100}
              value={t.outputShareWarnPct}
              onCommit={(v) => set({ outputShareWarnPct: v })}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cache and versions</CardTitle>
          <CardDescription>
            A cached prefix is read at a fraction of the normal price, but it expires. Applies to operators started or restarted from now on.
          </CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => reset.mutate('tokens')}>
              <RotateCcw /> Reset section
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="divide-y">
          <Row
            label="Default cache lifetime"
            hint="For operators whose preset says auto. Auto leaves Claude Code's own default alone. 1 hour costs more to write but survives long idle gaps."
            htmlFor="default-ttl"
          >
            <TtlSelect id="default-ttl" value={t.defaultCacheTtl} onChange={(v) => set({ defaultCacheTtl: v })} autoLabel="Auto (Claude Code default)" />
          </Row>
          <Row
            label="Sub-agent cache lifetime"
            hint="Sub-agents are short-lived, so 5 minutes avoids paying for a 1-hour write they won't reuse."
            htmlFor="sub-ttl"
          >
            <TtlSelect id="sub-ttl" value={t.subagentCacheTtl} onChange={(v) => set({ subagentCacheTtl: v })} autoLabel="Auto (not set)" />
          </Row>
          <Row
            label="Pin the Claude Code version for operators"
            hint="Stops Claude Code updating itself in an operator's terminal: an upgrade changes the prefix and rebuilds every cache. Update it yourself between runs."
            htmlFor="pin-version"
          >
            <Switch id="pin-version" checked={t.pinClaudeVersion} onCheckedChange={(v) => set({ pinClaudeVersion: v })} />
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
