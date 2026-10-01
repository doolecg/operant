import { Mail } from 'lucide-react'
import type { CapProgress, Operator, OperatorContext, Preset } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { compact, contextWindow, usd } from '@/lib/format'
import { openDialog } from '@/lib/dialogs'
import { cn } from '@/lib/utils'
import { DEFAULT_EFFORT, EFFORTS, effortFromValue, effortValue, hasEffort, hasModel, modelOptions } from './models'
import type { OperatorActionRunner } from './OperatorActions'

// Picking another value does not save it: the change dialog shows what it would do first.
export function ModelSelect({ operator, presets, className }: { operator: Operator; presets: Preset[]; className?: string }) {
  if (!hasModel(operator)) return null
  return (
    <Select value={operator.model} onValueChange={(model) => openDialog('changeModelEffort', { operatorId: operator.id, model })}>
      <SelectTrigger size="sm" aria-label={`Model for ${operator.role}`} className={cn('h-7 w-full font-mono text-[11px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {modelOptions(operator.agent, operator.model, presets).map((m) => (
          <SelectItem key={m} value={m} className="font-mono text-xs">
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function EffortSelect({ operator, className }: { operator: Operator; className?: string }) {
  if (!hasEffort(operator)) return null
  return (
    <Select
      value={effortValue(operator.effort)}
      onValueChange={(v) => openDialog('changeModelEffort', { operatorId: operator.id, effort: effortFromValue(v) })}
    >
      <SelectTrigger size="sm" aria-label={`Effort for ${operator.role}`} title="Effort" className={cn('h-7 w-full text-[11px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_EFFORT}>default</SelectItem>
        {EFFORTS.map((e) => (
          <SelectItem key={e} value={e}>
            {e}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PresetBadge({ operator, preset, run }: { operator: Operator; preset?: Preset; run: OperatorActionRunner }) {
  if (operator.kind === 'master') return null
  if (!preset) {
    return (
      <Badge variant="outline" className="font-normal">
        custom
      </Badge>
    )
  }
  return (
    <>
      <Badge variant="secondary" className="font-normal">
        {preset.name}
      </Badge>
      {operator.modified && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${operator.role} differs from its preset: options`}
              className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400 hover:bg-amber-500/20"
            >
              modified
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => run('revert', operator)}>Revert to preset</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run('saveAsPreset', operator)}>Save as new preset</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}

export function CapBadge({ cap, warnPct }: { cap?: CapProgress; warnPct: number }) {
  if (!cap) return null
  const label = cap.paused ? 'Paused: cap' : `cap ${Math.round(cap.pct)}%`
  return (
    <Badge
      variant="outline"
      title={`${usd(cap.spentUsd)} of ${usd(cap.capUsd)} today`}
      className={cn(
        'font-normal tabular-nums',
        cap.paused ? 'border-red-500/50 text-red-400' : cap.pct >= warnPct && 'border-amber-500/50 text-amber-400',
      )}
    >
      {label}
    </Badge>
  )
}

export function UnreadBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null
  return (
    <span
      title={`${count} unread`}
      aria-label={`${count} unread messages for ${label}`}
      className="bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums"
    >
      <Mail className="size-3" /> {count}
    </span>
  )
}

// The bar fills against the operator's context cap when it has one, else against the model's window.
export function ContextBar({ context, cap, className }: { context?: OperatorContext; cap: number; className?: string }) {
  if (!context) return null
  const limit = cap > 0 ? cap : contextWindow(context.model)
  const pct = Math.min(1, context.contextTokens / limit)
  return (
    <div
      className={cn('flex items-center gap-1.5', className)}
      title={`${context.contextTokens.toLocaleString()} of ${limit.toLocaleString()} tokens in context${cap > 0 ? ' (cap)' : ''}`}
    >
      <div className="bg-muted h-1.5 w-14 overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', pct > 0.8 ? 'bg-red-400' : pct > 0.5 ? 'bg-amber-400' : 'bg-emerald-400')}
          style={{ width: `${Math.max(4, pct * 100)}%` }}
        />
      </div>
      <span className="text-muted-foreground text-[11px] tabular-nums">{compact(context.contextTokens)}</span>
    </div>
  )
}

export const hitText = (ratio: number | null | undefined) => (ratio == null ? '-' : `${Math.round(ratio * 100)}%`)

export function PausedActions({ operator, run }: { operator: Operator; run: OperatorActionRunner }) {
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" className="h-7 flex-1" onClick={() => run('raiseCap', operator)}>
        Raise cap
      </Button>
      <Button size="sm" variant="secondary" className="h-7 flex-1" onClick={() => run('stop', operator)}>
        Stop
      </Button>
    </div>
  )
}
