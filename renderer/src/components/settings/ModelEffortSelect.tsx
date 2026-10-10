import { useEffect, useRef, useState } from 'react'
import { DEFAULT_OPTION, modelOptions } from './modelOptions'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useModels, useRefreshModels } from '@/lib/queries'
import { cn } from '@/lib/utils'

export type ModelCli = 'claude' | 'opencode'

const CUSTOM = '__custom'
// Past this many models the list gets a filter box.
const SEARCH_FROM = 24

interface Props {
  cli: ModelCli
  // Omit to keep the CLI fixed (a seat's CLI is its preset's).
  onCliChange?: (cli: ModelCli) => void
  model: string
  onModelChange?: (model: string) => void
  effort: string
  onEffortChange?: (effort: string) => void
  // Both at once, when one pick changes the model and clears the effort: one save instead of two. Used in place of the two above.
  onChange?: (model: string, effort: string) => void
  // Prefix for the field labels and ids, e.g. "Seat 2".
  label?: string
  className?: string
}

// CLI, then that CLI's models, then the chosen model's efforts (hidden when it has none). The lists come from the CLI itself.
export function ModelEffortSelect({ cli, onCliChange, model, onModelChange, effort, onEffortChange, onChange, label = '', className }: Props) {
  const models = useModels(cli)
  const { refresh, refreshing } = useRefreshModels(cli)
  const list = models.data?.models ?? []
  const efforts = models.data?.efforts[model] ?? []
  const [custom, setCustom] = useState(false)
  const prefix = label ? `${label} ` : ''
  const loaded = models.data !== undefined && !models.isFetching
  const searchable = cli === 'opencode' || list.length > SEARCH_FROM
  // A Claude model outside the list is edited as text; an OpenCode model is only ever one of the listed ones.
  const isCustom = !searchable && (custom || (loaded && model !== '' && !list.includes(model)))
  const unlisted = cli === 'opencode' && loaded && list.length > 0 && model !== '' && !list.includes(model)
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
    if (model !== '' && !list.includes(model)) commit('', '')
    else if (effort !== '' && !efforts.includes(effort)) commit(model, '')
  }, [loaded, cli])

  const commit = (nextModel: string, nextEffort: string) => {
    if (onChange) return onChange(nextModel, nextEffort)
    onModelChange?.(nextModel)
    if (nextEffort !== effort) onEffortChange?.(nextEffort)
  }

  const pickModel = (v: string) => {
    if (v === CUSTOM) {
      setCustom(true)
      return
    }
    setCustom(false)
    const next = v === DEFAULT_OPTION ? '' : v
    commit(next, effort !== '' && !(models.data?.efforts[next] ?? []).includes(effort) ? '' : effort)
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
      {searchable ? (
        <SearchSelect
          aria-label={`${prefix}model`}
          className="w-64 min-w-0 text-xs"
          placeholder={models.isFetching ? 'Loading models…' : 'Model'}
          value={model === '' ? DEFAULT_OPTION : model}
          onValueChange={pickModel}
          options={modelOptions(models.data, model)}
          onRefresh={cli === 'opencode' ? () => void refresh() : undefined}
          refreshing={refreshing}
        />
      ) : (
        <Select value={isCustom ? CUSTOM : model === '' ? DEFAULT_OPTION : model} onValueChange={pickModel}>
          <SelectTrigger aria-label={`${prefix}model`} className="w-52 min-w-0 font-mono text-xs">
            <SelectValue placeholder={models.isFetching ? 'Loading models…' : 'Model'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_OPTION}>Default model</SelectItem>
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
          onChange={(e) => commit(e.target.value, effort)}
        />
      )}
      {efforts.length > 0 && (
        <Select value={effort === '' ? DEFAULT_OPTION : effort} onValueChange={(v) => commit(model, v === DEFAULT_OPTION ? '' : v)}>
          <SelectTrigger aria-label={`${prefix}effort`} className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_OPTION}>Default effort</SelectItem>
            {efforts.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {unlisted && (
        <p role="alert" className="text-destructive basis-full text-xs">
          {model} is not in opencode models. Pick a model from the list.
        </p>
      )}
      {message && (
        <p role="alert" className="text-destructive flex basis-full items-center gap-2 text-xs">
          <span className="min-w-0 break-words">Could not load models: {message}</span>
          {cli === 'opencode' ? (
            <Button type="button" variant="outline" size="xs" disabled={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          ) : (
            <Button type="button" variant="outline" size="xs" onClick={() => void models.refetch()}>
              Retry
            </Button>
          )}
        </p>
      )}
    </div>
  )
}
