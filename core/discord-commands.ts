// Discord application commands, buttons and modals for the Master's channel. Everything here is handled by code: no model
// is ever asked, and nothing from Discord is typed into a session except the fixed lines the Master gate owns.
import type { ApprovedBy, Crew, DiscordBot, MasterCli, Run, RunEvent, RunInput } from '../shared/types'
import type { ButtonDef, CommandDef, GatewayInteraction } from './discord-gateway'
import { findProject, projectLabel } from './discord-frontdesk'
import type { Store } from './store'

// What Operant gives the Discord layer to reach the Master (core/operant.ts builds it from MasterRuns and MasterGate).
export interface DiscordMasterPort {
  // Stores the owner's message for the project's Master and has the gate type the one pointer line. Returns an error
  // text when the Master could not be started, else null.
  ownerMessage(crewId: number, text: string, label: string): string | null
  // A closed-vocabulary Master command line (/compact, /clear, /cost). Returns an error text, or null when queued.
  command(crewId: number, line: string): string | null
  reply(runId: number, text: string, by: ApprovedBy): void
  approve(runId: number, by: ApprovedBy, note?: string): void
  sendBack(runId: number, note: string, by: ApprovedBy): void
  stop(runId: number): Promise<void>
  resume(runId: number): void
  phase(crewId: number): string
  models(cli: MasterCli): Promise<{ models: string[]; efforts: Record<string, string[]> }>
}

// What a command handler needs from the bot it runs for.
export interface CommandHost {
  bot: DiscordBot
  store: Store
  port: DiscordMasterPort
  submit(input: RunInput): Run
  restart(): Promise<void>
  now(): number
  scrub(text: string): string
  // A start waiting for the user's confirmation button (confirmStart).
  hold(input: RunInput, userId: string): string
  take(nonce: string): { input: RunInput; userId: string } | null
}

export const MASTER_COMMAND_CHOICES = ['compact', 'clear', 'cost'] as const

const CLIS: string[] = ['claude', 'opencode']
const projectOpt = { name: 'project', description: 'The project, by PRJ number or name (not needed inside its channel)', type: 'string' as const, autocomplete: true }
const jobOpt = { name: 'job', description: 'The JOB# number', type: 'integer' as const }

export function commandDefs(): CommandDef[] {
  const launch = [
    { name: 'cli', description: 'The Master CLI for this task', type: 'string' as const, choices: CLIS },
    { name: 'model', description: 'The Master model', type: 'string' as const, autocomplete: true },
    { name: 'effort', description: 'The Master effort', type: 'string' as const, autocomplete: true },
    projectOpt,
  ]
  return [
    { name: 'newsolo', description: 'Start a task with one seat preset', options: [{ name: 'task', description: 'What to do', type: 'string', required: true }, { name: 'preset', description: 'The seat preset', type: 'string', required: true, autocomplete: true }, ...launch] },
    { name: 'newteam', description: 'Start a task with a team', options: [{ name: 'task', description: 'What to do', type: 'string', required: true }, { name: 'team', description: 'The team (built-in teams included)', type: 'string', required: true, autocomplete: true }, ...launch] },
    { name: 'stop', description: "Stop the project's current task", options: [{ ...jobOpt, description: 'The JOB# (default: the current one)' }, projectOpt] },
    { name: 'restart', description: "Restart this bot's Discord connection (not the app)" },
    { name: 'status', description: 'Projects, queue, current task and Master state', options: [projectOpt] },
    { name: 'queue', description: "The project's queued tasks", options: [projectOpt] },
    { name: 'approve', description: 'Approve a task that waits for review', options: [{ ...jobOpt, required: true }, { name: 'note', description: 'An optional note', type: 'string' }] },
    { name: 'sendback', description: 'Send a task back to the Master', options: [{ ...jobOpt, required: true }, { name: 'note', description: 'What to change', type: 'string', required: true }] },
    { name: 'answer', description: "Answer the Master's question", options: [{ ...jobOpt, required: true }, { name: 'text', description: 'Your answer', type: 'string', required: true }] },
    { name: 'resume', description: 'Resume the Master after it stopped', options: [projectOpt] },
    { name: 'master', description: 'Send a Master command when it is idle', options: [{ name: 'command', description: 'The command', type: 'string', required: true, choices: [...MASTER_COMMAND_CHOICES] }, projectOpt] },
  ]
}

