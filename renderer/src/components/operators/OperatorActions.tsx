import { useEffect, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { CrewTopology, Operator, OperatorPatch, Preset } from '@shared/types'
import {
  DeleteOperatorDialog,
  EditOperatorDialog,
  Field,
  FormDialog,
  errorText,
} from '@/components/dashboard/Dialogs'
import { MasterEditDialog } from '@/components/operators/MasterEditDialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { openDialog } from '@/lib/dialogs'
import { usd } from '@/lib/format'
import {
  useAction,
  useChangePlan,
  useCreateJob,
  usePresets,
  useRevertOperatorToPreset,
  useSavePresetFromOperator,
  useSendMessage,
  useUpdateOperator,
} from '@/lib/queries'

export type OperatorAction =
  | 'edit'
  | 'delete'
  | 'message'
  | 'job'
  | 'changeModel'
  | 'saveAsPreset'
  | 'revert'
  | 'raiseCap'
  | 'start'
  | 'stop'
  | 'restart'
  | 'terminal'

export type OperatorActionRunner = (action: OperatorAction, operator: Operator) => void

const textareaClass =
  'border-input bg-transparent dark:bg-input/30 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]'

// One host per view: it owns the edit/delete/message/job dialogs the card menu, the list row menu and the badges open.
export function useOperatorActions(crew: CrewTopology, onOpenOperator: (operator: Operator) => void) {
  const [active, setActive] = useState<{ action: OperatorAction; operator: Operator } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const start = useAction('operators:start')
  const stop = useAction('operators:stop')
  const restart = useAction('operators:restart')
  const startMaster = useAction('master:start')
  const stopMaster = useAction('master:stop')

  const fail = (what: string) => ({ onError: (e: unknown) => setFailure(`${what}: ${errorText(e)}`) })

  const run: OperatorActionRunner = (action, operator) => {
    const master = operator.kind === 'master'
    if (action === 'start') (master ? startMaster.mutate([crew.id], fail('Could not start')) : start.mutate([operator.id], fail('Could not start')))
    else if (action === 'stop') (master ? stopMaster.mutate([crew.id], fail('Could not stop')) : stop.mutate([operator.id], fail('Could not stop')))
    else if (action === 'restart') restart.mutate([operator.id], fail('Could not restart'))
    else if (action === 'terminal') onOpenOperator(operator)
    else if (action === 'changeModel') openDialog('changeModelEffort', { operatorId: operator.id })
    else setActive({ action, operator })
  }

  const close = () => setActive(null)
  const squads = crew.squads
  const address = (o: Operator) => `${o.role}@${crew.name}`
  const live = active ? (crew.squads.flatMap((s) => s.operators).find((o) => o.id === active.operator.id) ?? active.operator) : null

  const dialogs = (
    <>
      {active && live && (
        <>
          {active.action === 'edit' &&
            (live.kind === 'master' ? (
              <MasterEditDialog master={live} open onOpenChange={(o) => !o && close()} />
            ) : (
              <EditOperatorDialog operator={live} squads={squads} open onOpenChange={(o) => !o && close()} />
            ))}
          {active.action === 'delete' && (
            <DeleteOperatorDialog operator={live} address={address(live)} crewId={crew.id} open onOpenChange={(o) => !o && close()} />
          )}
          {active.action === 'message' && <MessageDialog crewId={crew.id} operator={live} address={address(live)} onClose={close} />}
          {active.action === 'job' && <NewJobDialog crewId={crew.id} operator={live} address={address(live)} onClose={close} />}
          {active.action === 'saveAsPreset' && <SaveAsPresetDialog operator={live} onClose={close} />}
          {active.action === 'revert' && <RevertDialog operator={live} onClose={close} />}
          {active.action === 'raiseCap' && <RaiseCapDialog operator={live} onClose={close} />}
        </>
      )}
      <FormDialog
        open={failure != null}
        onOpenChange={(o) => !o && setFailure(null)}
        title="That did not work"
        description={failure ?? ''}
        submitLabel="Close"
        canSubmit
        pending={false}
        onSubmit={() => setFailure(null)}
      />
    </>
  )

  return { run, dialogs }
}

export function OperatorMenu({
  operator,
  run,
  className,
}: {
  operator: Operator
  run: OperatorActionRunner
  className?: string
}) {
  const running = operator.status !== 'stopped'
  const master = operator.kind === 'master'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className ?? 'size-7'} aria-label={`Actions for ${operator.role}`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => run('edit', operator)}>Edit</DropdownMenuItem>
        {running ? (
          <DropdownMenuItem onSelect={() => run('stop', operator)}>Stop</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => run('start', operator)}>Start</DropdownMenuItem>
        )}
        {!master && (
          <DropdownMenuItem disabled={!running} onSelect={() => run('restart', operator)}>
            Restart
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!running} onSelect={() => run('terminal', operator)}>
          Open terminal
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run('message', operator)}>Message</DropdownMenuItem>
        {!master && <DropdownMenuItem onSelect={() => run('job', operator)}>New job for</DropdownMenuItem>}
        {!master && operator.agent !== 'shell' && (
          <DropdownMenuItem onSelect={() => run('changeModel', operator)}>Change model and effort</DropdownMenuItem>
        )}
        {!master && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => run('delete', operator)}>
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MessageDialog({ crewId, operator, address, onClose }: { crewId: number; operator: Operator; address: string; onClose: () => void }) {
  const [body, setBody] = useState('')
  const send = useSendMessage()
  const master = operator.kind === 'master'
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={master ? 'Message the Master Terminal' : `Message ${address}`}
      description="Sent as from the user. The operator reads it in its inbox."
      submitLabel="Send"
      canSubmit={!!body.trim()}
      pending={send.isPending}
      error={send.error}
      onSubmit={() => send.mutate([{ crewId, to: master ? 'master' : operator.id, body }], { onSuccess: onClose })}
    >
      <Field id="operator-message" label="Message">
        <textarea id="operator-message" rows={4} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} autoFocus />
      </Field>
    </FormDialog>
  )
}

