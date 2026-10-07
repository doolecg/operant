import { useState } from 'react'
import type { DiscordBotView, MasterCli } from '@shared/types'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useClearDiscordToken, useCreateDiscordBot, useSetDiscordToken, useUpdateDiscordBot } from '@/lib/queries'

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
  const [token, setTokenText] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [removeToken, setRemoveToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const showTokenField = !bot || !bot.hasToken || replacing

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      const fields = { name, rules, homeChannel: home.trim(), generalChannel: general.trim(), mentionOnly, confirmStart, masterCli }
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{bot ? `Edit bot: ${bot.name}` : 'Add a Discord bot'}</DialogTitle>
          <DialogDescription>
            The bot answers in Discord as the front desk. Create it in the Discord developer portal and paste its token here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
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
