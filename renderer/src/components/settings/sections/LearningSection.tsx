import { useState } from 'react'
import { useActiveClaudeTile } from '@/components/terminal/activeClaudeTile'
import { LEARN_MODES, LEARN_STORES, type LearnChange, type LearnCli, type LearnMode, type LearnOnLimit, type LearnReview, type LearnStore } from '@shared/learn'
import { decodeIpcError } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/lib/toast'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { STORE_LABEL, errorText } from '@/components/memory/ui'
import { Button } from '@/components/ui/button'
import { ModelEffortSelect } from '@/components/settings/ModelEffortSelect'
import { useClearRecords, useLearnAi, useLearnRecords, useLocalKey, useLocalModels, useMutate, useRollbackChange, useSaveSettings, useSetLocalKey, useSettings, useTestLearnAi } from '@/lib/queries'
import { CommitInput, ConfirmDialog, NumberField, Row } from '../parts'

const STORE_HINT: Record<LearnStore, string> = {
  hindsight: "Writes each lesson to the project's Hindsight memory bank.",
  codegraph: "Keeps notes tagged to files and symbols, next to CodeGraph results.",
  memory: "Writes each lesson as a file in the project's personal memory folder.",
}

const MODE_LABEL: Record<LearnMode, string> = { off: 'Off', suggest: 'Suggest', controlled: 'Controlled', advanced: 'Advanced' }
const MODE_HINT: Record<LearnMode, string> = {
  off: 'Nothing runs.',
  suggest: 'Every lesson and draft waits for your review.',
  controlled: 'Low-risk lessons apply themselves, and can be rolled back.',
  advanced: 'Also applies skill drafts that pass validation.',
}

const fail = (e: unknown) => toast(decodeIpcError(e).message, true)

function RecordRow({ change }: { change: LearnChange }) {
  const rollback = useRollbackChange()
  return (
    <li className="space-y-1 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm">{change.proposal}</p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{change.kind}</Badge>
            <Badge variant="outline">{change.status}</Badge>
            <span>{new Date(change.at).toLocaleString()}</span>
            {change.cli && (
              <span>
                {change.cli}
                {change.model ? ` ${change.model}` : ''}
              </span>
            )}
            <span className="tabular-nums">${change.usd.toFixed(4)}</span>
          </div>
        </div>
        {change.status === 'applied' && (
          <Button variant="outline" size="sm" disabled={rollback.isPending} onClick={() => rollback.mutate([change.id], { onError: fail })}>
            Roll back
          </Button>
        )}
      </div>
      {(change.previous || change.next) && change.previous.length + change.next.length < 600 && (
        <div className="text-muted-foreground space-y-0.5 font-mono text-[11px] whitespace-pre-wrap">
          {change.previous && <p>Before: {change.previous}</p>}
          {change.next && <p>After: {change.next}</p>}
        </div>
      )}
    </li>
  )
}

function RecordsCard() {
  const records = useLearnRecords()
  const clear = useClearRecords()
  const [confirm, setConfirm] = useState(false)
  const list = records.data ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Learning records</CardTitle>
        <CardDescription>Every change the learn step proposed or made. Roll back an applied change to restore the text before it.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <p className="text-muted-foreground py-3 text-xs">{records.isPending ? 'Loading…' : 'No records yet.'}</p>
        ) : (
          <>
            <ul className="max-h-96 divide-y overflow-auto" aria-label="Learning records">
              {list.map((c) => (
                <RecordRow key={c.id} change={c} />
              ))}
            </ul>
            <div className="flex justify-end pt-3">
              <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                Clear records
              </Button>
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirm}
        title="Clear learning records?"
        confirmLabel="Clear"
        busy={clear.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => clear.mutate([], { onSuccess: () => setConfirm(false), onError: fail })}
      >
        <p>Deletes all {list.length} records. Applied changes stay, but can no longer be rolled back.</p>
      </ConfirmDialog>
    </Card>
  )
}