// Button and modal ids. The event id makes a click on an old question or review recognisable as stale.
export const ids = {
  answer: (runId: number, eventId: number, idx: number) => `q:${runId}:${eventId}:${idx}`,
  other: (runId: number, eventId: number) => `qo:${runId}:${eventId}`,
  approve: (runId: number, eventId: number) => `ap:${runId}:${eventId}`,
  sendBack: (runId: number, eventId: number) => `sb:${runId}:${eventId}`,
}

export const questionButtons = (runId: number, e: Pick<RunEvent, 'id' | 'options'>): ButtonDef[] => [
  ...e.options.map((o, i): ButtonDef => ({ id: ids.answer(runId, e.id, i), label: o, style: 'primary' })),
  { id: ids.other(runId, e.id), label: 'Other...', style: 'secondary' },
]

export const reviewButtons = (runId: number, e: Pick<RunEvent, 'id'>): ButtonDef[] => [
  { id: ids.approve(runId, e.id), label: 'Approve', style: 'success' },
  { id: ids.sendBack(runId, e.id), label: 'Send back', style: 'danger' },
]

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const latest = (store: Store, runId: number, kind: RunEvent['kind']): RunEvent | undefined => store.listRunEvents(runId, { kind }).at(-1)

// The users who may run destructive commands: the bot's admins, else the first user on its allowlist.
export const adminsOf = (bot: DiscordBot): string[] => (bot.admins.length ? bot.admins : bot.allowlist.slice(0, 1))

const NOT_ALLOWED = "You are not on this bot's allowlist. Message the bot directly to ask for a pairing code."
const NOT_ADMIN = 'Only the bot owner (an admin in its Operant settings) can do that.'

export async function handleInteraction(h: CommandHost, i: GatewayInteraction): Promise<void> {
  if (!h.bot.allowlist.includes(i.userId)) return i.type === 'autocomplete' ? i.choices([]) : i.reply(NOT_ALLOWED)
  try {
    if (i.type === 'autocomplete') return await autocomplete(h, i)
    if (i.type === 'command') return await command(h, i)
    if (i.type === 'button') return await button(h, i)
    return await modal(h, i)
  } catch (err) {
    await i.reply(h.scrub(errText(err))).catch(() => undefined)
  }
}

// The project a command is about: this channel's, the given one, or the only project there is.
function projectOf(h: CommandHost, i: GatewayInteraction): Crew | string {
  const crews = h.store.listCrews()
  const channels = [i.channelId, i.parentId].filter((c): c is string => !!c)
  const thread = h.store.getDiscordThread(h.bot.id, i.channelId)
  const here = (thread?.crewId != null ? crews.find((c) => c.id === thread.crewId) : undefined) ?? crews.find((c) => c.discordChannels.some((ch) => channels.includes(ch)))
  if (here) return here
  const ref = typeof i.options.project === 'string' ? i.options.project : ''
  if (ref) return findProject(crews, ref) ?? `I could not tell which project you mean (${ref}). Name it by its PRJ number.`
  if (crews.length === 1) return crews[0]!
  return 'Use this in a project channel, or give the project option (PRJ number or name).'
}

function jobOf(h: CommandHost, i: GatewayInteraction, crew?: Crew): Run | string {
  const id = Number(i.options.job)
  if (!Number.isInteger(id)) return 'Give the JOB# number.'
  const run = h.store.getRun(id)
  if (!run || (crew && run.crewId !== crew.id)) return `JOB#${id} was not found.`
  return run
}

const lines = (...l: string[]) => l.join('\n')

