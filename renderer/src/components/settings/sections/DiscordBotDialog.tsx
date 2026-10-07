import { useState } from 'react'
import type { DiscordAiCli, DiscordAiTestResult, DiscordBotView, DiscordMirror, DiscordThreadArchive, DiscordThreadNames, MasterCli } from '@shared/types'
import { DEFAULT_DISCORD_AI } from '@shared/types'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ModelEffortSelect } from '@/components/jobs/ModelEffortSelect'
import { useClearDiscordToken, useCreateDiscordBot, useDiscordLocalModels, useSetDiscordToken, useTestDiscordAi, useUpdateDiscordBot } from '@/lib/queries'

// Adds a bot or edits one's name, token, rules, channels and reply mode. The token is write-only: a saved one is
// never shown, only replaced or removed.
export function DiscordBotDialog({ bot, onClose }: { bot: DiscordBotView | null; onClose: () => void }) {
  const create = useCreateDiscordBot()
  const update = useUpdateDiscordBot()
  const setToken = useSetDiscordToken()
  const clearToken = useClearDiscordToken()
  const [name, setName] = useState(bot?.name ?? '')
  const [rules, setRules] = useState(bot?.rules ?? '')
  const [home, setHome] = useState(bot?.homeChannel ?? '')
  const [general, setGeneral] = useState(bot?.generalChannel ?? '')
  const [mentionOnly, setMentionOnly] = useState(bot?.mentionOnly ?? true)
  const [confirmStart, setConfirmStart] = useState(bot?.confirmStart ?? true)
  const [masterCli, setMasterCli] = useState<MasterCli>(bot?.masterCli ?? 'claude')
  const [threadPerRequest, setThreadPerRequest] = useState(bot?.threadPerRequest ?? true)
  const [threadNames, setThreadNames] = useState<DiscordThreadNames>(bot?.threadNames ?? 'auto')
  const [threadArchive, setThreadArchive] = useState<DiscordThreadArchive>(bot?.threadArchive ?? 1440)
  const [mirror, setMirror] = useState<DiscordMirror>(bot?.mirror ?? 'progress')
  const [admins, setAdmins] = useState((bot?.admins ?? []).join('\n'))
  const [ai, setAi] = useState(bot?.ai ?? DEFAULT_DISCORD_AI)
  const [localModels, setLocalModels] = useState<string[]>([])
  const [aiResult, setAiResult] = useState<DiscordAiTestResult | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const loadLocal = useDiscordLocalModels()
  const testAi = useTestDiscordAi()
  const [token, setTokenText] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [removeToken, setRemoveToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const showTokenField = !bot || !bot.hasToken || replacing

  const loadModels = async () => {
    setAiError(null)
    try {
      const list = await loadLocal.mutateAsync(ai.localUrl)
      setLocalModels(list)
      if (list.length && !list.includes(ai.model)) setAi((a) => ({ ...a, model: list[0]! }))
    } catch (e) {
      setLocalModels([])
      setAiError(decodeIpcError(e).message)
    }
  }
  const runAiTest = async () => {
    setAiResult(null)
    try {
      setAiResult(await testAi.mutateAsync([bot!.id, ai]))
    } catch (e) {
      setAiResult({ ok: false, answer: '', error: decodeIpcError(e).message, ms: 0 })
    }
  }

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      const fields = { name, rules, homeChannel: home.trim(), generalChannel: general.trim(), mentionOnly, confirmStart, masterCli, threadPerRequest, threadNames, threadArchive, ai, mirror, admins: admins.split(/[\s,]+/).filter(Boolean) }
      if (!bot) {
        await create.mutateAsync([{ ...fields, ...(token.trim() ? { token: token.trim() } : {}) }])
      } else {
        await update.mutateAsync([bot.id, fields])
        if (removeToken) await clearToken.mutateAsync([bot.id])
        else if (replacing && token.trim()) await setToken.mutateAsync([bot.id, token.trim()])
      }
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{bot ? `Edit bot: ${bot.name}` : 'Add a Discord bot'}</DialogTitle>
          <DialogDescription>
            The bot answers in Discord as the front desk (home and general channels, direct messages). In a project's channel it talks to that project's Master instead; start a task there with "task: ..." or /newsolo. Create the bot in the Discord developer portal and paste its token here.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bot-name">Bot name</Label>
            <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Front desk" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-token">Bot token</Label>
            {bot?.hasToken && !replacing ? (
              <div className="flex items-center gap-2">
                <span className="text-sm">{removeToken ? 'Token will be removed' : 'Token saved'}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => (setReplacing(true), setRemoveToken(false))}>
                  Replace token
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRemoveToken((r) => !r)}>
                  {removeToken ? 'Keep token' : 'Remove token'}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id="bot-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setTokenText(e.target.value)}
                  placeholder={bot ? 'New token' : 'Paste the bot token'}
                />
                {replacing && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => (setReplacing(false), setTokenText(''))}>
                    Keep old
                  </Button>
                )}
              </div>
            )}
            {showTokenField && <p className="text-muted-foreground text-xs">Stored encrypted on this computer and never shown again.</p>}
            {bot?.health.lastError && (
              <p className="text-destructive text-xs" role="status">
                Last error: {bot.health.lastError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-rules">Rules for the front desk</Label>
            <Textarea
              id="bot-rules"
              rows={4}
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              placeholder="How the bot should talk and what it may start. Applied to every reply."
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="bot-home">Home channel ID</Label>
              <Input id="bot-home" inputMode="numeric" value={home} onChange={(e) => setHome(e.target.value)} placeholder="Where it posts status" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-general">General channel ID</Label>
              <Input id="bot-general" inputMode="numeric" value={general} onChange={(e) => setGeneral(e.target.value)} placeholder="Where it chats" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-cli">Master CLI</Label>
            <Select value={masterCli} onValueChange={(v) => setMasterCli(v as MasterCli)}>
              <SelectTrigger id="bot-cli" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">The CLI the Master runs on for jobs started from this bot.</p>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="bot-ai-cli">AI that answers in Discord</Label>
            <Select
              value={ai.cli}
              onValueChange={(v) => {
                setAi({ ...ai, cli: v as DiscordAiCli, model: '', effort: '' })
                setAiResult(null)
              }}
            >
              <SelectTrigger id="bot-ai-cli" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (costs tokens)</SelectItem>
                <SelectItem value="opencode">OpenCode (costs tokens)</SelectItem>
                <SelectItem value="local">Local model (free)</SelectItem>
              </SelectContent>
            </Select>
            {ai.cli === 'local' ? (
              <div className="space-y-2">
                <Label htmlFor="bot-ai-url">Local server address</Label>
                <div className="flex items-center gap-2">
                  <Input id="bot-ai-url" value={ai.localUrl} onChange={(e) => setAi({ ...ai, localUrl: e.target.value })} placeholder="http://127.0.0.1:1234" />
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadModels()} disabled={loadLocal.isPending}>
                    Load models
                  </Button>
                </div>
                <Label htmlFor="bot-ai-local-model">Local model</Label>
                {localModels.length > 0 ? (
                  <Select value={ai.model} onValueChange={(v) => setAi({ ...ai, model: v })}>
                    <SelectTrigger id="bot-ai-local-model" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {localModels.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="bot-ai-local-model" value={ai.model} onChange={(e) => setAi({ ...ai, model: e.target.value })} placeholder="Model name (or press Load models)" />
                )}
                <p className="text-muted-foreground text-xs">LM Studio, Ollama or llama.cpp with an OpenAI-compatible endpoint. Free: nothing is billed.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <ModelEffortSelect
                  label="Discord"
                  cli={ai.cli}
                  model={ai.model}
                  onModelChange={(model) => setAi((a) => ({ ...a, model }))}
                  effort={ai.effort}
                  onEffortChange={(effort) => setAi((a) => ({ ...a, effort }))}
                />
                <p className="text-muted-foreground text-xs">Empty model uses the cheap default. Every reply costs a few tokens.</p>
              </div>
            )}
            {aiError && (
              <p role="alert" className="text-destructive text-xs">
                {aiError}
              </p>
            )}
            {bot && (
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void runAiTest()} disabled={testAi.isPending}>
                  Test AI
                </Button>
                {aiResult && (
                  <span role="status" className={aiResult.ok ? 'text-xs' : 'text-destructive text-xs'}>
                    {aiResult.ok ? `Answered "${aiResult.answer}" in ${(aiResult.ms / 1000).toFixed(1)} s` : `Failed after ${(aiResult.ms / 1000).toFixed(1)} s: ${aiResult.error}`}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="bot-thread">Thread per request</Label>
              <p className="text-muted-foreground mt-0.5 text-xs">Each request gets its own thread and every reply goes there. Needs Create Public Threads and Send Messages in Threads.</p>
            </div>
            <Switch id="bot-thread" checked={threadPerRequest} onCheckedChange={setThreadPerRequest} />
          </div>
          {threadPerRequest && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="bot-thread-names">Thread names</Label>
                <Select value={threadNames} onValueChange={(v) => setThreadNames(v as DiscordThreadNames)}>
                  <SelectTrigger id="bot-thread-names" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">From the request (free)</SelectItem>
                    <SelectItem value="ai">Titled by the AI</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">Titled by the AI asks the bot's AI above for a few tokens per thread (free on a local model); after 10 s it falls back to the free name.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bot-thread-archive">Auto-archive after</Label>
                <Select value={String(threadArchive)} onValueChange={(v) => setThreadArchive(Number(v) as DiscordThreadArchive)}>
                  <SelectTrigger id="bot-thread-archive" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="60">1 hour</SelectItem>
                    <SelectItem value="1440">1 day</SelectItem>
                    <SelectItem value="4320">3 days</SelectItem>
                    <SelectItem value="10080">1 week</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="bot-mirror">Mirror jobs into their threads</Label>
            <Select value={mirror} onValueChange={(v) => setMirror(v as DiscordMirror)}>
              <SelectTrigger id="bot-mirror" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="results">Results only</SelectItem>
                <SelectItem value="progress">Results and progress</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Copies a job's questions, review requests, outcome and failures (and with progress, its progress lines) into its Discord thread, with buttons to answer, approve or send back. Done by Operant itself, so it costs no tokens. The Master's own chat text and tool output are never copied.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-admins">Admins (Discord user IDs)</Label>
            <Textarea id="bot-admins" rows={2} value={admins} onChange={(e) => setAdmins(e.target.value)} placeholder="One user ID per line" />
            <p className="text-muted-foreground text-xs">
              Only these users can use /stop, /restart, /sendback, the Send back button and the Master commands (/master compact, clear, cost). Everyone on the allowlist can approve and answer. Empty means only the first person on the allowlist.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="bot-mention">Answer only when mentioned</Label>
              <p className="text-muted-foreground mt-0.5 text-xs">Off answers every message in its channels. Direct messages always count.</p>
            </div>
            <Switch id="bot-mention" checked={mentionOnly} onCheckedChange={setMentionOnly} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="bot-confirm">Confirm before starting a job</Label>
              <p className="text-muted-foreground mt-0.5 text-xs">The requester reacts to confirm before a job starts.</p>
            </div>
            <Switch id="bot-confirm" checked={confirmStart} onCheckedChange={setConfirmStart} />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim()}>
            {bot ? 'Save bot' : 'Add bot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
