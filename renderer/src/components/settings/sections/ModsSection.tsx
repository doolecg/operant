import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import type { ModId } from '@shared/claude-mods'
import { CLAUDE_MODS } from '@/components/mods/registry'
import { useCapabilities, useSaveSettings, useSettings } from '@/lib/queries'
import { NumberField, Row } from '../parts'

export function ModsSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const caps = useCapabilities().data?.claude
  const s = settings.data
  if (!s) return null
  const m = s.claudeMods
  const setMods = (patch: Partial<typeof m>) => save.mutate({ claudeMods: patch })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claude Mods</CardTitle>
          <CardDescription>
            Mods for Claude Code tiles. Operant's Agents panel sits beside the terminal. The other mods are native Claude Code mods: Operant loads
            each enabled one into Claude Code when a tile starts. Changes apply to tiles started from now on.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Claude Mods" hint="Turns Claude Mods on or off for every Claude tile." htmlFor="mods-enabled">
            <Switch id="mods-enabled" checked={m.enabled} onCheckedChange={(v) => setMods({ enabled: v })} />
          </Row>
          <p className="text-muted-foreground py-3 text-xs">Operant's status line replaces your own inside Operant Claude tiles.</p>
        </CardContent>
      </Card>

      {CLAUDE_MODS.map((mod) => {
        const chat = mod.kind === 'chat'
        const on = chat ? (mod.id === 'commandMenu' ? m.commandMenu : m.keepWarm) : m.mods[mod.id as ModId]
        const Icon = mod.icon
        const unavailable = mod.kind === 'panel' && caps && !caps.subagentEvents && mod.id === 'subagents'
        return (
          <Card key={mod.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="text-muted-foreground size-4" aria-hidden />
                {mod.title}
              </CardTitle>
              <CardDescription>{mod.description}</CardDescription>
            </CardHeader>
            <CardContent className="divide-y">
              <Row
                label={`Enable ${mod.title}`}
                hint={
                  unavailable
                    ? 'Unavailable: this Claude Code install does not send sub-agent events.'
                    : chat
                      ? mod.id === 'commandMenu'
                        ? 'An Operant feature of the Chat view, not a Claude Code mod. Off hides the Commands button.'
                        : 'An Operant feature of the Chat view, not a Claude Code mod. Off hides /keepwarm and stops any active keep-warm.'
                      : mod.kind === 'panel'
                        ? "Operant's own panel. Uses Operant's hook events; no model calls."
                        : 'A native Claude Code mod (plugin/mods/' + mod.id + '). Loaded into Claude Code when a tile starts.'
                }
                htmlFor={`mod-${mod.id}`}
              >
                <Switch id={`mod-${mod.id}`} checked={on} disabled={(!chat && !m.enabled) || !!unavailable} onCheckedChange={(v) => (chat ? setMods(mod.id === 'commandMenu' ? { commandMenu: v } : { keepWarm: v }) : setMods({ mods: { ...m.mods, [mod.id as ModId]: v } }))} />
              </Row>
            </CardContent>
          </Card>
        )
      })}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tile info bar</CardTitle>
          <CardDescription>
            The thin row under each terminal tile: model, context, tokens, cost, folder and branch. A value Operant cannot observe shows as n/a.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Show the info bar" htmlFor="info-bar">
            <Switch id="info-bar" checked={s.infoBar} onCheckedChange={(v) => save.mutate({ infoBar: v })} />
          </Row>
          <Row label="Context warning" hint="The context bar turns amber from this percent (1 to 100)." htmlFor="context-warn">
            <NumberField id="context-warn" value={s.contextWarnPct} min={1} max={100} onCommit={(n) => save.mutate({ contextWarnPct: n })} />
          </Row>
          <Row label="Context danger" hint="The context bar turns red from this percent (1 to 100)." htmlFor="context-danger">
            <NumberField id="context-danger" value={s.contextDangerPct} min={1} max={100} onCommit={(n) => save.mutate({ contextDangerPct: n })} />
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
