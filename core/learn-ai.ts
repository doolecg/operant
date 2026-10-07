import type { LearnAi, LearnCli, LearnSettings } from '../shared/learn'
import { listLocalModels, normalizeLocalUrl, type LocalLlmDeps } from './localllm'
import { listEfforts, listModels, type ModelList } from './models'

// The cheap Claude model the learn step uses unless the owner picks another.
export const LEARN_MODEL = 'claude-haiku-4-5'

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

// The AI the learn step asks now: the settings with an empty model replaced by the cheap default and an effort the
// model does not offer dropped. `error` says why no model could be chosen or why the owner's choice cannot run.
export async function resolveLearnAi(s: Pick<LearnSettings, 'cli' | 'model' | 'effort'>, list: (cli: LearnCli) => Promise<ModelList>): Promise<LearnAi> {
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
    if (all.models.length && !all.models.includes(id)) return { cli, model: s.model, effort: '', isDefault: false, error: `OpenCode does not list the model ${id}` }
    return { cli, model: s.model, effort: s.effort && (all.efforts[id] ?? []).includes(s.effort) ? s.effort : '', isDefault: false }
  }
  const model = cheapOpencodeModel(all.models)
  if (!model) {
    return { cli, model: null, effort: '', isDefault: true, error: all.error ?? 'OpenCode lists no cheap model (flash, mini, small): pick one in Learning AI' }
  }
  return { cli, model, effort: s.effort && (all.efforts[model] ?? []).includes(s.effort) ? s.effort : '', isDefault: true }
}

// The model lists for the learn settings: the CLIs' own, or what the local server offers (the URL is read per call).
export function learnModelList(s: () => Pick<LearnSettings, 'localUrl' | 'localInsecureOk'>, local?: LocalLlmDeps): (cli: LearnCli) => Promise<ModelList> {
  return async (cli) => {
    if (cli !== 'local') return listModels(cli)
    const url = normalizeLocalUrl(s().localUrl, s().localInsecureOk)
    if ('error' in url) return { models: [], efforts: {}, error: url.error }
    return { ...(await listLocalModels(url.url, local)), efforts: {} }
  }
}
