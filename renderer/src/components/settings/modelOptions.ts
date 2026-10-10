import type { ModelList } from '@shared/models'
import type { SearchOption } from '@/components/ui/search-select'

// The value of the "Default model" option (no model chosen).
export const DEFAULT_OPTION = '__default'
export const AUTH_HINT_TEXT = 'Not connected: run `opencode auth login` in a terminal, then Refresh'

export const NOT_LISTED_GROUP = 'Not available in opencode models'

// The grouped options of an OpenCode list: friendly name with the raw id muted, "free" badge, provider headings. Only
// listed models can be picked. A saved model the list does not have stays at the top, marked, so it can be replaced.
export function modelOptions(list: ModelList | undefined, model: string): SearchOption[] {
  const out: SearchOption[] = [{ value: DEFAULT_OPTION, label: 'Default model' }]
  const ids = new Set(list?.models ?? [])
  if (model !== '' && !ids.has(model)) {
    out.push(
      ids.size > 0
        ? { value: model, label: model, group: NOT_LISTED_GROUP, groupNote: 'Replace it with a model from the list' }
        : { value: model, label: model, group: 'Saved model', groupNote: 'Cannot be checked until OpenCode lists its models' },
    )
  }
  if (list?.providers) {
    for (const p of list.providers) {
      for (const m of p.models) {
        out.push({
          value: m.id,
          label: m.name,
          detail: m.id,
          ...(m.free ? { badge: 'free' } : {}),
          group: p.providerName,
          ...(p.connected ? {} : { groupNote: AUTH_HINT_TEXT }),
        })
      }
    }
  } else for (const id of list?.models ?? []) out.push({ value: id, label: id })
  return out
}

