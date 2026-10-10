import type { LearnAi, LearnCli, LearnSettings } from '../shared/learn'
import { listLocalModels, normalizeLocalUrl, type LocalLlmDeps } from './localllm'
import { listEfforts, listModels, type ModelList } from './models'

// Lists the catalogue of one CLI; `refresh` skips its cache.
export type ModelLister = (cli: LearnCli, refresh?: boolean) => Promise<ModelList>

// The cheap Claude model the learn step uses unless the owner picks another.
export const LEARN_MODEL = 'claude-haiku-5-5'

// What the owner sees named in the UI for an OpenCode model nobody chose: the cheapest kind a provider lists.
// Earlier groups are cheaper; a preview, a thinking variant or a non-text model never qualifies.
const CHEAP_TIERS = [/(^|[-_/.])(nano|lite)([-_.]|$)|flash-lite/i, /(^|[-_/.])mini([-_.]|$)/i, /haiku/i, /flash/i, /small/i]
const NOT_TEXT = /preview|thinking|image|embed|tts|audio|vision|realtime|moderation|reason/i

export function cheapOpencodeModel(models: readonly string[]): string | null {
  const ok = models.filter((m) => !NOT_TEXT.test(m))
  for (const tier of CHEAP_TIERS) {
    const hit = ok.find((m) => tier.test(m))
    if (hit) return hit
  }
  return null
}

const bare = (model: string): string => model.split('#')[0]!

export function notListedError(id: string): string {
  return `Model "${id}" is not in \`opencode models\`. Pick one from the list.`
}

// The catalogue, and the first of `ids` it does not list. The cached list is asked first; a missing id refreshes it once.
export async function checkOpencodeIds(ids: string[], list: ModelLister, current?: ModelList): Promise<{ all: ModelList; missing: string | null }> {
  const wanted = ids.map(bare).filter(Boolean)
  let all = current ?? (await list('opencode'))
  if (wanted.some((id) => !all.models.includes(id))) all = await list('opencode', true)
  return { all, missing: wanted.find((id) => !all.models.includes(id)) ?? null }
}

// The AI the learn step asks now: the settings with an empty model replaced by the cheap default and an effort the
// model does not offer dropped. `error` says why no model could be chosen or why the owner's choice cannot run.
export async function resolveLearnAi(s: Pick<LearnSettings, 'cli' | 'model' | 'effort'>, list: ModelLister): Promise<LearnAi> {
  const cli = s.cli
  if (cli === 'claude') {
    const model = s.model || LEARN_MODEL
    return { cli, model, effort: s.effort && listEfforts('claude', model).includes(s.effort) ? s.effort : '', isDefault: !s.model }
  }
  let all: ModelList
  try {
    all = await list(cli)
  } catch (e) {
    all = { models: [], efforts: {}, error: e instanceof Error ? e.message : String(e) }
  }
  if (cli === 'local') {
    const model = s.model || all.models[0]
    if (!model || !all.models.length) return { cli, model: s.model || null, effort: '', isDefault: true, error: all.error ?? 'The local server lists no models: load one first' }
    if (s.model && all.models.length && !all.models.includes(s.model)) return { cli, model: s.model, effort: '', isDefault: false, error: `The local server does not list the model ${s.model}` }
    return { cli, model, effort: '', isDefault: !s.model }
  }
  if (s.model) {
    const id = bare(s.model)
    const checked = await checkOpencodeIds([s.model], list, all)
    if (checked.missing) {
      const error = checked.all.models.length ? notListedError(checked.missing) : `Model "${id}" cannot be checked: ${checked.all.error ?? 'opencode listed no models'}`
      return { cli, model: s.model, effort: '', isDefault: false, error }
    }
    return { cli, model: s.model, effort: s.effort && (checked.all.efforts[id] ?? []).includes(s.effort) ? s.effort : '', isDefault: false }
  }
  const model = cheapOpencodeModel(all.models)
  if (!model) {
    return { cli, model: null, effort: '', isDefault: true, error: all.error ?? 'OpenCode lists no cheap model (flash, mini, small): pick one in Learning AI' }
  }
  return { cli, model, effort: s.effort && (all.efforts[model] ?? []).includes(s.effort) ? s.effort : '', isDefault: true }
}

// The model lists for the learn settings: the CLIs' own, or what the local server offers (the URL is read per call).
export function learnModelList(s: () => Pick<LearnSettings, 'localUrl' | 'localInsecureOk'>, local?: LocalLlmDeps): ModelLister {
  return async (cli, refresh) => {
    if (cli !== 'local') return listModels(cli, { refresh })
    const url = normalizeLocalUrl(s().localUrl, s().localInsecureOk)
    if ('error' in url) return { models: [], efforts: {}, error: url.error }
    return { ...(await listLocalModels(url.url, local)), efforts: {} }
  }
}
