import { LEARN_STORES, type LearnReview, type LearnStore } from '@shared/learn'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { STORE_LABEL, errorText } from '@/components/memory/ui'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { Row } from '../parts'

const STORE_HINT: Record<LearnStore, string> = {
  hindsight: "Writes each lesson to the project's Hindsight memory bank.",
  codegraph: "Keeps notes tagged to files and symbols, shown in a job's brief next to CodeGraph results.",
  memory: "Writes each lesson as a file in the project's personal memory folder.",
}

export function LearningSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null
  const l = s.learn

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
    </>
  )
}
