// Mirrors a run's events into its Discord thread by code. No model is asked and no transcript or tool output is read:
// only the run events and status changes Operant already stores (questions, reviews, progress lines, approvals,
// the close-out result, failures). Text goes through the secret scrubber and the Markdown formatter.
import type { DiscordBot, DiscordMirror, Run, RunEvent } from '../shared/types'
import { questionButtons, reviewButtons } from './discord-commands'
import { defangMentions, discordOutcome, markdownForDiscord } from './discord-format'
import type { DiscordGateway } from './discord-gateway'
import { jobThreadName, threadTitle } from './discord-threads'
import type { Store } from './store'

// At most one message per thread in this time; progress lines wait and go out together, in one edited message.
export const PROGRESS_MS = 10_000
const STATUS_MAX = 1800
const KEEP_LINES = 12

export interface MirrorHost {
  store: Store
  now(): number
  // Runs `fn` after `ms` (a real timer; tests pass their own).
  later(fn: () => void, ms: number): void
  scrub(text: string): string
  // The connected bots, with the gateway each is on.
  bots(): Array<{ bot: DiscordBot; gateway: DiscordGateway }>
  log(message: string): void
  // A permission gap, reported once per bot and channel.
  gap(botId: number, channelId: string, text: string): void
}

interface RunMirror {
  botId: number
  target: string | null
  lines: string[]
  lastSent: number
  statusId: string | null
  scheduled: boolean
  seen: Set<string>
  chain: Promise<void>
}