export function LearningSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const ai = useLearnAi()
  const test = useTestLearnAi()
  const localKey = useLocalKey()
  const setKey = useSetLocalKey()
  const [keyDraft, setKeyDraft] = useState('')
  const activeTile = useActiveClaudeTile()
  const runNow = useMutate('learn:runNow', [['learn']])
  const s = settings.data
  const local = s?.learn.cli === 'local'
  const localModels = useLocalModels(s?.learn.localUrl ?? '', local)
  if (!s) return null
  const l = s.learn
  const result = test.data
  const picked = ai.data
  // Run now needs learning on and a Claude Code tile to learn from; the reason is shown where the button is.
  const runReason = !l.enabled || l.mode === 'off' ? 'Turn learning on and pick a mode first.' : activeTile == null ? 'Open a Claude Code terminal: the learn step reads its session.' : null

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Learning</CardTitle>
          <CardDescription>
            When a Claude Code session ends, a cheap review step reads it and keeps the lessons worth keeping. See the Memory page to read, edit and
            delete them.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Learn from finished sessions" hint="Off stops the learn step and keeps lessons out of briefs." htmlFor="learn-enabled">
            <Switch id="learn-enabled" checked={l.enabled} onCheckedChange={(v) => save.mutate({ learn: { enabled: v } })} />
          </Row>
          {LEARN_STORES.map((id) => (
            <Row key={id} label={`Write to ${STORE_LABEL[id]}`} hint={STORE_HINT[id]} htmlFor={`learn-${id}`}>
              <Switch id={`learn-${id}`} disabled={!l.enabled} checked={l[id]} onCheckedChange={(v) => save.mutate({ learn: { [id]: v } })} />
            </Row>
          ))}
          <Row
            label="Review mode"
            hint="Queue (the default) holds each new lesson until you activate it on the Memory page; held lessons are not written to Hindsight, CodeGraph notes or personal memory, and not in briefs. Automatic writes lessons straight away, except any lesson that mentions a command, a link, or always / never: those are still held for review."
            htmlFor="learn-review"
          >
            <Select value={l.review} onValueChange={(v) => save.mutate({ learn: { review: v as LearnReview } })}>
              <SelectTrigger id="learn-review" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="queue">Queue for review</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Learn from the active session" hint={runReason ?? 'Runs now on the Claude Code session in the focused terminal tile.'}>
            <Button
              variant="outline"
              size="sm"
              disabled={runReason != null || runNow.isPending}
              onClick={() =>
                runNow.mutate([activeTile!, false], {
                  onSuccess: (r) => toast(r?.error || (r ? `${r.extracted} lessons found, ${r.written} written` : 'The learn step did not run'), !!r?.error),
                  onError: fail,
                })
              }
            >
              Run now
            </Button>
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
          <CardTitle className="text-base">Learning mode and budgets</CardTitle>
          <CardDescription>How much a learn run may change by itself, and the limits on one run.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Mode" hint={MODE_HINT[l.mode]} htmlFor="learn-mode">
            <Select value={l.mode} onValueChange={(v) => save.mutate({ learn: { mode: v as LearnMode } })}>
              <SelectTrigger id="learn-mode" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEARN_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Calls per review" hint="Includes validation retries." htmlFor="learn-calls">
            <NumberField id="learn-calls" value={l.maxCallsPerReview} min={1} max={50} onCommit={(n) => save.mutate({ learn: { maxCallsPerReview: n } })} />
          </Row>
          <Row label="Tokens per review" htmlFor="learn-tokens">
            <NumberField id="learn-tokens" value={l.maxTokensPerReview} min={1000} max={2000000} onCommit={(n) => save.mutate({ learn: { maxTokensPerReview: n } })} />
          </Row>
          <Row label="Changes per review" htmlFor="learn-changes">
            <NumberField id="learn-changes" value={l.maxChangesPerReview} min={1} max={100} onCommit={(n) => save.mutate({ learn: { maxChangesPerReview: n } })} />
          </Row>
          <Row label="Validation retries" htmlFor="learn-retries">
            <NumberField id="learn-retries" value={l.validationRetries} min={0} max={5} onCommit={(n) => save.mutate({ learn: { validationRetries: n } })} />
          </Row>
          <Row label="Daily USD budget" hint="0 means no cap." htmlFor="learn-usd">
            <NumberField id="learn-usd" value={l.dailyUsdBudget} min={0} max={100000} step="0.01" onCommit={(n) => save.mutate({ learn: { dailyUsdBudget: n } })} />
          </Row>
          <Row label="When a limit is hit" hint="Stop ends the run. Confirm stops it and waits for you." htmlFor="learn-onlimit">
            <Select value={l.onLimit} onValueChange={(v) => save.mutate({ learn: { onLimit: v as LearnOnLimit } })}>
              <SelectTrigger id="learn-onlimit" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stop">Stop</SelectItem>
                <SelectItem value="confirm">Stop and confirm</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Minimum user turns" hint="Shorter sessions are skipped without a model call." htmlFor="learn-turns">
            <NumberField id="learn-turns" value={l.minUserTurns} min={0} max={100} onCommit={(n) => save.mutate({ learn: { minUserTurns: n } })} />
          </Row>
          <Row label="Minimum tokens" hint="Smaller sessions are skipped without a model call." htmlFor="learn-mintokens">
            <NumberField id="learn-mintokens" value={l.minTokens} min={0} max={10000000} onCommit={(n) => save.mutate({ learn: { minTokens: n } })} />
          </Row>
        </CardContent>
      </Card>
      <RecordsCard />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Learning AI</CardTitle>
          <CardDescription>
            Which AI reads a finished session and picks the lessons. Leave the model empty for a cheap default. Every learn run (and each Test) is a real call to
            that CLI, so it uses your plan or API credit; a bigger model costs more for little gain here.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label={local ? 'AI and model' : 'CLI, model and effort'} hint="Applies to the next learn run.">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Select value={l.cli} onValueChange={(cli) => save.mutate({ learn: { cli: cli as LearnCli, model: '', effort: '' } })}>
                <SelectTrigger aria-label="Learning CLI" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude Code</SelectItem>
                  <SelectItem value="opencode">OpenCode</SelectItem>
                  <SelectItem value="local">Local model server</SelectItem>
                </SelectContent>
              </Select>
              {local ? (
                <Select value={l.model || '__first'} onValueChange={(model) => save.mutate({ learn: { model: model === '__first' ? '' : model } })}>
                  <SelectTrigger aria-label="Learning model" className="w-52 min-w-0 font-mono text-xs">
                    <SelectValue placeholder={localModels.isFetching ? 'Loading models…' : 'Model'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__first">First model the server lists</SelectItem>
                    {(localModels.data?.models ?? []).map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">
                        {m}
                      </SelectItem>
                    ))}
                    {l.model && !(localModels.data?.models ?? []).includes(l.model) && <SelectItem value={l.model}>{l.model}</SelectItem>}
                  </SelectContent>
                </Select>
              ) : (
                <ModelEffortSelect
                  label="Learning"
                  cli={l.cli as 'claude' | 'opencode'}
                  model={l.model}
                  onModelChange={(model) => save.mutate({ learn: { model } })}
                  effort={l.effort}
                  onEffortChange={(effort) => save.mutate({ learn: { effort } })}
                  className="justify-end"
                />
              )}
            </div>
          </Row>
          {local && (
            <>
              <Row label="Endpoint" hint="LM Studio is http://127.0.0.1:1234. Ollama is http://127.0.0.1:11434. Any OpenAI-compatible server works.">
                <CommitInput id="learn-local-url" aria-label="Local server endpoint" className="w-72 font-mono text-xs" value={l.localUrl} onCommit={(v) => save.mutate({ learn: { localUrl: v } })} />
              </Row>
              {localModels.data?.error && (
                <p role="alert" className="text-destructive py-2 text-xs">
                  Could not list models: {localModels.data.error}
                </p>
              )}
              <Row label="API key" hint={localKey.data ? 'A key is saved (encrypted). Leave empty to clear it.' : 'Most local servers need none.'}>
                <div className="flex items-center gap-2">
                  <Input aria-label="Local server API key" type="password" className="w-48" placeholder={localKey.data ? 'Saved' : 'None'} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
                  <Button variant="outline" size="sm" disabled={setKey.isPending || (keyDraft === '' && !localKey.data)} onClick={() => setKey.mutate([keyDraft], { onSuccess: () => setKeyDraft('') })}>
                    {keyDraft === '' ? 'Clear' : 'Save'}
                  </Button>
                </div>
              </Row>
              <Row label="Allow plain http outside my network" hint="Off refuses an http endpoint that is not on this PC or the LAN, since prompts would travel unencrypted." htmlFor="learn-local-insecure">
                <Switch id="learn-local-insecure" checked={l.localInsecureOk} onCheckedChange={(v) => save.mutate({ learn: { localInsecureOk: v } })} />
              </Row>
              <p className="text-muted-foreground py-3 text-xs">
                Small local models may extract poor lessons. Keep the review mode on Queue so you check each one before it is kept.
              </p>
            </>
          )}
          <Row
            label="Will use"
            hint={picked?.error ? undefined : picked?.isDefault ? 'The cheap default for this CLI' : 'Your choice'}
          >
            <span className={picked?.error ? 'text-destructive max-w-80 text-xs' : 'font-mono text-xs'} data-testid="learn-ai-resolved">
              {picked ? (picked.error ?? `${picked.model}${picked.effort ? ` · ${picked.effort}` : ''}`) : 'Looking up…'}
            </span>
          </Row>
          <Row label="Test" hint="Sends one tiny made-up session to the AI and reports whether it answered.">
            <div className="flex items-center gap-3">
              {result && (
                <span role="status" className={result.ok ? 'text-xs text-emerald-400' : 'text-destructive max-w-72 text-xs'} data-testid="learn-ai-result">
                  {result.ok ? `OK, ${(result.ms / 1000).toFixed(1)} s` : `Failed after ${(result.ms / 1000).toFixed(1)} s: ${result.error}`}
                </span>
              )}
              <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate([])}>
                {test.isPending ? 'Testing…' : 'Test'}
              </Button>
            </div>
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
