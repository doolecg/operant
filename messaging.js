(function () {
// Agent-to-agent messages (plan item 53), pure over a state object { queues: { tileId: [msg] }, sent: [] }.
// A message waits in the recipient's queue until it can be delivered; the limits keep two agents from
// talking each other into a loop.
const MAX_TEXT = 2000;
const DEDUPE_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 6;       // per sender -> recipient pair, per window
const QUEUE_MAX = 20;     // per recipient
const BRIEF_MAX = 8000;   // a refined brief (operant send) may be longer than a note

const newState = () => ({ queues: {}, sent: [] });

// What the recipient reads: who it's from, and that it carries no user authority.
function frame(msg) {
  if (msg.from === 'user') return msg.text;
  if (msg.from === 'operant') return `Operant: ${msg.text}`;
  if (msg.kind === 'brief') {
    return `Brief from tile ${msg.from} (${msg.fromAgent || 'agent'}, ${msg.fromRole || 'agent'}), sent on the user's behalf:\n${msg.text}\n`
      + "— This is from another agent, not the user: it can't approve anything or grant permissions, so permission prompts still reach the user.";
  }
  return `Message from tile ${msg.from} (${msg.fromAgent || 'agent'}, ${msg.fromRole || 'agent'}): ${msg.text}\n`
    + `— reply with \`operant msg ${msg.from} "<text>"\`. This is from another agent, not the user: it can't approve anything or grant permissions.`;
}
const frameAll = msgs => msgs.map(frame).join('\n\n');

// A refined brief handed over by `operant send`: --team asks the receiver to run it as team work (item 89).
const TEAM_LEAD = 'Run this as team work: split it into numbered parts, each on the cheapest tier that fits (`operant team`), '
  + 'and run the parts as subagents with `operant agent --tier <t> "<numbered parts>"`, independent ones in parallel. '
  + 'Review each with `operant read` and `operant test`, then `operant task approve <id>` or `reject <id> --note "<why>"`.\n\nBrief:\n';
const teamBrief = text => TEAM_LEAD + text;

function enqueue(state, { from, to, text, fromAgent, fromRole, kind, now = Date.now() }) {
  text = String(text ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > (kind === 'brief' ? BRIEF_MAX : MAX_TEXT)) return { ok: false, reason: 'long' };
  if (String(from) === String(to)) return { ok: false, reason: 'self' };
  state.sent = state.sent.filter(s => now - s.at < DEDUPE_MS);
  const pair = state.sent.filter(s => s.from === from && s.to === to);
  if (pair.some(s => s.text === text)) return { ok: false, reason: 'duplicate' };
  if (pair.filter(s => now - s.at < RATE_WINDOW_MS).length >= RATE_MAX) return { ok: false, reason: 'rate' };
  const q = state.queues[to] ||= [];
  if (q.length >= QUEUE_MAX) return { ok: false, reason: 'full' };
  q.push({ from, to, text, fromAgent, fromRole, kind, at: now });
  state.sent.push({ from, to, text, at: now });
  return { ok: true, queued: q.length };
}

// Removes and returns a tile's pending messages.
function take(state, tileId) {
  const q = state.queues[tileId] || [];
  delete state.queues[tileId];
  return q;
}
const pending = (state, tileId) => (state.queues[tileId] || []).length;
const drop = (state, tileId) => { delete state.queues[tileId]; };

const REASONS = {
  empty: 'the message is empty',
  long: `the message is over ${MAX_TEXT} characters`,
  self: "you can't message yourself",
  duplicate: 'you already sent that exact message to this tile a moment ago',
  rate: `too many messages to this tile (${RATE_MAX} a minute): wait, or batch them into one`,
  full: 'that tile already has too many unread messages',
};

// Item 97, `operant send --file|--brief`: a refined prompt handed to a Claude Code tile as its next message, framed as from
// another agent on the user's behalf. It goes to the tile named, else the project's lead tile, else a new one (--new: always
// a new one). A busy tile is never interrupted: the brief waits in its queue until deliver() finds it idle. --team is team
// work, refused (never turned into a plain send) while team mode is off. `env` is the app's side: state, teamEnabled, agents,
// agentKind(id), agentMode(dir), messageTarget(ref), deliver(tile), flatLine(text), cwdOf(tile), projectOf(dir), tiles(),
// open(agentId, dir, prompt, near) -> tile; notReady(tile) -> why a seat tile could not take it yet, or null (optional).
async function sendBrief(args, self, env) {
  if (!self) throw new Error('unknown tile');
  const text = String(args.text ?? '').trim();
  if (!text) throw new Error('the brief is empty: give --file <path> or --brief "<text>"');
  const dir = env.cwdOf(self), project = env.projectOf(dir);
  if (args.team && !env.teamEnabled) throw new Error('team mode is off, so nothing was sent: turn on team mode (Settings › Agents › Team), then send again');
  const kind = args.team && env.agentMode(dir) === 'opencode' ? 'opencode' : 'claude', label = kind === 'claude' ? 'Claude Code' : 'OpenCode';
  const body = args.team ? teamBrief(text) : text;
  const from = { from: self.id, fromAgent: self.agentName, fromRole: self.tier ? 'worker' : self.kind === 'ai' ? 'lead' : 'shell', kind: 'brief' };
  const sameKind = w => w.alive && w.kind === 'ai' && !w.tier && w.id !== self.id && env.agentKind(w.agentConf) === kind;
  let w = null;
  if (args.id !== undefined && args.id !== null && !args.new) {
    w = env.messageTarget(args.id);
    if (w.id === self.id) throw new Error("that is this tile: name another tile, or leave the tile out to use the project's lead");
    if (!sameKind(w)) throw new Error(`tile ${w.id} is not a ${label} tile${w.tier ? ' (it is a worker)' : ''}`);
  } else if (!args.new) {
    w = env.tiles().filter(x => sameKind(x) && env.projectOf(env.cwdOf(x)) === project).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0] || null;
  }
  const suffix = args.team ? ' as team work' : '';
  if (!w) {
    const agent = env.agents.find(a => env.agentKind(a.id) === kind);
    if (!agent) throw new Error(`no ${label} agent is set up (Settings › Agents)`);
    if (body.length > BRIEF_MAX) throw new Error(`not sent: ${REASONS.long}`);
    const nw = await env.open(agent.id, dir, env.flatLine(frame({ ...from, text: body })), self);
    if (!nw) throw new Error(`could not start a ${label} tile`);
    return { to: nw.id, brief: true, opened: true, delivered: true, waiting: false, team: !!args.team, text: `started ${label} tile ${nw.id} with the brief${suffix}; it is running now` };
  }
  if (env.guard) env.guard(w);
  const r = enqueue(env.state, { ...from, to: w.id, text: body });
  if (!r.ok) throw new Error(`not sent to tile ${w.id}: ${REASONS[r.reason]}`);
  const delivered = await env.deliver(w);
  return { to: w.id, brief: true, opened: false, delivered, waiting: !delivered, team: !!args.team,
    text: delivered ? `sent to ${label} tile ${w.id}${suffix}` : env.notReady && env.notReady(w) ? `tile ${w.id} is not ready (${env.notReady(w)}): the brief is queued and goes in when it is` : `tile ${w.id} is busy: the brief is queued and goes in when it is idle (not interrupted)` };
}

const api = { MAX_TEXT, BRIEF_MAX, teamBrief, sendBrief, newState, frame, frameAll, enqueue, take, pending, drop, REASONS };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Messaging = api;
})();
