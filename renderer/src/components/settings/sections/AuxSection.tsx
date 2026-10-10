import { AUX_TASKS, type AuxCli, type AuxModel, type AuxTask } from '@shared/aux-settings'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { errorText } from '@/components/memory/ui'
import { useAuxStatus, useSaveSettings, useSettings } from '@/lib/queries'
import { ModelEffortSelect } from '../ModelEffortSelect'
import { CommitInput, NumberField, Row } from '../parts'

const TASK_LABEL: Record<AuxTask, string> = {
  extraction: 'Extraction',
  consolidation: 'Consolidation',
  retrieval: 'Retrieval',
  skillEval: 'Skill evaluation',
  skillImprove: 'Skill improvement',
  compression: 'Compression',
  promptEnhance: 'Enhance prompt (Chat)',
}

const CLI_LABEL: Record<AuxCli, string> = { learn: 'Follow learn settings', claude: 'Claude Code', opencode: 'OpenCode', local: 'Local model server' }

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`

export function AuxSection() {
  const settings = useSettings()
  const status = useAuxStatus()
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null
  const a = s.aux
  const st = status.data
  const setTask = (task: AuxTask, patch: Partial<AuxModel>) => save.mutate({ auxModels: { ...s.auxModels, [task]: { ...s.auxModels[task], ...patch } } })
  const setAux = (patch: Partial<typeof a>) => save.mutate({ aux: patch })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auxiliary models</CardTitle>
          <CardDescription>
            The model each background memory and learning task asks. Follow learn settings uses the AI chosen under Learning. An empty model or effort uses the
            CLI's own default.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {AUX_TASKS.map((task) => {
            const m = s.auxModels[task]
            return (
              <Row key={task} label={TASK_LABEL[task]} htmlFor={`aux-${task}-model`}>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Select value={m.cli} onValueChange={(cli) => setTask(task, { cli: cli as AuxCli })}>
                    <SelectTrigger aria-label={`${TASK_LABEL[task]} CLI`} className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(CLI_LABEL) as AuxCli[]).map((c) => (
                        <SelectItem key={c} value={c}>
                          {CLI_LABEL[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(m.cli === 'claude' || m.cli === 'opencode') && (
                    <ModelEffortSelect
                      cli={m.cli}
                      label={TASK_LABEL[task]}
                      model={m.model}
                      effort={m.effort}
                      onChange={(model, effort) => setTask(task, { model, effort })}
                    />
                  )}
                  {m.cli === 'local' && (
                    <>
                      <CommitInput id={`aux-${task}-model`} aria-label={`${TASK_LABEL[task]} model`} placeholder="Model" className="w-44 font-mono text-xs" value={m.model} onCommit={(v) => setTask(task, { model: v })} />
                      <CommitInput id={`aux-${task}-effort`} aria-label={`${TASK_LABEL[task]} effort`} placeholder="Effort" className="w-24 font-mono text-xs" value={m.effort} onCommit={(v) => setTask(task, { effort: v })} />
                    </>
                  )}
                  {m.cli === 'local' && (
                    <CommitInput id={`aux-${task}-url`} aria-label={`${TASK_LABEL[task]} server URL`} placeholder="http://127.0.0.1:1234" className="w-56 font-mono text-xs" value={m.localUrl} onCommit={(v) => setTask(task, { localUrl: v })} />
                  )}
                </div>
              </Row>
            )
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auxiliary budget</CardTitle>
          <CardDescription>Every auxiliary call counts against these limits, per day.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Calls per day" hint="0 means no limit." htmlFor="aux-calls">
            <NumberField id="aux-calls" value={a.maxCallsPerDay} min={0} max={100000} onCommit={(n) => setAux({ maxCallsPerDay: n })} />
          </Row>
          <Row label="USD per day" hint="0 means no limit." htmlFor="aux-usd">
            <NumberField id="aux-usd" value={a.maxUsdPerDay} min={0} max={100000} onCommit={(n) => setAux({ maxUsdPerDay: n })} />
          </Row>
          <Row label="Retries" hint="0 to 5 retries after a failed call." htmlFor="aux-retry">
            <NumberField id="aux-retry" value={a.retryLimit} min={0} max={5} onCommit={(n) => setAux({ retryLimit: n })} />
          </Row>
          <Row label="Backoff" hint="Wait before a retry, in ms, 0 to 60000." htmlFor="aux-backoff">
            <NumberField id="aux-backoff" value={a.backoffMs} min={0} max={60000} onCommit={(n) => setAux({ backoffMs: n })} />
          </Row>
          <Row label="When a limit is hit" hint="Stop refuses further calls today. Confirm stops and waits for you." htmlFor="aux-onlimit">
            <Select value={a.onLimit} onValueChange={(v) => setAux({ onLimit: v as 'stop' | 'confirm' })}>
              <SelectTrigger id="aux-onlimit" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stop">Stop</SelectItem>
                <SelectItem value="confirm">Stop and confirm</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          {save.error != null && (
            <p role="alert" className="text-destructive py-3 text-xs">
              {errorText(save.error)}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today's usage</CardTitle>
          <CardDescription>{st ? st.day : 'Loading…'}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {st && (
            <>
              <Row label="Calls">
                <span className="text-sm tabular-nums">
                  {st.total.calls}
                  {st.maxCallsPerDay > 0 ? ` of ${st.maxCallsPerDay}` : ''}
                </span>
              </Row>
              <Row label="Tokens">
                <span className="text-sm tabular-nums">{st.total.tokens.toLocaleString()}</span>
              </Row>
              <Row label="Spend">
                <span className="text-sm tabular-nums">
                  {usd(st.total.usd)}
                  {st.maxUsdPerDay > 0 ? ` of ${usd(st.maxUsdPerDay)}` : ''}
                </span>
              </Row>
              {Object.entries(st.features).map(([name, u]) => (
                <Row key={name} label={name}>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {u.calls} calls · {u.tokens.toLocaleString()} tokens · {usd(u.usd)}
                  </span>
                </Row>
              ))}
              {(st.blocked || st.label) && (
                <Row label="Blocked" hint={st.blocked ?? undefined}>
                  {st.label && <Badge variant="secondary">{st.label}</Badge>}
                </Row>
              )}
              {st.lastError && (
                <p role="alert" className="text-destructive py-3 text-xs">
                  Last error: {st.lastError}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