const oneLine = (t: string, max: number): string => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}...` : s
}

const rank = (m: DiscordMirror): number => (m === 'off' ? 0 : m === 'results' ? 1 : 2)

export class DiscordMirrorService {
  private readonly runs = new Map<number, RunMirror>()

  constructor(private readonly h: MirrorHost) {}

  // The bot that carries this run: the one with a thread for it, else one that already has threads of its project, else
  // the first connected one. Null when none mirrors.
  private pick(run: Run): { bot: DiscordBot; gateway: DiscordGateway } | null {
    const all = this.h.bots().filter((b) => b.bot.mirror !== 'off')
    if (!all.length) return null
    const threads = (b: DiscordBot) => this.h.store.listDiscordThreads(b.id)
    return all.find((b) => threads(b.bot).some((t) => t.runId === run.id)) ?? all.find((b) => threads(b.bot).some((t) => t.crewId === run.crewId)) ?? all[0]!
  }

  private state(run: Run, botId: number): RunMirror {
    let st = this.runs.get(run.id)
    if (!st || st.botId !== botId) {
      st = { botId, target: null, lines: [], lastSent: 0, statusId: null, scheduled: false, seen: new Set(), chain: Promise.resolve() }
      this.runs.set(run.id, st)
    }
    return st
  }

  // A run event (MasterRuns.onEvent).
  onEvent(run: Run, e: RunEvent): void {
    if (run.mode !== 'master') return
    this.enqueue(run, (bot, gw, st) => this.event(bot, gw, st, run, e))
  }

  // A run changed status or fields (the `run` push).
  onChange(run: Run): void {
    if (run.mode !== 'master') return
    this.enqueue(run, (bot, gw, st) => this.change(bot, gw, st, run))
  }

  private enqueue(run: Run, fn: (bot: DiscordBot, gw: DiscordGateway, st: RunMirror) => Promise<void>): void {
    const picked = this.pick(run)
    if (!picked) return
    const st = this.state(run, picked.bot.id)
    st.chain = st.chain.then(() => fn(picked.bot, picked.gateway, st)).catch((err) => this.h.log(`Discord: could not mirror JOB#${run.id}: ${this.h.scrub(err instanceof Error ? err.message : String(err))}`))
  }

  private async change(bot: DiscordBot, gw: DiscordGateway, st: RunMirror, run: Run): Promise<void> {
    const fresh = this.h.store.getRun(run.id) ?? run
    if (fresh.status === 'working') {
      const key = `working:${fresh.sendBacks}`
      if (st.seen.has(key) || rank(bot.mirror) < 2) return
      st.seen.add(key)
      return this.progress(bot, gw, st, fresh, fresh.sendBacks ? 'sent back to the Master again' : 'with the Master')
    }
    if (fresh.status === 'failed') {
      const key = `failed:${fresh.outcome}`
      if (st.seen.has(key)) return
      st.seen.add(key)
      return this.post(bot, gw, st, fresh, `**JOB#${fresh.id} failed**`, fresh.outcome)
    }
    if (fresh.status === 'needs-you' && (fresh.waiting === 'permission' || fresh.waiting === 'master')) {
      const key = `wait:${fresh.waiting}:${fresh.outcome}`
      if (st.seen.has(key)) return
      st.seen.add(key)
      return this.post(bot, gw, st, fresh, `**JOB#${fresh.id} needs you**`, fresh.outcome)
    }
  }

  private async event(bot: DiscordBot, gw: DiscordGateway, st: RunMirror, run: Run, e: RunEvent): Promise<void> {
    if (e.kind === 'progress') {
      if (rank(bot.mirror) < 2) return
      return this.progress(bot, gw, st, run, e.body)
    }
    // Anything else is a new message, so earlier progress goes out first and the next progress starts a new message.
    switch (e.kind) {
      case 'question': {
        const target = await this.flushAndTarget(bot, gw, st, run)
        if (!target) return
        const text = `**JOB#${run.id} asks:**\n${this.format(e.body)}${e.options.length ? '' : '\nReply in this thread, or press the button.'}`
        return this.sendWithButtons(gw, target, text, questionButtons(run.id, e))
      }
      case 'review': {
        const target = await this.flushAndTarget(bot, gw, st, run)
        if (!target) return
        const pieces = discordOutcome(`**JOB#${run.id} is ready for review**`, e.body, { scrub: this.h.scrub })
        for (let n = 0; n < pieces.length - 1; n++) await gw.send(target, pieces[n]!)
        return this.sendWithButtons(gw, target, pieces[pieces.length - 1]!, reviewButtons(run.id, e))
      }
      case 'approved':
        return this.post(bot, gw, st, run, `**JOB#${run.id} approved**`, e.body)
      case 'sent-back':
        return this.post(bot, gw, st, run, `**JOB#${run.id} sent back**`, e.body)
      case 'closeout':
        return this.post(bot, gw, st, run, `**Close-out of JOB#${run.id}**`, e.body)
      case 'giveup':
        return this.post(bot, gw, st, run, `**JOB#${run.id}**: the Master did not pick up the task. Press Resume in Operant, or use /resume.`)
      default:
        return
    }
  }

  private format(markdown: string): string {
    return markdownForDiscord(markdown, { scrub: this.h.scrub })
  }

  private async sendWithButtons(gw: DiscordGateway, target: string, text: string, buttons: ReturnType<typeof questionButtons>): Promise<void> {
    if (gw.sendRich) await gw.sendRich(target, text, buttons)
    else await gw.send(target, text)
  }

  private async post(bot: DiscordBot, gw: DiscordGateway, st: RunMirror, run: Run, header: string, body = ''): Promise<void> {
    const target = await this.flushAndTarget(bot, gw, st, run)
    if (!target) return
    for (const piece of discordOutcome(header, body, { scrub: this.h.scrub })) await gw.send(target, piece)
  }

  // Sends pending progress lines now, then returns where this run's messages go.
  private async flushAndTarget(bot: DiscordBot, gw: DiscordGateway, st: RunMirror, run: Run): Promise<string | null> {
    const target = await this.target(bot, gw, st, run)
    if (target && st.lines.length) await this.flush(gw, st, target)
    st.statusId = null
    st.lines = []
    return target
  }

  // Progress lines: batched, at most one send per PROGRESS_MS, kept in one message that is edited while it can be.
  private async progress(bot: DiscordBot, gw: DiscordGateway, st: RunMirror, run: Run, line: string): Promise<void> {
    st.lines.push(oneLine(defangMentions(this.h.scrub(line)), 300))
    if (st.lines.length > KEEP_LINES) st.lines.splice(0, st.lines.length - KEEP_LINES)
    const wait = st.lastSent + PROGRESS_MS - this.h.now()
    if (wait <= 0) {
      const target = await this.target(bot, gw, st, run)
      if (target) await this.flush(gw, st, target)
      return
    }
    if (st.scheduled) return
    st.scheduled = true
    this.h.later(() => {
      st.chain = st.chain
        .then(async () => {
          st.scheduled = false
          const target = st.target
          if (target && st.lines.length) await this.flush(gw, st, target)
        })
        .catch(() => undefined)
    }, wait)
  }

  private async flush(gw: DiscordGateway, st: RunMirror, target: string): Promise<void> {
    let text = st.lines.map((l) => `- ${l}`).join('\n')
    while (text.length > STATUS_MAX && st.lines.length > 1) {
      st.lines.shift()
      text = st.lines.map((l) => `- ${l}`).join('\n')
    }
    st.lastSent = this.h.now()
    if (st.statusId && gw.edit) {
      try {
        await gw.edit(target, st.statusId, text)
        return
      } catch {
        st.statusId = null
      }
    }
    st.statusId = await gw.send(target, text)
  }

  // The thread of the run, made when missing: a header message in the project's channel, then a thread on it named JOB#N.
  private async target(bot: DiscordBot, gw: DiscordGateway, st: RunMirror, run: Run): Promise<string | null> {
    if (st.target) return st.target
    const { store } = this.h
    const known = store.listDiscordThreads(bot.id).find((t) => t.runId === run.id)
    if (known) return (st.target = known.threadId)
    const channel = store.getCrew(run.crewId)?.discordChannels[0]
    if (!channel) return null
    const title = threadTitle(run.task)
    let header: string
    try {
      header = await gw.send(channel, defangMentions(this.h.scrub(`**JOB#${run.id}** ${oneLine(run.task, 200)}`)))
    } catch (err) {
      this.h.gap(bot.id, channel, `I could not post in this channel (${this.h.scrub(err instanceof Error ? err.message : String(err))}). Give me the View Channel and Send Messages permissions here.`)
      return null
    }
    if (bot.threadPerRequest) {
      try {
        const id = await gw.createThread(channel, header, jobThreadName(run.id, title), bot.threadArchive)
        store.addDiscordThread({ botId: bot.id, threadId: id, parentId: channel, userId: '', crewId: run.crewId, runId: run.id, title, name: jobThreadName(run.id, title), createdAt: this.h.now() })
        return (st.target = id)
      } catch (err) {
        if ((err as { permission?: boolean }).permission) this.h.gap(bot.id, channel, 'I could not start a thread for this job. Give me the Create Public Threads and Send Messages in Threads permissions in this channel (and Manage Threads to rename it). I will post in the channel instead.')
      }
    }
    return (st.target = channel)
  }

  forget(runId: number): void {
    this.runs.delete(runId)
  }
}
