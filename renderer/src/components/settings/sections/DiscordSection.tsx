import { useState } from 'react'
import { Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { Crew, DiscordBotView, DiscordState, DiscordTestResult } from '@shared/types'
import { decodeIpcError } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { timeAgo } from '@/lib/format'
import {
  useApproveDiscordPairing,
  useConnectDiscordBot,
  useCrews,
  useDeleteDiscordBot,
  useDenyDiscordPairing,
  useDisconnectDiscordBot,
  useDiscordBots,
  useDiscordPairings,
  useTestDiscordBot,
  useUpdateCrew,
  useUpdateDiscordBot,
} from '@/lib/queries'
import { ConfirmDialog } from '../parts'
import { DiscordBotDialog } from './DiscordBotDialog'

type Runner = (fn: () => Promise<unknown>) => Promise<boolean>

const STATE_LABEL: Record<DiscordState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
}
const STATE_VARIANT: Record<DiscordState, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  disconnected: 'outline',
  connecting: 'secondary',
  connected: 'default',
  error: 'destructive',
}

// An editable list of ids: each can be removed, new ones are added with the field below the list.
function IdList({
  label,
  ids,
  placeholder,
  onChange,
}: {
  label: string
  ids: string[]
  placeholder: string
  onChange: (next: string[]) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const add = async () => {
    const id = draft.trim()
    if (!id) return
    if (ids.includes(id)) return setDraft('')
    if (await onChange([...ids, id])) setDraft('')
  }
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {ids.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {ids.map((id) => (
            <li key={id} className="bg-muted flex items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 font-mono text-xs">
              {id}
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={`Remove ${id} from ${label}`}
                onClick={() => void onChange(ids.filter((x) => x !== id))}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          aria-label={`Add to ${label}`}
          inputMode="numeric"
          className="h-8 max-w-xs font-mono text-xs"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <Button variant="outline" size="sm" aria-label={`Add ${label}`} disabled={!draft.trim()} onClick={() => void add()}>
          <Plus /> Add
        </Button>
      </div>
    </div>
  )
}

function Pairings({ bot, run }: { bot: DiscordBotView; run: Runner }) {
  const pairings = useDiscordPairings(bot.id)
  const approve = useApproveDiscordPairing()
  const deny = useDenyDiscordPairing()
  const list = pairings.data ?? []
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">Pairing requests</div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Refresh pairing requests for ${bot.name}`}
          onClick={() => void pairings.refetch()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          None waiting. Someone not on the allowlist who direct-messages the bot gets a code to approve here.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((p) => (
            <li key={p.code} className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate">
                {p.username} <span className="text-muted-foreground font-mono text-xs">{p.userId}</span>
                <span className="text-muted-foreground ml-2 font-mono text-xs">{p.code}</span>
                <span className="text-muted-foreground ml-2 text-xs">{timeAgo(p.createdAt)}</span>
              </span>
              <span className="flex shrink-0 gap-1.5">
                <Button size="sm" aria-label={`Approve ${p.username}`} onClick={() => void run(() => approve.mutateAsync([bot.id, p.code]))}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Deny ${p.username}`}
                  onClick={() => void run(() => deny.mutateAsync([bot.id, p.code]))}
                >
                  Deny
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TestResult({ result }: { result: DiscordTestResult }) {
  return (
    <div role="status" className="space-y-1 rounded-md border px-3 py-2 text-sm">
      <div>
        Token:{' '}
        {result.tokenValid ? (
          <span>valid{result.username && ` (${result.username})`}</span>
        ) : (
          <span className="text-destructive">not valid</span>
        )}
      </div>
      {result.tokenValid && (
        <div>
          Servers:{' '}
          {result.guilds.length === 0 ? (
            <span className="text-destructive">the bot is not in any server yet</span>
          ) : (
            result.guilds.map((g) => g.name).join(', ')
          )}
        </div>
      )}
      {result.tokenValid && (
        <div>
          Message Content intent:{' '}
          {result.intents === 'missing' ? <span className="text-destructive">off (turn it on in the Discord Developer Portal)</span> : <span>on</span>}
        </div>
      )}
      {result.channels.map((c) => (
        <div key={c.id} className={!c.found || c.missing.length > 0 ? 'text-destructive' : undefined}>
          Channel {c.name ? `#${c.name}` : c.id}
          {c.guild && ` in ${c.guild}`}:{' '}
          {!c.found ? 'the bot cannot see this channel' : c.missing.length === 0 ? 'all permissions are in place' : `missing ${c.missing.join(', ')}`}
        </div>
      ))}
      {result.error && <div className="text-destructive">{result.error}</div>}
    </div>
  )
}

function BotCard({ bot, run, onEdit, onDelete }: { bot: DiscordBotView; run: Runner; onEdit: () => void; onDelete: () => void }) {
  const update = useUpdateDiscordBot()
  const connect = useConnectDiscordBot()
  const disconnect = useDisconnectDiscordBot()
  const test = useTestDiscordBot()
  const [result, setResult] = useState<DiscordTestResult | null>(null)
  const { state, username, guilds, error } = bot.health

  const runTest = async () => {
    setResult(null)
    await run(async () => setResult(await test.mutateAsync(bot.id)))
  }

  return (
    <Card className="gap-3 py-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {bot.name}
          <Badge variant={STATE_VARIANT[state]} aria-label={`${bot.name} status: ${STATE_LABEL[state]}`}>
            {STATE_LABEL[state]}
          </Badge>
          {state === 'connected' && (
            <span className="text-muted-foreground text-xs font-normal">
              {username} in {guilds} server{guilds === 1 ? '' : 's'}
            </span>
          )}
        </CardTitle>
        {state === 'error' && error && <CardDescription className="text-destructive">{error}</CardDescription>}
        {state !== 'error' && bot.health.lastError && <CardDescription>Last error: {bot.health.lastError}</CardDescription>}
        <CardAction className="flex items-center gap-2">
          <Switch
            aria-label={`Connect ${bot.name}`}
            checked={bot.enabled}
            disabled={!bot.hasToken && !bot.enabled}
            onCheckedChange={(on) => void run(() => (on ? connect : disconnect).mutateAsync([bot.id]))}
          />
          <Button variant="outline" size="sm" aria-label={`Test ${bot.name}`} disabled={test.isPending} onClick={() => void runTest()}>
            Test
          </Button>
          <Button variant="outline" size="icon" className="size-8" aria-label={`Edit ${bot.name}`} onClick={onEdit}>
            <Pencil />
          </Button>
          <Button variant="outline" size="icon" className="size-8" aria-label={`Delete ${bot.name}`} onClick={onDelete}>
            <Trash2 />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>{bot.hasToken ? 'Token saved' : 'No token yet'}</span>
          <span>{bot.mentionOnly ? 'Answers when mentioned' : 'Answers every message'}</span>
          <span>{bot.confirmStart ? 'Confirms before starting jobs' : 'Starts jobs without confirming'}</span>
          {bot.homeChannel && <span>Home channel {bot.homeChannel}</span>}
          {bot.generalChannel && <span>General channel {bot.generalChannel}</span>}
        </div>
        {test.isPending && <p className="text-muted-foreground text-xs">Testing the connection...</p>}
        {result && <TestResult result={result} />}
        <IdList
          label="Allowlist (user IDs)"
          ids={bot.allowlist}
          placeholder="Discord user ID"
          onChange={(next) => run(() => update.mutateAsync([bot.id, { allowlist: next }]))}
        />
        <Pairings bot={bot} run={run} />
      </CardContent>
    </Card>
  )
}

function ProjectChannels({ crew, run }: { crew: Crew; run: Runner }) {
  const update = useUpdateCrew()
  return (
    <li className="space-y-2 py-3">
      <div className="text-sm">
        <span className="text-muted-foreground mr-2 font-mono text-xs">PRJ{crew.prjNumber}</span>
        {crew.name}
      </div>
      <IdList
        label={`Discord channels for ${crew.name}`}
        ids={crew.discordChannels}
        placeholder="Channel ID"
        onChange={(next) => run(() => update.mutateAsync([crew.id, { discordChannels: next }]))}
      />
    </li>
  )
}

export function DiscordSection() {
  const bots = useDiscordBots()
  const crews = useCrews()
  const remove = useDeleteDiscordBot()
  const [editing, setEditing] = useState<DiscordBotView | 'new' | null>(null)
  const [deleting, setDeleting] = useState<DiscordBotView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run: Runner = async (fn) => {
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(decodeIpcError(e).message)
      return false
    }
  }

  const list = bots.data ?? []
  const editingBot = editing && editing !== 'new' ? (list.find((b) => b.id === editing.id) ?? editing) : null

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Discord bots</CardTitle>
          <CardDescription>
            A bot is the front desk in your Discord server: it answers questions about your projects and, for people on its allowlist,
            starts jobs.
          </CardDescription>
          <CardAction>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> Add bot
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {bots.isSuccess && list.length === 0 && <p className="text-muted-foreground text-sm">No bots yet.</p>}
          {list.map((bot) => (
            <BotCard key={bot.id} bot={bot} run={run} onEdit={() => setEditing(bot)} onDelete={() => setDeleting(bot)} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project channels</CardTitle>
          <CardDescription>
            A message in one of a project's channels (or a thread under it) is about that project. Use Discord channel IDs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(crews.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No projects yet.</p>
          ) : (
            <ul className="divide-y">
              {(crews.data ?? []).map((c) => (
                <ProjectChannels key={c.id} crew={c} run={run} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {editing && <DiscordBotDialog bot={editingBot} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete bot"
        confirmLabel="Delete bot"
        busy={remove.isPending}
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          void run(() => remove.mutateAsync([deleting.id])).then((ok) => {
            if (ok) setDeleting(null)
          })
        }
      >
        {deleting && (
          <p>
            Delete {deleting.name}? It disconnects from Discord and its saved token, allowlist and pairing requests are removed. Jobs it
            already started keep running.
          </p>
        )}
      </ConfirmDialog>
    </div>
  )
}