function NewJobDialog({ crewId, operator, address, onClose }: { crewId: number; operator: Operator; address: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const create = useCreateJob()
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`New job for ${address}`}
      description="The job is assigned to this operator. More fields can be edited from the Jobs tab."
      submitLabel="Create job"
      canSubmit={!!title.trim()}
      pending={create.isPending}
      error={create.error}
      onSubmit={() => create.mutate([{ crewId, title, ...(body.trim() && { body }), for: operator.id }], { onSuccess: onClose })}
    >
      <Field id="job-title" label="Title">
        <Input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field id="job-body" label="Details" hint="The objective, files owned and the done criterion.">
        <textarea id="job-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} />
      </Field>
    </FormDialog>
  )
}

function SaveAsPresetDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const presets = usePresets()
  const base = presets.data?.find((p) => p.id === operator.presetId)?.name ?? operator.role
  const [name, setName] = useState(`${base} (custom)`)
  const save = useSavePresetFromOperator()
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save as new preset"
      description="Creates a preset from this operator's settings and role text, and links the operator to it."
      submitLabel="Save preset"
      canSubmit={!!name.trim()}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => save.mutate([operator.id, name], { onSuccess: onClose })}
    >
      <Field id="new-preset-name" label="Preset name">
        <Input id="new-preset-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </FormDialog>
  )
}

const presetPatch = (p: Preset): OperatorPatch => ({
  model: p.model,
  effort: p.effort,
  permissionMode: p.permissionMode,
  tools: p.tools,
  allow: p.allow,
  deny: p.deny,
  cacheTtl: p.cacheTtl,
  contextCap: p.contextCap,
  clearBetweenJobs: p.clearBetweenJobs,
  mcp: p.mcp,
  roleText: null,
})

function RevertDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const presets = usePresets()
  const preset = presets.data?.find((p) => p.id === operator.presetId)
  const plan = useChangePlan(preset ? operator.id : null, preset ? presetPatch(preset) : null)
  const revert = useRevertOperatorToPreset()
  const p = plan.data
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Revert to preset"
      description={preset ? `Copies the ${preset.name} preset's settings and role text back into ${operator.role}.` : 'The preset no longer exists.'}
      submitLabel={p?.requiresRestart ? 'Restart fresh and revert' : 'Revert'}
      canSubmit={!!preset && !!p}
      pending={revert.isPending}
      error={revert.error ?? plan.error}
      onSubmit={() => revert.mutate([operator.id], { onSuccess: onClose })}
    >
      {p?.requiresRestart && (
        <p className="text-sm text-amber-400">
          The operator is running, so this restarts it as a fresh session: its conversation is lost
          {p.estimateColdCostUsd != null && <> and warming the cache again costs about {usd(p.estimateColdCostUsd)}</>}.
        </p>
      )}
      {p && !p.requiresRestart && <p className="text-muted-foreground text-sm">Nothing needs a restart.</p>}
    </FormDialog>
  )
}

function RaiseCapDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const [cap, setCap] = useState('')
  const update = useUpdateOperator()
  const reset = useAction('caps:reset')
  useEffect(() => {
    setCap(operator.dailyCapUsd == null ? '' : String(Math.ceil(operator.dailyCapUsd * 1.5)))
  }, [operator.id])
  const value = cap.trim() === '' ? null : Number(cap)
  const valid = value === null || (Number.isFinite(value) && value >= 0)
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Raise the cap for ${operator.role}`}
      description="Sets this operator's daily cap in USD; empty uses the default from Settings. A paused operator resumes once it is under the cap."
      submitLabel="Raise cap"
      canSubmit={valid}
      pending={update.isPending || reset.isPending}
      error={update.error ?? reset.error}
      onSubmit={() =>
        update.mutate([operator.id, { dailyCapUsd: value }], { onSuccess: () => reset.mutate([operator.id], { onSuccess: onClose }) })
      }
    >
      <Field id="raise-cap" label="Daily cap (USD)">
        <Input id="raise-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="default" autoFocus />
      </Field>
    </FormDialog>
  )
}
