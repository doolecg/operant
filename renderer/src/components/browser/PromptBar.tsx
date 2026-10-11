import { useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, MessageSquare, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { promptTitle, type BrowserPrompt, type BrowserPromptAnswer } from '@shared/browser-prompts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface Props {
  // The prompt of the tab that is showing (promptForTab); nothing renders without one.
  prompt: BrowserPrompt | undefined
  // How many more prompts of this tab wait behind it.
  more?: number
  onAnswer: (id: string, answer: BrowserPromptAnswer) => void
}

const small = 'h-6 px-2 text-xs'
const field = 'h-6 w-36 px-1.5 text-xs'

// A strip under the toolbar for what the page or the network is asking: a JS dialog, a permission, a login, a bad
// certificate. Not a dialog role on purpose: useOverlayOpen would hide the native view for it.
export function PromptBar({ prompt, more = 0, onAnswer }: Props) {
  if (!prompt) return null
  return <Bar key={prompt.id} prompt={prompt} more={more} onAnswer={onAnswer} />
}

function Bar({ prompt: p, more, onAnswer }: Required<Props> & { prompt: BrowserPrompt }) {
  const [value, setValue] = useState(p.defaultValue ?? '')
  const [remember, setRemember] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const answer = (a: BrowserPromptAnswer) => onAnswer(p.id, a)
  const isDialog = p.kind === 'alert' || p.kind === 'confirm' || p.kind === 'prompt' || p.kind === 'beforeunload'
  const danger = p.kind === 'certificate'
  const Icon = danger ? ShieldAlert : p.kind === 'auth' ? KeyRound : isDialog ? MessageSquare : ShieldQuestion

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (p.kind === 'auth') answer({ username, password })
    else if (p.kind === 'prompt') answer({ allow: true, value })
    else if (isDialog) answer({ allow: true })
  }
  const cancel = () => {
    if (p.kind === 'permission') answer({ allow: false, remember })
    else if (p.kind === 'certificate') answer({ proceed: false })
    else if (p.kind === 'auth') answer({})
    else answer({ allow: false })
  }

  let body: ReactNode = null
  let buttons: ReactNode
  if (p.kind === 'permission') {
    buttons = (
      <>
        <label className="text-muted-foreground flex items-center gap-1">
          <input type="checkbox" className="accent-primary size-3" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember for this site
        </label>
        <Button type="button" size="sm" className={small} aria-label="Allow permission" onClick={() => answer({ allow: true, remember })}>
          Allow
        </Button>
        <Button type="button" size="sm" variant="outline" className={small} aria-label="Deny permission" onClick={cancel}>
          Deny
        </Button>
      </>
    )
  } else if (p.kind === 'auth') {
    buttons = (
      <>
        <Input aria-label="Username" autoComplete="off" autoFocus className={field} placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Input aria-label="Password" type="password" autoComplete="off" className={field} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" size="sm" className={small} aria-label="Sign in">
          Sign in
        </Button>
        <Button type="button" size="sm" variant="outline" className={small} aria-label="Cancel sign in" onClick={cancel}>
          Cancel
        </Button>
      </>
    )
  } else if (p.kind === 'certificate') {
    buttons = (
      <>
        <Button type="button" size="sm" className={small} aria-label="Go back, do not open this site" onClick={cancel}>
          Back
        </Button>
        <Button type="button" size="sm" variant="destructive" className={small} aria-label="Proceed anyway to this site" onClick={() => answer({ proceed: true })}>
          Proceed anyway
        </Button>
      </>
    )
  } else {
    if (p.kind === 'prompt') {
      body = <Input aria-label="Your answer" autoFocus className="h-6 w-48 px-1.5 text-xs" value={value} onChange={(e) => setValue(e.target.value)} />
    }
    buttons = (
      <>
        <Button type="submit" size="sm" className={small} aria-label={p.kind === 'beforeunload' ? 'Leave the page' : 'OK'}>
          {p.kind === 'beforeunload' ? 'Leave' : 'OK'}
        </Button>
        {p.kind !== 'alert' && (
          <Button type="button" size="sm" variant="outline" className={small} aria-label={p.kind === 'beforeunload' ? 'Stay on the page' : 'Cancel'} onClick={cancel}>
            {p.kind === 'beforeunload' ? 'Stay' : 'Cancel'}
          </Button>
        )}
      </>
    )
  }

  const title = promptTitle(p)
  const text = p.kind === 'certificate' || isDialog ? p.message : undefined
  return (
    <form
      role="group"
      aria-label={title}
      aria-live="assertive"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel()
      }}
      className={cn('mx-2 mb-1.5 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs', danger ? 'border-destructive/60 bg-destructive/10' : 'border-primary/50 bg-primary/10')}
    >
      <Icon aria-hidden className={cn('size-4 shrink-0', danger ? 'text-destructive' : 'text-primary')} />
      <div className="min-w-0 flex-1 basis-48">
        <div className="truncate font-medium" title={title}>
          {title}
          {more > 0 && <span className="text-muted-foreground font-normal"> ({more} more waiting)</span>}
        </div>
        {text && <div className="text-muted-foreground max-h-16 overflow-auto break-words whitespace-pre-wrap">{text}</div>}
      </div>
      {body}
      <div className="flex shrink-0 items-center gap-2">{buttons}</div>
    </form>
  )
}