async function command(h: CommandHost, i: GatewayInteraction): Promise<void> {
  const { store, port } = h
  const admin = adminsOf(h.bot).includes(i.userId)
  switch (i.name) {
    case 'newsolo':
    case 'newteam':
      return start(h, i)
    case 'status': {
      const crews = store.listCrews()
      const one = typeof i.options.project === 'string' || crews.some((c) => c.discordChannels.includes(i.channelId) || (i.parentId != null && c.discordChannels.includes(i.parentId))) ? projectOf(h, i) : null
      const list = one && typeof one !== 'string' ? [one] : crews
      if (!list.length) return i.reply('There are no projects yet.')
      return i.reply(list.map((c) => statusOf(h, c)).join('\n'))
    }
    case 'queue': {
      const crew = projectOf(h, i)
      if (typeof crew === 'string') return i.reply(crew)
      const queued = store.listRuns(crew.id).filter((r) => r.mode === 'master' && r.status === 'queued')
      queued.sort((a, b) => Number(b.sendBacks > 0) - Number(a.sendBacks > 0))
      return i.reply(queued.length ? lines(`Queue of ${projectLabel(crew)}:`, ...queued.map((r) => `- JOB#${r.id}${r.sendBacks ? ' (sent back)' : ''} ${oneLine(r.task, 80)}`)) : `Nothing is queued for ${projectLabel(crew)}.`)
    }
    case 'approve': {
      const run = jobOf(h, i)
      if (typeof run === 'string') return i.reply(run)
      if (run.status !== 'review') return i.reply(`JOB#${run.id} is ${run.status}, not waiting for review.`)
      port.approve(run.id, 'owner-discord', typeof i.options.note === 'string' ? i.options.note : undefined)
      return i.reply(`Approved JOB#${run.id}.`)
    }
    case 'sendback': {
      if (!admin) return i.reply(NOT_ADMIN)
      const run = jobOf(h, i)
      if (typeof run === 'string') return i.reply(run)
      if (run.status !== 'review') return i.reply(`JOB#${run.id} is ${run.status}, not waiting for review.`)
      port.sendBack(run.id, String(i.options.note ?? ''), 'owner-discord')
      return i.reply(`Sent JOB#${run.id} back to the Master.`)
    }
    case 'answer': {
      const run = jobOf(h, i)
      if (typeof run === 'string') return i.reply(run)
      if (!(run.status === 'needs-you' && run.waiting === 'question')) return i.reply(`JOB#${run.id} is not waiting for an answer.`)
      port.reply(run.id, String(i.options.text ?? ''), 'owner-discord')
      return i.reply(`Sent your answer to the Master for JOB#${run.id}.`)
    }
    case 'stop': {
      if (!admin) return i.reply(NOT_ADMIN)
      const crew = typeof i.options.job === 'number' ? undefined : projectOf(h, i)
      if (typeof crew === 'string') return i.reply(crew)
      const run = typeof i.options.job === 'number' ? jobOf(h, i) : (store.listRuns(crew!.id).find((r) => r.status === 'working' || r.status === 'needs-you') ?? 'There is no current task to stop.')
      if (typeof run === 'string') return i.reply(run)
      if (run.status === 'done' || run.status === 'failed') return i.reply(`JOB#${run.id} already ended.`)
      await i.defer()
      await port.stop(run.id)
      return i.reply(`Stopped JOB#${run.id}.`)
    }
    case 'resume': {
      const crew = projectOf(h, i)
      if (typeof crew === 'string') return i.reply(crew)
      const run = store.listRuns(crew.id).find((r) => r.mode === 'master' && r.status === 'needs-you' && r.waiting === 'master')
      if (!run) return i.reply(`${projectLabel(crew)} has no task waiting for its Master (Master state: ${port.phase(crew.id)}).`)
      await i.defer()
      port.resume(run.id)
      return i.reply(`Resuming the Master for JOB#${run.id}.`)
    }
    case 'master': {
      if (!admin) return i.reply(NOT_ADMIN)
      const crew = projectOf(h, i)
      if (typeof crew === 'string') return i.reply(crew)
      const name = String(i.options.command ?? '')
      if (!(MASTER_COMMAND_CHOICES as readonly string[]).includes(name)) return i.reply('Unknown Master command.')
      const err = port.command(crew.id, `/${name}`)
      return i.reply(err ?? `Queued /${name}: it is typed into the Master Terminal when the Master is idle.`)
    }
    case 'restart': {
      if (!admin) return i.reply(NOT_ADMIN)
      await i.reply("Restarting this bot's Discord connection. It is back in a few seconds.")
      return h.restart()
    }
    default:
      return i.reply('Unknown command.')
  }
}

