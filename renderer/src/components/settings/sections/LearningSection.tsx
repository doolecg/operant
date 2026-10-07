import { useState } from 'react'
import { LEARN_STORES, type LearnCli, type LearnReview, type LearnStore } from '@shared/learn'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { STORE_LABEL, errorText } from '@/components/memory/ui'
import { Button } from '@/components/ui/button'
import { ModelEffortSelect } from '@/components/jobs/ModelEffortSelect'
import { useLearnAi, useLocalKey, useLocalModels, useSaveSettings, useSetLocalKey, useSettings, useTestLearnAi } from '@/lib/queries'
import { CommitInput, Row } from '../parts'

const STORE_HINT: Record<LearnStore, string> = {
  hindsight: "Writes each lesson to the project's Hindsight memory bank.",
  codegraph: "Keeps notes tagged to files and symbols, shown in a job's brief next to CodeGraph results.",
  memory: "Writes each lesson as a file in the project's personal memory folder.",
}

export function LearningSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const ai = useLearnAi()
  const test = useTestLearnAi()
  const localKey = useLocalKey()
  const setKey = useSetLocalKey()
  const [keyDraft, setKeyDraft] = useState('')
  const s = settings.data
  const local = s?.learn.cli === 'local'
  const localModels = useLocalModels(s?.learn.localUrl ?? '', local)
  if (!s) return null
  const l = s.learn
  const result = test.data
  const picked = ai.data

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Learning</CardTitle>
          <CardDescription>
            When a job (or a Master conversation) ends, a cheap review step reads it and keeps the lessons worth keeping. They show up in later job briefs. See
            the Memory page to read, edit and delete them.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Learn from finished jobs" hint="Off stops the learn step and keeps lessons out of briefs." htmlFor="learn-enabled">
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
          {save.error != null && (
            <p role="alert" className="text-destructive py-3 text-xs">
              {errorText(save.error)}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Learning AI</CardTitle>
          <CardDescription>
            Which AI reads a finished job and picks the lessons. Leave the model empty for a cheap default. Every learn run (and each Test) is a real call to
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
