import { useEffect, useRef, useState } from 'react'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useModels } from '@/lib/queries'
import { cn } from '@/lib/utils'

export type ModelCli = 'claude' | 'opencode'

const CUSTOM = '__custom'
const DEFAULT = '__default'
// Past this many models the list gets a filter box.
const SEARCH_FROM = 24

interface Props {
  cli: ModelCli
  // Omit to keep the CLI fixed (a seat's CLI is its preset's).
  onCliChange?: (cli: ModelCli) => void
  model: string
  onModelChange: (model: string) => void
  effort: string
  onEffortChange: (effort: string) => void
  // Prefix for the field labels and ids, e.g. "Seat 2".
  label?: string
  className?: string
}

// CLI, then that CLI's models, then the chosen model's efforts (hidden when it has none). The lists come from the CLI itself.
export function ModelEffortSelect({ cli, onCliChange, model, onModelChange, effort, onEffortChange, label = '', className }: Props) {
  const models = useModels(cli)
  const list = models.data?.models ?? []
  const efforts = models.data?.efforts[model] ?? []
  const [custom, setCustom] = useState(false)
  const prefix = label ? `${label} ` : ''
  const loaded = models.data !== undefined && !models.isFetching
  const isCustom = custom || (loaded && model !== '' && !list.includes(model))
  const message = models.data?.error ?? (models.error ? decodeIpcError(models.error).message : null)

  // A new CLI reloads the list; once it arrives, a model or effort it does not offer is cleared.
  const checking = useRef(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    checking.current = true
    setCustom(false)
  }, [cli])
  useEffect(() => {
    if (!checking.current || !loaded) return
    checking.current = false
    if (model !== '' && !list.includes(model)) {
      onModelChange('')
      onEffortChange('')
    } else if (effort !== '' && !efforts.includes(effort)) onEffortChange('')
  }, [loaded, cli])

  const pickModel = (v: string) => {
    if (v === CUSTOM) {
      setCustom(true)
      return
    }
    setCustom(false)
    const next = v === DEFAULT ? '' : v
    onModelChange(next)
    if (effort !== '' && !(models.data?.efforts[next] ?? []).includes(effort)) onEffortChange('')
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {onCliChange && (
        <Select value={cli} onValueChange={(v) => onCliChange(v as ModelCli)}>
          <SelectTrigger aria-label={`${prefix}CLI`} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude Code</SelectItem>
            <SelectItem value="opencode">OpenCode</SelectItem>
          </SelectContent>
        </Select>
      )}
      {list.length > SEARCH_FROM ? (
        <SearchSelect
          aria-label={`${prefix}model`}
          className="w-52 min-w-0 font-mono text-xs"
          placeholder={models.isFetching ? 'Loading models…' : 'Model'}
          value={isCustom ? CUSTOM : model === '' ? DEFAULT : model}
          onValueChange={pickModel}
          options={[{ value: DEFAULT, label: 'Default model' }, ...list.map((m) => ({ value: m, label: m })), { value: CUSTOM, label: 'Custom id…' }]}
        />
      ) : (
        <Select value={isCustom ? CUSTOM : model === '' ? DEFAULT : model} onValueChange={pickModel}>
          <SelectTrigger aria-label={`${prefix}model`} className="w-52 min-w-0 font-mono text-xs">
            <SelectValue placeholder={models.isFetching ? 'Loading models…' : 'Model'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>Default model</SelectItem>
            {list.map((m) => (
              <SelectItem key={m} value={m} className="font-mono text-xs">
                {m}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom id…</SelectItem>
          </SelectContent>
        </Select>
      )}
      {isCustom && (
        <Input
          aria-label={`${prefix}custom model id`}
          className="w-52 font-mono text-xs"
          placeholder="model id"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
        />
      )}
      {efforts.length > 0 && (
        <Select value={effort === '' ? DEFAULT : effort} onValueChange={(v) => onEffortChange(v === DEFAULT ? '' : v)}>
          <SelectTrigger aria-label={`${prefix}effort`} className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>Default effort</SelectItem>
            {efforts.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {message && (
        <p role="alert" className="text-destructive flex basis-full items-center gap-2 text-xs">
          <span className="min-w-0 break-words">Could not load models: {message}</span>
          <Button type="button" variant="outline" size="xs" onClick={() => void models.refetch()}>
            Retry
          </Button>
        </p>
      )}
    </div>
  )
}