const oneLine = (t: string, max: number): string => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}...` : s
}

function statusOf(h: CommandHost, c: Crew): string {
  const runs = h.store.listRuns(c.id).filter((r) => r.mode === 'master')
  const active = runs.find((r) => r.status === 'working' || r.status === 'needs-you')
  const review = runs.filter((r) => r.status === 'review')
  const queued = runs.filter((r) => r.status === 'queued').length
  const parts = [`${projectLabel(c)}: Master ${h.port.phase(c.id)}`]
  parts.push(active ? `active JOB#${active.id} ${active.status}${active.waiting ? ` (${active.waiting})` : ''} - ${oneLine(active.task, 60)}` : 'no active task')
  if (review.length) parts.push(`in review ${review.map((r) => `JOB#${r.id}`).join(', ')}`)
  if (queued) parts.push(`${queued} queued`)
  return parts.join(', ')
}

async function start(h: CommandHost, i: GatewayInteraction): Promise<void> {
  const { store } = h
  const crew = projectOf(h, i)
  if (typeof crew === 'string') return i.reply(crew)
  const task = String(i.options.task ?? '').trim()
  if (!task) return i.reply('Give the task text.')
  const cli: MasterCli = i.options.cli === 'opencode' ? 'opencode' : i.options.cli === 'claude' ? 'claude' : (h.bot.masterCli ?? 'claude')
  const input: RunInput = { crewId: crew.id, task, masterCli: cli }
  if (typeof i.options.model === 'string' && i.options.model) input.masterModel = i.options.model
  if (typeof i.options.effort === 'string' && i.options.effort) input.masterEffort = i.options.effort
  const ref = String(i.options.preset ?? i.options.team ?? '').trim().toLowerCase()
  if (i.name === 'newsolo') {
    const presets = store.listPresets()
    if (!presets.length) return i.reply('There are no seat presets yet. Create one in Operant under Settings > Presets (or Teams > Seats), then run /newsolo again.')
    const preset = presets.find((p) => String(p.id) === ref || p.name.toLowerCase() === ref)
    if (!preset) return i.reply(`I do not know the seat preset "${ref}". Pick one from the list that appears while you type.`)
    input.seats = [{ presetId: preset.id, count: 1, model: preset.model, ...(preset.effort ? { effort: preset.effort } : {}) }]
  } else {
    const teams = store.listTeams().filter((t) => !t.hidden)
    if (!teams.length) return i.reply('There are no teams yet. Create one in Operant under Settings > Teams, then run /newteam again.')
    const team = teams.find((t) => String(t.id) === ref || t.name.toLowerCase() === ref)
    if (!team) return i.reply(`I do not know the team "${ref}". Pick one from the list that appears while you type.`)
    input.teamId = team.id
  }
  if (h.bot.confirmStart) {
    const nonce = h.hold(input, i.userId)
    return i.reply(`Start this on ${projectLabel(crew)}?\n${oneLine(task, 300)}`, [{ id: `go:${nonce}`, label: 'Start', style: 'success' }])
  }
  await i.defer()
  const run = h.submit(input)
  return i.reply(`Started JOB#${run.id} on ${projectLabel(crew)}. Its updates appear in a thread.`)
}

async function autocomplete(h: CommandHost, i: GatewayInteraction): Promise<void> {
  const f = i.focused
  if (!f) return i.choices([])
  const q = f.value.toLowerCase()
  const pick = (all: Array<{ name: string; value: string }>) => i.choices(all.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 25))
  if (f.name === 'project') return pick(h.store.listCrews().map((c) => ({ name: projectLabel(c), value: c.kind === 'playground' ? c.name : String(c.prjNumber) })))
  if (f.name === 'preset') return pick(h.store.listPresets().map((p) => ({ name: p.name, value: String(p.id) })))
  if (f.name === 'team') return pick(h.store.listTeams().filter((t) => !t.hidden).map((t) => ({ name: t.builtin ? `${t.name} (built-in)` : t.name, value: String(t.id) })))
  if (f.name === 'model' || f.name === 'effort') {
    const cli: MasterCli = i.options.cli === 'opencode' ? 'opencode' : i.options.cli === 'claude' ? 'claude' : (h.bot.masterCli ?? 'claude')
    const list = await h.port.models(cli).catch(() => ({ models: [] as string[], efforts: {} as Record<string, string[]> }))
    const names = f.name === 'model' ? list.models : [...new Set(Object.entries(list.efforts).filter(([m]) => !i.options.model || m === i.options.model).flatMap(([, e]) => e))]
    return pick(names.map((n) => ({ name: n, value: n })))
  }
  return i.choices([])
}

// Why a question or review button no longer applies, or null while it still does.
function stale(h: CommandHost, runId: number, eventId: number, kind: 'question' | 'review'): { run: Run; why: null } | { run: null; why: string } {
  const run = h.store.getRun(runId)
  if (!run) return { run: null, why: `JOB#${runId} no longer exists.` }
  const open = kind === 'question' ? run.status === 'needs-you' && run.waiting === 'question' : run.status === 'review'
  if (!open || latest(h.store, runId, kind)?.id !== eventId) return { run: null, why: kind === 'question' ? `That question on JOB#${runId} was already answered or is no longer open.` : `JOB#${runId} is not waiting for this review any more (it is ${run.status}).` }
  return { run, why: null }
}

async function button(h: CommandHost, i: GatewayInteraction): Promise<void> {
  const [kind, a, b, c] = i.customId.split(':')
  const runId = Number(a)
  const eventId = Number(b)
  const admin = adminsOf(h.bot).includes(i.userId)
  if (kind === 'go') {
    const held = h.take(a ?? '')
    if (!held || held.userId !== i.userId) return i.reply('That start expired or belongs to someone else. Run the command again.')
    await i.defer()
    const run = h.submit(held.input)
    await i.clearButtons().catch(() => undefined)
    return i.reply(`Started JOB#${run.id}. Its updates appear in a thread.`)
  }
  if (kind === 'q') {
    const s = stale(h, runId, eventId, 'question')
    if (!s.run) return i.reply(s.why)
    const option = latest(h.store, runId, 'question')?.options[Number(c)]
    if (option === undefined) return i.reply('That answer is not one of the options.')
    h.port.reply(runId, option, 'owner-discord')
    await i.clearButtons().catch(() => undefined)
    return i.reply(`Sent "${oneLine(option, 80)}" to the Master.`)
  }
  if (kind === 'qo' || kind === 'sb') {
    const send = kind === 'sb'
    if (send && !admin) return i.reply(NOT_ADMIN)
    const s = stale(h, runId, eventId, send ? 'review' : 'question')
    if (!s.run) return i.reply(s.why)
    return i.modal(send ? { id: `sbm:${runId}:${eventId}`, title: `Send back JOB#${runId}`, label: 'What should change?', long: true } : { id: `qm:${runId}:${eventId}`, title: `Answer JOB#${runId}`, label: 'Your answer', long: true })
  }
  if (kind === 'ap') {
    const s = stale(h, runId, eventId, 'review')
    if (!s.run) return i.reply(s.why)
    h.port.approve(runId, 'owner-discord')
    await i.clearButtons().catch(() => undefined)
    return i.reply(`Approved JOB#${runId}.`)
  }
  return i.reply('That button is no longer in use.')
}

async function modal(h: CommandHost, i: GatewayInteraction): Promise<void> {
  const [kind, a, b] = i.customId.split(':')
  const runId = Number(a)
  const eventId = Number(b)
  const text = i.text.trim()
  if (!text) return i.reply('Nothing was written.')
  if (kind === 'qm') {
    const s = stale(h, runId, eventId, 'question')
    if (!s.run) return i.reply(s.why)
    h.port.reply(runId, text, 'owner-discord')
    await i.clearButtons().catch(() => undefined)
    return i.reply('Sent your answer to the Master.')
  }
  if (kind === 'sbm') {
    if (!adminsOf(h.bot).includes(i.userId)) return i.reply(NOT_ADMIN)
    const s = stale(h, runId, eventId, 'review')
    if (!s.run) return i.reply(s.why)
    h.port.sendBack(runId, text, 'owner-discord')
    await i.clearButtons().catch(() => undefined)
    return i.reply(`Sent JOB#${runId} back to the Master.`)
  }
  return i.reply('That form is no longer in use.')
}
