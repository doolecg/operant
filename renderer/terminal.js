// The Operant Terminal tile (plan items 73, 75, 77): one prompt box per project. A prompt goes to the refiner
// (window.operant.terminalRefine, main's terminal:refine), comes back as a cleaned prompt plus a task list, is shown
// for review (Enter sends, E edits, O sends the original, Esc discards; auto-send skips the review), and each task is
// dispatched to a worker. Result cards follow the board. The conversation is saved per project (terminal-store.js).
// Loads as a plain script (sets window.OperantTerminal) and in Node (module.exports) for the pure helpers.

const OperantTerminal = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const estTokens = t => Math.ceil(String(t || '').length / 4);
  const fmtN = n => n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n);
  const fmtUsd = u => u == null ? null : u === 0 ? 'free' : u < 0.01 ? '<$0.01' : '$' + u.toFixed(u < 1 ? 3 : 2);
  const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---- pure helpers (tested in test/terminal.test.js)

  // Word-level diff: [{ op: '=' | '-' | '+', text }], whitespace kept so the text can be rebuilt on either side.
  function diffOps(a, b) {
    const x = String(a).match(/\s+|\S+/g) || [], y = String(b).match(/\s+|\S+/g) || [];
    let s = 0;
    while (s < x.length && s < y.length && x[s] === y[s]) s++;
    let e = 0;
    while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
    const xm = x.slice(s, x.length - e), ym = y.slice(s, y.length - e);
    const ops = x.slice(0, s).map(text => ({ op: '=', text }));
    if (xm.length * ym.length > 1e6) {
      xm.forEach(text => ops.push({ op: '-', text })); ym.forEach(text => ops.push({ op: '+', text }));
    } else {
      const w = ym.length + 1, t = new Uint16Array((xm.length + 1) * w);
      for (let i = xm.length - 1; i >= 0; i--) for (let j = ym.length - 1; j >= 0; j--) {
        t[i * w + j] = xm[i] === ym[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
      let i = 0, j = 0;
      while (i < xm.length || j < ym.length) {
        if (i < xm.length && j < ym.length && xm[i] === ym[j]) { ops.push({ op: '=', text: xm[i] }); i++; j++; }
        else if (j < ym.length && (i === xm.length || t[i * w + j + 1] >= t[(i + 1) * w + j])) ops.push({ op: '+', text: ym[j++] });
        else ops.push({ op: '-', text: xm[i++] });
      }
    }
    for (const text of x.slice(x.length - e)) ops.push({ op: '=', text });
    const out = [];
    for (const o of ops) { const last = out[out.length - 1]; if (last && last.op === o.op) last.text += o.text; else out.push({ ...o }); }
    return out;
  }
  // The two sides as HTML: your prompt with what was cut marked, the cleaned one with what was added marked.
  function diffHtml(original, cleaned) {
    const ops = diffOps(original, cleaned), side = (keep, tag) => ops.filter(o => o.op === '=' || o.op === keep)
      .map(o => o.op === '=' ? esc(o.text) : /^\s+$/.test(o.text) ? esc(o.text) : `<${tag}>${esc(o.text)}</${tag}>`).join('');
    return { original: side('-', 'del'), cleaned: side('+', 'ins') };
  }
  // Prose to HTML: escaped, fenced code blocks and `inline code` only.
  function renderText(text) {
    const parts = String(text || '').split(/```[^\n]*\n?([\s\S]*?)```/);
    return parts.map((p, i) => i % 2 ? `<pre class="ot-code">${esc(p.replace(/\n$/, ''))}</pre>`
      : esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>')).join('');
  }
  // What a key does while a review card is showing; null = not a review key (Enter with text in the box is a new prompt).
  function reviewKey(e, boxEmpty) {
    if (e.key === 'Escape') return 'discard';
    if (e.ctrlKey || e.altKey || e.metaKey || !boxEmpty) return null;
    if (e.key === 'Enter' && !e.shiftKey) return 'send';
    if (e.shiftKey) return null;
    return e.key === 'e' || e.key === 'E' ? 'edit' : e.key === 'o' || e.key === 'O' ? 'original' : null;
  }
  // Up/Down through what you sent: idx === len is the unsent draft. Returns the new idx.
  const historyStep = (len, idx, dir) => Math.min(len, Math.max(0, idx + dir));
  // A refine result (or nothing, or an error) as the shape the tile uses: always at least one task.
  function normalizeResult(res, prompt, error) {
    const r = res && typeof res === 'object' ? res : {};
    const tasks = Array.isArray(r.tasks) && r.tasks.length ? r.tasks : [{ title: clip(prompt, 60), prompt }];
    return {
      requestId: r.requestId || newId(), original: prompt, // what was sent to the refiner: after a question, your answer is folded in, so the review shows all of it
      cleaned: typeof r.refined === 'string' && r.refined.trim() ? r.refined : null,
      question: typeof r.question === 'string' && r.question.trim() ? r.question.trim() : null, summary: r.summary || '',
      tasks: tasks.map(t => ({ ...t, title: t.title || clip(t.prompt || prompt, 60), prompt: t.prompt || prompt })),
      refiner: r.refiner || null, brief: r.brief || null, error: r.error || error || null, mode: r.mode || null, noTiers: !!r.noTiers,
    };
  }
  // Item 82: what the review says about the project's agent choice ('claude' | 'opencode' | else nothing), and a note when the refiner
  // itself is OpenCode while the project is Claude only (the refiner keeps its own setting).
  const MODE_NAMES = { claude: 'Claude only', opencode: 'OpenCode only' };
  function modeNote(mode, refinerProvider) {
    if (!MODE_NAMES[mode]) return { label: '', note: '' };
    return { label: MODE_NAMES[mode], note: mode === 'claude' && refinerProvider === 'opencode' ? 'The refiner itself runs on OpenCode (its own setting in Settings › Agents › Operant Terminal); only the tasks stay on Claude.' : '' };
  }
  // Board status -> [label, look].
  const STATUS = { todo: ['Queued', 'wait'], doing: ['Working', 'run'], verifying: ['Running checks', 'run'], review: ['Ready for review', 'ok'],
    done: ['Done', 'ok'], failed: ['Failed', 'bad'], blocked: ['Blocked', 'bad'], cancelled: ['Closed', 'wait'],
    queued: ['Queued: waiting for a free worker', 'wait'], error: ['Not started', 'bad'] };
  const statusOf = t => STATUS[t?.status] || ['Not on the board', 'wait'];

  // ---- dispatch, follow-ups and results: pure helpers (tested in test/terminal.test.js)

  const SOURCE = 'terminal';
  // A task above the top tier allowed never starts. allowed = the tier names up to the top tier, cheapest first.
  function assertTierAllowed(tier, allowed) {
    if (tier && !allowed.includes(tier)) throw new Error(`tier "${tier}" is above the top tier allowed (${allowed[allowed.length - 1] || 'none'})`);
  }
  // The `agent` control's arguments for one task: the refiner's pick as it is, plus what ties the worker to the request.
  function dispatchArgs(task, { requestId, idx, cwd }) {
    const a = { prompt: task.prompt, cwd, requestId, taskId: idx, source: SOURCE, title: task.title };
    for (const k of ['agent', 'model', 'effort', 'tier']) if (task[k]) a[k] = task[k];
    return a;
  }
  // Which of the tasks start now (up to the free worker slots, in order), which wait, and which can't start at all.
  // -> { start: [idx], queued: [idx], errors: { idx: message } }
  function planDispatch(tasks, { free, allowed }) {
    const plan = { start: [], queued: [], errors: {} };
    let room = Math.max(0, free | 0);
    tasks.forEach((t, idx) => {
      try { assertTierAllowed(t.tier, allowed); } catch (e) { plan.errors[idx] = e.message; return; }
      if (room > 0) { plan.start.push(idx); room--; } else plan.queued.push(idx);
    });
    return plan;
  }
  // One master worker per CLI: several tasks for the same CLI (Claude Code or OpenCode) go to one worker, which runs each as
  // its own subagent at the same time, on that task's model, up to `limit` at once. It takes the highest tier among its tasks.
  // kindOf(agentId) -> 'claude' | 'opencode' | 'other'; allowed = tier names, cheapest first. Other agents keep one worker per task.
  const KIND_NAME = { claude: 'Claude', opencode: 'OpenCode' };
  function subagentHow(kind, t) {
    if (kind === 'opencode') return t.tier ? `the \`tier-${t.tier}\` subagent` : 'a subagent';
    const m = /\b(haiku|sonnet|opus|fable)\b/i.exec(String(t.model || ''));
    return m ? `the Agent tool with model "${m[1].toLowerCase()}"` : 'the Agent tool';
  }
  function masterPrompt(items, kind, limit) {
    return [
      `You're the master ${KIND_NAME[kind]} worker for these ${items.length} independent tasks. Run them at the same time as your own subagents, one subagent per task (up to ${limit} at once; start the rest as others finish), each the way its task says. Hand each subagent its task as written, tell it to touch only that task's files and not to commit. Do a task yourself only when it is a one-line change.`,
      '',
      ...items.flatMap((t, i) => [`${i + 1}. ${t.title} (${t.tier ? t.tier + ' tier, ' : ''}run with ${subagentHow(kind, t)})`, t.prompt,
        ...(t.files?.length ? [`Files: ${t.files.join(', ')}`] : []), '']),
      'When all are back, check them together (operant test, operant build) and fix any clash between them. Then report once: your --note starts with "TL;DR: <one sentence: what was done>", then one line per task: its number, done or failed, the files changed.',
    ].join('\n');
  }
  function bundleTasks(tasks, { kindOf, allowed = [], limit = 9 } = {}) {
    if (!Array.isArray(tasks) || tasks.length < 2) return tasks;
    const groups = new Map();
    for (const t of tasks) { const k = kindOf(t.agent); (groups.get(k) || groups.set(k, []).get(k)).push(t); }
    const rank = t => allowed.indexOf(t.tier);
    return [...groups].flatMap(([kind, items]) => {
      if (items.length < 2 || !KIND_NAME[kind]) return items;
      const top = items.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      return [{ title: clip(`${items.length} tasks: ${items.map(t => t.title).join('; ')}`, 60), prompt: masterPrompt(items, kind, limit),
        type: top.type, agent: top.agent, model: top.model, effort: top.effort, tier: top.tier,
        files: [...new Set(items.flatMap(t => t.files || []))],
        why: `One master ${KIND_NAME[kind]} worker runs these as parallel subagents: ${items.map((t, i) => `${i + 1}. ${t.title}`).join('; ')}` }];
    });
  }
  // ---- slash commands and the input helpers (items 84, 85)
  const SLASH = [
    { name: 'help', desc: 'What you can type here' },
    { name: 'stop', args: '[#n | all]', desc: 'Interrupt a task (like Esc), or every running task of the last request' },
    { name: 'close', args: '#n [reason]', desc: 'Stop a task and close it, with an optional reason' },
    { name: 'retry', args: '#n', desc: 'Run a task again with a new worker' },
    { name: 'approve', args: '#n', desc: 'Accept a task waiting for review' },
    { name: 'reject', args: '#n <why>', desc: 'Send a task back with the reason' },
    { name: 'tasks', desc: 'Every task in this conversation and where it stands' },
    { name: 'cost', desc: 'Tokens and cost of this conversation' },
    { name: 'status', desc: 'Agents, tiers, workers and settings for this project' },
    { name: 'tier', args: '<name> | auto', desc: 'Run the next prompts on one tier' },
    { name: 'original', args: '<prompt>', desc: 'Send a prompt as written, without cleaning it' },
    { name: 'auto', desc: 'Turn auto-send on or off' },
    { name: 'diff', desc: "Open the project's changes" },
    { name: 'settings', desc: "Open this project's Terminal settings" },
    { name: 'clear', desc: 'Clear this conversation' },
  ];
  // "/close #2 not needed" -> { name: 'close', card: 2, rest: 'not needed', known: true }; not a command -> null.
  function parseSlash(text) {
    const m = /^\/(\S*)\s*([\s\S]*)$/.exec(String(text || '').trim());
    if (!m) return null;
    const name = m[1].toLowerCase();
    let rest = m[2].trim(), card = null;
    const c = /^#(\d+)\b\s*/.exec(rest);
    if (c) { card = Number(c[1]); rest = rest.slice(c[0].length).trim(); }
    return { name, card, rest, known: SLASH.some(x => x.name === name) };
  }
  const slashMatches = prefix => { const q = String(prefix || '').replace(/^\//, '').toLowerCase(); return SLASH.filter(x => x.name.startsWith(q)); };
  // The @word at the caret -> { start, query } (start = index of the @), else null.
  function atToken(text, caret) {
    const m = /(^|\s)@([^\s@]*)$/.exec(String(text || '').slice(0, caret));
    return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
  }
  // Project files for @query: file names that start with it first, then paths that contain it; shortest first.
  function fileMatches(files, query, n = 8) {
    const q = String(query || '').toLowerCase().replaceAll('\\', '/');
    const base = f => f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    const scored = [];
    for (const f of files || []) {
      const lf = f.toLowerCase(), b = base(f);
      const s = !q ? 2 : b.startsWith(q) ? 0 : lf.includes(q) ? 1 : -1;
      if (s >= 0) scored.push([s, f.length, f]);
      if (!q && scored.length >= n) break;
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, n).map(x => x[2]);
  }
  // Ctrl+R: earlier prompts containing the text, newest first, no repeats.
  function histMatches(hist, query, n = 8) {
    const q = String(query || '').toLowerCase(), out = [];
    for (let i = (hist || []).length - 1; i >= 0 && out.length < n; i--) {
      const h = hist[i];
      if (h.toLowerCase().includes(q) && !out.includes(h)) out.push(h);
    }
    return out;
  }
  // A shell tile's output without the shell's prompt waiting at the end (PowerShell's can wrap over two lines).
  function shellOutput(text) {
    const lines = String(text || '').replace(/\s+$/, '').split('\n');
    const at = lines.findLastIndex(l => /^PS [A-Za-z]:\\/.test(l));
    if (at >= 0 && /> ?$/.test(lines[lines.length - 1])) lines.length = at;
    else if (/^\S*[$#%>] ?$/.test(lines[lines.length - 1] || '')) lines.pop();
    return lines.join('\n').trim();
  }
  // What a line typed in the box is: a slash command, a shell command (!), a memory (# then a non-digit), or a prompt.
  function inputKind(text) {
    const t = String(text || '').trim();
    if (t.startsWith('/')) return 'slash';
    if (t.startsWith('!') && t.length > 1) return 'shell';
    if (/^#[^\d\s#]|^# \S/.test(t)) return 'memory';
    return 'prompt';
  }
  // Follow-up for a worker: the task, what it was asked, its last note and the new ask; never the history.
  function handoffText({ title, asked, note, ask }) {
    return [`Follow-up on your task "${clip(title, 80)}".`, `You were asked: ${clip(asked, 400) || 'unknown'}`,
      `Your last note: ${clip(note, 400) || 'none'}`, `New ask: ${String(ask || '').trim()}`].join('\n');
  }
  // Follow-up route: a live worker gets it through the message queue; otherwise a new task on the same tier with the handoff.
  function followUpPlan({ entry, note, live, ask, nextIdx }) {
    const text = handoffText({ title: entry.title, asked: entry.prompt, note, ask });
    if (live) return { kind: 'message', text: flatText(text) };
    return { kind: 'task', idx: nextIdx, task: { title: `Follow-up: ${clip(entry.title, 50)}`, prompt: text, agent: entry.agent, model: entry.model, effort: entry.effort, tier: entry.tier, why: `Follow-up on #${entry.idx + 1}, same tier` } };
  }
  // Total price of per-model segments: each priced result is { usd } or null; one unknown makes the whole unknown.
  const sumSegmentUsd = results => results.every(r => r && typeof r.usd === 'number') ? results.reduce((n, r) => n + r.usd, 0) : null;
  const flatText = t => String(t).replace(/\s*\n\s*/g, ' ');
  // Open = a live worker is on it; anything else gets a new task.
  const LIVE = ['todo', 'doing', 'verifying'];
  const isLive = (status, tileAlive) => !!tileAlive && LIVE.includes(status);
  const SETTLED = ['done', 'failed', 'blocked', 'cancelled', 'error'];
  const isSettled = (status, error) => !!error || SETTLED.includes(status);
  // The follow-up target offered by default: the last task still running or waiting, else a new request.
  function defaultTarget(items) {
    for (let i = items.length - 1; i >= 0; i--) if (!items[i].settled) return items[i].key;
    return 'new';
  }
  // What a card shows for tokens: total = input + output + cache writes; free tokens cost nothing; usd null = unknown.
  function tokenLine({ total, free, usd }) {
    if (!total) return '';
    if (free || usd === 0) return `${fmtN(total)} tokens (free)`;
    return `${fmtN(total)} tokens · ${usd == null ? 'cost unknown' : '≈ ' + fmtUsd(usd)}`;
  }
  // The request footer. paid/free are token counts, usd the summed cost of the paid ones (unknown = how many had none).
  // A "saved" figure needs a real comparison (what the same tasks cost unrefined); none exists yet, so none is shown (plan item 81).
  function requestFooter({ refiner, paid, usd, unknown }) {
    const rt = refiner?.tokens ? (refiner.tokens.input || 0) + (refiner.tokens.output || 0) : null;
    const free = refiner && (refiner.usd === 0 || refiner.provider === 'local');
    const r = rt == null ? 'Refiner: tokens not reported.' : `Refiner: ${fmtN(rt)} ${free ? 'free ' : ''}tokens${free || refiner.usd == null ? '' : ' (' + fmtUsd(refiner.usd) + ')'}.`;
    const cost = unknown ? (usd > 0 ? ` (≈ ${fmtUsd(usd)} plus ${unknown} unpriced)` : ' (cost unknown)') : ` (≈ ${usd ? fmtUsd(usd) : '$0'})`;
    return `${r} Paid tokens used by the agents: ${fmtN(paid || 0)}${paid ? cost : ''}`;
  }
  // The Operant summary once every task of a request is settled. tasks: [{ title, status, error, note, paid, usd }]
  function summaryText({ tasks, refiner }) {
    const done = tasks.filter(t => t.status === 'done'), bad = tasks.filter(t => t.error || t.status === 'failed' || t.status === 'blocked');
    const paid = tasks.reduce((n, t) => n + (t.paid || 0), 0), unknown = tasks.filter(t => t.paid && t.usd == null).length;
    const usd = tasks.reduce((n, t) => n + (t.usd || 0), 0);
    const lines = [`${done.length} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} done${done.length ? ': ' + done.map(t => t.title).join('; ') : ''}.`];
    if (bad.length) lines.push(`Failed or stuck: ${bad.map(t => `${t.title} (${clip(t.error || t.note || t.status, 100)})`).join('; ')}.`);
    lines.push(requestFooter({ refiner, paid, usd, unknown }) + '.');
    return lines.join('\n');
  }

  // ---- the tile

  // host: { operant, tierDot(tier), tasks(), control(cmd, args), autoSend(), setAutoSend(on), focusTile(id), toast(html),
  //   tileAlive(id), allowedTiers() (names up to the top tier), freeWorkers(), usageOf(task) -> { tokens, free, model, escalated, segments: [{ model, tokens }] },
  //   message(tileId, text) (the user's follow-up: queued and delivered between tool calls or when the tile is idle -> { delivered, queued }),
  //   queuedFor(tileId) (follow-ups still waiting), notifyAway(title, body) }
  function mount(w, host) {
    const { el, cwd: project } = w, op = host.operant;
    const $ = s => el.querySelector(s);
    const log = $('.ot-log'), box = $('.ot-box textarea'), status = $('.ot-status'), autoBtn = $('[data-v="auto"]');
    const st = { review: null, question: null, refining: null, hist: [], histIdx: 0, draft: '', queue: [], pumping: false, restored: false, latest: null, picked: false,
      menu: null, tier: null, lastEsc: 0 };
    const menu = document.createElement('div');
    menu.className = 'ot-menu hidden';
    $('.ot-box').before(menu);
    const cards = new Map(); // requestId:idx -> { entry, node, input, usd, costKey, html, task, ask }
    const reqs = new Map(); // requestId -> { refiner, foot, summarized }
    const target = $('.ot-target select'), targetRow = $('.ot-target');
    let statusTimer = null;

    const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const scroll = () => { log.scrollTop = log.scrollHeight; };
    const append = html => { const stick = atBottom(); log.insertAdjacentHTML('beforeend', html); const n = log.lastElementChild; if (stick) scroll(); return n; };
    const autosize = () => { box.style.height = 'auto'; box.style.height = box.scrollHeight ? Math.min(box.scrollHeight, 180) + 'px' : ''; };
    const save = entry => { const e = { t: Date.now(), ...entry }; op.terminalAppend?.(project, e); return e; };
    const persist = e => { const { t, ...rest } = e; op.terminalAppend?.(project, { t: Date.now(), ...rest }); }; // a later line for a card replaces its earlier fields
    const req = id => { let r = reqs.get(id); if (!r) reqs.set(id, r = { refiner: null, foot: null, summarized: 0 }); return r; };
    const cardsOf = rid => [...cards.values()].filter(c => c.entry.requestId === rid).sort((a, b) => a.entry.idx - b.entry.idx);
    const fmtMs = ms => ms < 60000 ? Math.round(ms / 1000) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's';

    function empty() {
      if (log.querySelector('.ot-msg, .ot-card, .ot-refined')) return;
      if (!log.querySelector('.ot-hello')) log.insertAdjacentHTML('afterbegin', `<div class="ot-hello"><div class="ot-mark">◆</div><h3>Operant Terminal</h3>
        <p>Say what you want done in <b>${esc(project.split(/[\\/]/).filter(Boolean).pop() || project)}</b>. Operant cleans the prompt, splits it into tasks, picks the cheapest agent and model that fits each, and reports back here.</p></div>`);
    }
    function line(entry) {
      log.querySelector('.ot-hello')?.remove();
      if (entry.role === 'user') return append(`<div class="ot-msg user"><span class="ot-who">You</span><div class="ot-body">${renderText(entry.text)}</div></div>`);
      if (entry.role === 'operant' && entry.kind === 'summary' && entry.requestId) req(entry.requestId).summarized = entry.count || 0;
      if (entry.role === 'operant') return append(`<div class="ot-msg operant ${esc(entry.kind || '')}"><span class="ot-who">Operant</span><div class="ot-body">${renderText(entry.text)}</div></div>`);
      if (entry.role === 'refiner') {
        if (entry.requestId) req(entry.requestId).refiner = entry.refiner || null;
        const r = entry.refiner, meta = [r?.provider && `${r.provider}${r.model ? ' ' + r.model : ''}`, r?.tokens && `${fmtN(r.tokens.input || 0)} in / ${fmtN(r.tokens.output || 0)} out`, fmtUsd(r?.usd)].filter(Boolean).join(' · ');
        return append(`<details class="ot-refined"><summary><span class="ot-dim">Cleaned prompt</span> ${esc(entry.summary || clip(entry.cleaned || entry.original, 90))}${entry.error ? ` <span class="ot-bad">(${esc(clip(entry.error, 80))})</span>` : ''}</summary>
          <div class="ot-pre">${esc(entry.cleaned || entry.original || '')}</div>${meta ? `<div class="ot-dim">${esc(meta)}</div>` : ''}</details>`);
      }
      if (entry.role === 'task') return card(entry);
      return null;
    }

    // ---- result cards (item 77): a card per task, keyed by requestId + task index, following the board
    // Matched on the request too: board numbers start again at 1 after a restart, and an old card must not take a new task.
    const taskOf = e => e.boardId != null ? host.tasks().find(t => t.id === e.boardId && (!t.requestId || t.requestId === e.requestId)) : null;
    const tileOf = c => {
      const t = taskOf(c.entry);
      return t?.owner != null && host.tileAlive(t.owner) ? t.owner : c.entry.tile != null && host.tileAlive(c.entry.tile) ? c.entry.tile : null;
    };
    // What a card shows now: the board task's live state, or the snapshot taken when it settled.
    function view(c) {
      const e = c.entry;
      if (e.final) return { ...e.final };
      const t = taskOf(e), u = t ? host.usageOf(t) : null;
      const status = e.error ? 'error' : e.queued ? 'queued' : t?.status === 'todo' && tileOf(c) != null ? 'doing' : t?.status || null; // a worker only claims the task when it starts; its tile being open means it is working
      const total = u ? (u.tokens.input || 0) + (u.tokens.output || 0) + (u.tokens.cacheWrite || 0) : 0, free = !!u?.free || (!u?.escalated && /^opencode\/big-pickle$|-free$/i.test(e.model || '')); // the tile's last usage event can lack the free flag; the model is also known free
      const usd = free ? 0 : c.usd === undefined ? null : c.usd;
      return { status, note: t?.note || null, check: t?.check ? { ok: !!t.check.ok, command: t.check.command || 'checks', summary: t.check.summary || '' } : null, diffStat: t?.diffStat || null,
        total, free, usd, paid: free ? 0 : total, ms: e.startedAt ? Date.now() - e.startedAt : null, u };
    }
    // Prices a card's tokens through main (its price table; an unknown model stays unknown) and freezes the card once it is done or failed.
    function watch(c) {
      const e = c.entry;
      if (e.final) return;
      const v = view(c), u = v.u;
      if (u && v.total && !u.free) {
        const segs = (u.segments || []).filter(x => x && x.tokens && (x.tokens.input || x.tokens.output || x.tokens.cacheWrite || x.tokens.cacheRead));
        if (!segs.length || segs.some(x => !x.model)) c.usd = null; // no model recorded for some tokens: no honest price
        else {
          const key = JSON.stringify(segs);
          if (c.costKey !== key) {
            c.costKey = key;
            Promise.all(segs.map(x => Promise.resolve(op.priceTokens?.(x.model, x.tokens)).catch(() => null)))
              .then(rs => { if (c.costKey !== key) return; c.usd = sumSegmentUsd(rs); c.html = null; paint(); }).catch(() => { c.usd = null; });
          }
        }
      }
      if ((v.status === 'done' || v.status === 'failed' || v.status === 'cancelled') && (c.usd !== undefined || !v.total || v.free)) {
        const { u: _u, ...rest } = v;
        e.final = { ...rest, ms: e.startedAt ? Date.now() - e.startedAt : null };
        persist(e);
      }
    }
    function cardHtml(c) {
      const e = c.entry, t = taskOf(e), v = view(c), [label, look] = STATUS[v.status] || ['Not on the board', 'wait'];
      const pick = [e.agent, e.model, e.effort].filter(Boolean).join(' · ');
      const check = v.check ? `<span class="${v.check.ok ? 'ot-ok' : 'ot-bad'}" title="${esc(v.check.summary || '')}">${v.check.ok ? '✓' : '✗'} ${esc(v.check.command)}</span>` : '';
      const tile = tileOf(c), reviewing = !e.final && (t?.status === 'review' || t?.status === 'blocked');
      const facts = [check, v.diffStat && esc(v.diffStat), tokenLine(v) && esc(tokenLine(v)), v.ms != null && v.status !== 'queued' && esc(fmtMs(v.ms))].filter(Boolean).join(' · ');
      const inp = c.input, open = !e.final && !e.error && t && !isSettled(v.status) && t.status !== 'review', ask = c.ask;
      const INPUT = { msg: 'Message for the worker', reject: 'Why? The worker is told this', close: 'Why are you closing it? Saved on the task', reply: 'Your answer; the worker is told this' };
      const askHtml = ask ? `<div class="ot-ask"><div class="ot-ask-q"><b>The worker asks:</b> ${renderText(ask.question)}</div>${ask.detail ? `<div class="ot-dim">${renderText(ask.detail)}</div>` : ''}
        <div class="ot-card-acts">${ask.options.map((o, i) => `<button class="btn${i ? '' : ' primary'}" data-c="ask-opt" data-i="${i}">${esc(o)}</button>`).join('')}<button class="btn" data-c="ask-type">Type an answer</button></div></div>` : '';
      const acts = [
        reviewing ? '<button class="btn primary" data-c="approve">Approve</button><button class="btn" data-c="reject">Reject</button>' : '',
        t?.status === 'blocked' && !e.final ? '<button class="btn" data-c="reply">Reply</button>' : '',
        tile != null ? '<button class="btn" data-c="open">Open tile</button>' : '',
        tile != null && t && !e.final ? '<button class="btn" data-c="msg">Message worker</button>' : '',
        open && tile != null ? '<button class="btn" data-c="stop" title="Interrupt the worker&#39;s current step (like Esc); the task stays open">Stop</button>' : '',
        (t || e.queued) && !e.final && !e.error && !['done', 'cancelled'].includes(t?.status) ? '<button class="btn" data-c="close" title="Stop the worker and close the task">Close</button><button class="btn" data-c="close-why">Close with reason</button>' : '',
      ].join('');
      const live = tile != null && !e.final ? host.activityOf?.(tile) : null, last = live?.items[live.items.length - 1];
      const feed = last ? `<details class="ot-feed"${c.feedOpen ? ' open' : ''}><summary><span class="ot-dim">${live.count} step${live.count === 1 ? '' : 's'} ·</span> ${esc(clip((last.who ? last.who + ': ' : '') + last.text, 100))}</summary>
        <div class="ot-feed-list">${live.items.slice(-15).map(a => `<div>${a.who ? `<span class="ot-dim">${esc(clip(a.who, 28))}</span> ` : ''}${esc(a.text)}</div>`).join('')}</div></details>` : '';
      return `<div class="ot-card-head">${host.tierDot(e.tier)}<b class="ot-card-title">${esc(`#${e.idx + 1} ${e.title || 'Task'}`)}</b><span class="ot-pill ${look}">${esc(label)}</span></div>
        ${pick ? `<div class="ot-dim">${esc(pick)}${e.tier ? ' · ' + esc(e.tier) : ''}${e.boardId != null ? ' · task #' + e.boardId : ''}</div>` : ''}
        ${e.why ? `<div class="ot-why">${esc(e.why)}</div>` : ''}
        ${e.error ? `<div class="ot-bad">${esc(e.error)}</div>` : ''}
        ${v.note ? `<div class="ot-note">${renderText(v.note)}</div>` : ''}
        ${facts ? `<div class="ot-dim">${facts}</div>` : ''}
        ${feed}
        ${askHtml}
        <div class="ot-card-acts">${acts}</div>
        ${inp ? `<div class="ot-reject"><input class="ot-reject-note" type="text" placeholder="${INPUT[inp.kind] || ''}" value="${esc(inp.text)}"><button class="btn primary" data-c="input-send">${inp.kind === 'close' ? 'Close task' : 'Send'}</button><button class="btn" data-c="input-cancel">Cancel</button></div>` : ''}`;
    }
    function card(entry) {
      const key = `${entry.requestId}:${entry.idx}`, old = cards.get(key);
      if (old) { Object.assign(old.entry, entry); old.html = null; if (st.restored) paint(); return old.node; }
      const c = { entry, input: null, key, html: null, usd: undefined, costKey: null, task: null };
      c.node = append(`<div class="ot-card"></div>`);
      c.node.innerHTML = cardHtml(c);
      cards.set(key, c);
      st.latest = entry.requestId;
      const r = req(entry.requestId);
      if (!r.foot) {
        r.foot = document.createElement('div'); r.foot.className = 'ot-foot ot-dim';
        r.foot.innerHTML = '<span class="ot-foot-text"></span><button class="btn ot-stop-all hidden" title="Interrupt every running task of this request">Stop all</button>';
        r.foot.querySelector('.ot-stop-all').addEventListener('click', () => stopAll(entry.requestId).catch(err => host.toast(`<b>${esc(err.message || err)}</b>`)));
      }
      log.appendChild(r.foot); // the request's footer stays under its newest card
      return c.node;
    }
    // ---- follow-up target: "follow up on #n" (default: the last task still running) or a new request
    function drawTarget() {
      const cs = st.latest ? cardsOf(st.latest) : [];
      targetRow.classList.toggle('hidden', !cs.length);
      if (!cs.length) return;
      const items = cs.map(c => ({ key: c.key, settled: isSettled(view(c).status), label: `#${c.entry.idx + 1} ${clip(c.entry.title, 40)}` }));
      const html = [...items.map(i => `<option value="${esc(i.key)}">Follow up on ${esc(i.label)}</option>`), '<option value="new">New request</option>'].join('');
      const keep = st.picked && (items.some(i => i.key === target.value) || target.value === 'new') ? target.value : defaultTarget(items);
      if (target.dataset.sig !== html) { target.innerHTML = html; target.dataset.sig = html; }
      target.value = keep;
    }
    target.addEventListener('change', () => { st.picked = true; });
    function paint() {
      for (const c of cards.values()) {
        if (!c.node.isConnected) continue;
        watch(c);
        if (c.node.contains(document.activeElement) && document.activeElement.matches('input')) continue; // typing a note
        const html = cardHtml(c);
        if (html !== c.html) { c.html = html; c.node.innerHTML = html; }
      }
      for (const [rid, r] of reqs) {
        const cs = cardsOf(rid);
        if (!r.foot || !cs.length) continue;
        const paidCards = cs.map(view).filter(v => v.paid);
        const text = requestFooter({ refiner: r.refiner, paid: paidCards.reduce((n, v) => n + v.paid, 0), usd: paidCards.reduce((n, v) => n + (v.usd || 0), 0), unknown: paidCards.filter(v => v.usd == null).length });
        const ft = r.foot.querySelector('.ot-foot-text');
        if (ft.textContent !== text) ft.textContent = text;
        r.foot.querySelector('.ot-stop-all').classList.toggle('hidden', cs.filter(c => !isSettled(view(c).status)).length < 2);
      }
      drawTarget();
      if (st.restored) checkSummaries();
    }
    // Every task of a request settled (and priced): one Operant summary line, and a notification if you're away.
    function checkSummaries() {
      for (const [rid, r] of reqs) {
        const cs = cardsOf(rid);
        if (!cs.length || r.summarized === cs.length) continue;
        const vs = cs.map(view);
        if (!vs.every(v => isSettled(v.status)) || cs.some((c, i) => c.costKey && c.usd === undefined && !c.entry.final && !vs[i].free)) continue;
        r.summarized = cs.length;
        const text = summaryText({ refiner: r.refiner, tasks: cs.map((c, i) => ({ title: c.entry.title, status: vs[i].status, error: c.entry.error, note: vs[i].note, paid: vs[i].paid, usd: vs[i].usd })) });
        line(save({ role: 'operant', kind: 'summary', requestId: rid, count: cs.length, text }));
        host.notifyAway(`Operant: ${vs.filter(v => v.status === 'done').length} of ${cs.length} tasks done`, clip(text, 200));
      }
    }
    function refreshCards() { dropStaleAsks(); pump(); paint(); }

    // ---- stopping, closing and answering (item 83)
    const stopCard = async c => { const tile = tileOf(c); if (tile != null) await host.control('stop', { id: tile }); };
    // Close = the worker stops, its tile closes and the task ends as Closed (with your reason, if any); a queued one never starts.
    async function closeCard(c, reason) {
      if (c.ask) answerAsk(c, null);
      const qi = st.queue.indexOf(c);
      if (qi >= 0 || (c.entry.queued && c.entry.boardId == null)) {
        if (qi >= 0) st.queue.splice(qi, 1);
        Object.assign(c.entry, { queued: false, error: reason ? `Closed before it started: ${reason}` : 'Closed before it started' });
        persist(c.entry); c.html = null; return;
      }
      const t = taskOf(c.entry);
      if (t) await host.control('task', { sub: 'cancel', id: t.id, ...(reason ? { note: reason } : {}) });
    }
    // Your answer: to the worker's open question if it has one; a live worker gets it as a message; else a follow-up task.
    async function replyCard(c, text) {
      if (c.ask) return answerAsk(c, text);
      if (tileOf(c) != null) {
        await host.message(tileOf(c), flatText(text));
        line(save({ role: 'operant', kind: 'info', requestId: c.entry.requestId, text: `Answer sent to #${c.entry.idx + 1}.` }));
      } else await followUp(c, text);
    }
    function answerAsk(c, answer) {
      const a = c.ask; if (!a) return;
      c.ask = null; c.html = null;
      a.resolve(answer ?? null);
      line(save({ role: 'operant', kind: 'info', requestId: c.entry.requestId, text: answer == null ? `#${c.entry.idx + 1}'s question was dismissed.` : `Answered #${c.entry.idx + 1}: ${clip(answer, 200)}` }));
      paint();
    }
    // A question whose worker is gone resolves as dismissed.
    function dropStaleAsks() { for (const c of cards.values()) if (c.ask && !host.tileAlive(c.ask.tile)) answerAsk(c, null); }
    // `operant ask` from one of this Terminal's workers: its card shows the question; resolves with your answer (null = dismissed).
    function ask({ taskId, tile, question, detail, options }) {
      const c = [...cards.values()].find(x => taskOf(x.entry)?.id === taskId);
      if (!c) return Promise.resolve(null);
      if (c.ask) c.ask.resolve(null);
      return new Promise(resolve => {
        c.ask = { tile, question, detail: detail || '', options: options?.length ? options : ['Yes', 'No'], resolve };
        c.html = null;
        line(save({ role: 'operant', kind: 'question', requestId: c.entry.requestId, text: `#${c.entry.idx + 1} ${clip(c.entry.title, 60)} asks: ${question}` }));
        paint();
        c.node.scrollIntoView({ block: 'nearest' });
        st.picked = true; if ([...target.options].some(o => o.value === c.key)) target.value = c.key; // what you type next answers it
        host.notifyAway('Operant: a worker has a question', clip(question, 200));
      });
    }
    async function stopAll(rid) {
      for (const c of cardsOf(rid)) {
        const qi = st.queue.indexOf(c);
        if (qi >= 0) { st.queue.splice(qi, 1); Object.assign(c.entry, { queued: false, error: 'Stopped before it started' }); persist(c.entry); c.html = null; }
        else if (!isSettled(view(c).status)) await stopCard(c).catch(() => {});
      }
      line(save({ role: 'operant', kind: 'info', requestId: rid, text: 'Stopped every running task of this request. Each stays open: message it, or close it.' }));
      paint();
    }
    log.addEventListener('click', async e => {
      const b = e.target.closest('[data-c]');
      const node = b?.closest('.ot-card'), c = node && [...cards.values()].find(x => x.node === node);
      if (!c) return;
      const t = taskOf(c.entry), what = b.dataset.c;
      try {
        if (what === 'open') host.focusTile(tileOf(c));
        else if (what === 'approve' && t) await host.control('task', { sub: 'approve', id: t.id });
        else if (what === 'stop') await stopCard(c);
        else if (what === 'close') await closeCard(c, '');
        else if (what === 'ask-opt' && c.ask) answerAsk(c, c.ask.options[Number(b.dataset.i)]);
        else if (['reject', 'msg', 'reply', 'ask-type', 'close-why'].includes(what)) {
          c.input = { kind: what === 'ask-type' ? 'reply' : what === 'close-why' ? 'close' : what, text: '' };
          c.node.innerHTML = cardHtml(c); c.node.querySelector('.ot-reject-note').focus(); return;
        }
        else if (what === 'input-cancel') { c.input = null; }
        else if (what === 'input-send') {
          const note = c.node.querySelector('.ot-reject-note').value.trim(), kind = c.input?.kind;
          if (!note) return c.node.querySelector('.ot-reject-note').focus();
          c.input = null;
          if (kind === 'reject' && t) await host.control('task', { sub: 'reject', id: t.id, note });
          else if (kind === 'msg' && tileOf(c) != null) await host.message(tileOf(c), flatText(note));
          else if (kind === 'close') await closeCard(c, note);
          else if (kind === 'reply') await replyCard(c, note);
        }
      } catch (err) { host.toast(`<b>${esc(err.message || err)}</b>`); }
      c.html = null; paint();
    });
    // A card's activity feed stays open (or shut) across repaints.
    log.addEventListener('toggle', e => {
      if (!e.target.matches?.('.ot-feed')) return;
      const c = [...cards.values()].find(x => x.node === e.target.closest('.ot-card'));
      if (c) { c.feedOpen = e.target.open; c.html = cardHtml(c); }
    }, true);
    log.addEventListener('keydown', e => {
      if (!e.target.matches('.ot-reject-note')) return;
      if (e.key === 'Enter') { e.preventDefault(); e.target.closest('.ot-card').querySelector('[data-c="input-send"]').click(); }
      else if (e.key === 'Escape') { e.stopPropagation(); e.target.closest('.ot-card').querySelector('[data-c="input-cancel"]').click(); }
    });

    // ---- dispatch (item 76): each task goes to the `agent` control with the refiner's agent, model, effort and tier; a board
    // task with the tier, requestId and source is always made (the cards need it). Past max workers the rest wait in st.queue.
    async function startTask(c) {
      const e = c.entry;
      try {
        assertTierAllowed(e.tier, host.allowedTiers());
        const r = await host.control('agent', dispatchArgs(c.task, { requestId: e.requestId, idx: e.idx, cwd: project }));
        Object.assign(e, { queued: false, boardId: r.taskId ?? null, tile: r.id ?? null, tier: r.tier || e.tier, startedAt: Date.now() });
      } catch (err) {
        const msg = String(err.message || err);
        if (/max workers/i.test(msg)) return false; // a slot went to someone else in between: stay queued
        Object.assign(e, { queued: false, error: msg });
      }
      persist(e);
      return true;
    }
    async function pump() {
      if (st.pumping) return;
      st.pumping = true;
      try {
        while (st.queue.length && host.freeWorkers() > 0) {
          if (!await startTask(st.queue[0])) break;
          st.queue.shift();
        }
      } finally { st.pumping = false; }
      paint();
    }
    // Starts what fits and queues the rest; the cards appear at once. base = the index of the first new task in the request.
    async function launch(requestId, tasks, base) {
      const plan = planDispatch(tasks, { free: host.freeWorkers(), allowed: host.allowedTiers() });
      const made = tasks.map((t, i) => {
        const idx = base + i;
        line(save({ role: 'task', requestId, idx, boardId: null, tile: null, title: t.title, agent: t.agent, model: t.model, effort: t.effort, tier: t.tier, why: t.why, files: t.files,
          prompt: String(t.prompt || '').slice(0, 2000), queued: plan.queued.includes(i), ...(plan.errors[i] ? { error: plan.errors[i] } : {}) }));
        const c = cards.get(`${requestId}:${idx}`);
        c.task = t;
        return c;
      });
      paint();
      for (const i of plan.start) {
        if (!await startTask(made[i])) { made[i].entry.queued = true; st.queue.push(made[i]); }
        paint();
      }
      for (const i of plan.queued) st.queue.push(made[i]);
      paint();
    }
    async function send(res, which) {
      let tasks = which === 'original' ? [{ title: clip(res.original, 60), prompt: res.original }]
        : bundleTasks(res.tasks, { kindOf: host.agentKind || (() => 'other'), allowed: host.allowedTiers(), limit: host.subagentLimit?.() || 9 });
      if (st.tier) tasks.forEach((t, i) => { tasks[i] = { ...t, tier: st.tier, agent: undefined, model: undefined, effort: undefined, why: `/tier ${st.tier}` }; });
      await launch(res.requestId, tasks, 0);
    }
    // ---- follow-ups (item 78): a short structured handoff, never the history
    async function followUp(c, text) {
      const e = c.entry, t = taskOf(e), tile = tileOf(c), v = view(c);
      const next = Math.max(...cardsOf(e.requestId).map(x => x.entry.idx)) + 1;
      const plan = followUpPlan({ entry: e, note: t?.note || v.note, live: isLive(t?.status, tile != null), ask: text, nextIdx: next });
      if (plan.kind === 'message') {
        const info = txt => line(save({ role: 'operant', kind: 'info', requestId: e.requestId, text: txt }));
        try {
          const r = await host.message(tile, plan.text);
          if (r?.delivered) { info(`Follow-up delivered to #${e.idx + 1}.`); return; }
          info(`Follow-up queued for #${e.idx + 1}.`);
          const timer = setInterval(() => {
            if (!el.isConnected || !host.tileAlive(tile)) { clearInterval(timer); return; }
            if (host.queuedFor?.(tile) > 0) return;
            clearInterval(timer);
            info(`Follow-up delivered to #${e.idx + 1}.`);
          }, 1000);
        } catch (err) { info(`Could not reach the worker on #${e.idx + 1}: ${String(err.message || err)}`); }
        return;
      }
      await launch(e.requestId, [plan.task], plan.idx);
    }

    // ---- review (item 75)
    function reviewHtml(res) {
      const cleaned = res.cleaned && res.cleaned.trim() !== res.original.trim() ? res.cleaned : null;
      const d = cleaned ? diffHtml(res.original, cleaned) : null, r = res.refiner;
      const before = estTokens(res.original), after = estTokens(cleaned || res.original);
      const rmeta = r && (r.tokens || r.provider) ? [r.provider && `${r.provider}${r.model ? ' ' + r.model : ''}`, r.tokens && `${fmtN(r.tokens.input || 0)} in / ${fmtN(r.tokens.output || 0)} out`, r.usd != null ? fmtUsd(r.usd) : r.tokens ? 'cost unknown' : null].filter(Boolean).join(' · ') : '';
      const mn = modeNote(res.mode || host.agentMode?.().mode, r?.provider);
      return `<div class="ot-review" tabindex="-1"><div class="ot-rv-head"><b>Review</b>${mn.label ? `<span class="ot-dim"> · ${esc(mn.label)} · </span>` : ''}<span class="ot-dim">${esc(res.summary)}</span></div>
        ${mn.note ? `<div class="ot-dim ot-rv-meta">${esc(mn.note)}</div>` : ''}
        ${res.error ? `<div class="ot-bad ot-rv-err">${esc(clip(res.error, 160))}. Your prompt goes as written.</div>` : ''}
        ${d ? `<div class="ot-cols"><div><h4>Your prompt</h4><div class="ot-pre">${d.original}</div></div><div><h4>Cleaned</h4><div class="ot-pre">${d.cleaned}</div></div></div>`
          : `<div class="ot-pre">${esc(res.original)}</div>`}
        <div class="ot-dim ot-rv-meta">≈${fmtN(before)} → ≈${fmtN(after)} tokens (estimated)${rmeta ? ` · refiner: ${esc(rmeta)}` : ''}</div>
        <div class="ot-tasks">${res.tasks.map((t, i) => `<div class="ot-task"><div>${host.tierDot(t.tier)}<b>${i + 1}. ${esc(t.title)}</b>
          <span class="ot-dim">${esc([t.agent, t.model, t.effort].filter(Boolean).join(' · ') || 'routing picks')}${t.tier ? ' · ' + esc(t.tier) : ''}</span></div>
          ${t.why ? `<div class="ot-why">${esc(t.why)}</div>` : ''}${t.files?.length ? `<div class="ot-dim ot-mono">${esc(t.files.join(', '))}</div>` : ''}</div>`).join('')}</div>
        <div class="ot-actions"><button class="btn primary" data-r="send"><kbd>Enter</kbd> Send</button>${cleaned ? '<button class="btn" data-r="edit"><kbd>E</kbd> Edit</button>' : ''}
          <button class="btn" data-r="original"><kbd>O</kbd> Send original</button><button class="btn" data-r="discard"><kbd>Esc</kbd> Discard</button></div></div>`;
    }
    function showReview(res) {
      log.querySelector('.ot-hello')?.remove();
      const node = append(reviewHtml(res));
      st.review = { res, node };
      box.placeholder = 'Enter sends · E edits · O sends your original · Esc discards';
      node.focus({ preventScroll: true }); // so Enter, E, O and Esc work even right after typing in the box
    }
    function endReview() { st.review?.node.remove(); st.review = null; box.placeholder = 'Ask Operant to do something…'; }
    function reviewAct(what) {
      const rv = st.review;
      if (!rv) return;
      endReview();
      if (what === 'discard') line(save({ role: 'operant', kind: 'info', requestId: rv.res.requestId, text: 'Discarded. Nothing was sent.' }));
      else if (what === 'edit') { box.value = rv.res.cleaned || rv.res.original; autosize(); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      else send(rv.res, what === 'original' ? 'original' : 'cleaned');
    }
    el.addEventListener('click', e => { if (e.target.closest('[data-ot-settings]')) { e.preventDefault(); host.openProjectSettings?.(); return; } const b = e.target.closest('[data-r]'); if (b && st.review) reviewAct(b.dataset.r); });

    // ---- the prompt
    const tick = () => { const s = Math.round((Date.now() - st.refining.at) / 1000); status.querySelector('.ot-elapsed').textContent = s ? ` ${s}s` : ''; };
    function showStatus() {
      status.innerHTML = `<span class="ot-spin"></span><span>${esc(host.refinerLabel())}</span><span class="ot-elapsed"></span><span class="ot-dim"> · Esc cancels</span>`;
      status.classList.remove('hidden');
      statusTimer = setInterval(tick, 1000);
    }
    function hideStatus() { clearInterval(statusTimer); status.classList.add('hidden'); }
    // A project limited to a CLI that can't run right now: say so, keep the prompt in the box, send nothing.
    function noTiers(prompt, label) {
      box.value = prompt; autosize();
      log.querySelector('.ot-hello')?.remove();
      append(`<div class="ot-msg operant"><span class="ot-who">Operant</span><div class="ot-body">This project is set to ${esc(label)}, but nothing for it can run right now (is that CLI installed?). Nothing was sent. Change it in <a href="#" data-ot-settings>Settings › Agents › Operant Terminal</a>.</div></div>`);
    }
    async function refine(prompt) {
      const am = host.agentMode?.();
      if (am?.empty) return noTiers(prompt, am.label);
      const token = { at: Date.now(), prompt, cancelled: false };
      st.refining = token; showStatus();
      let res, error = null;
      try {
        res = op.terminalRefine ? await op.terminalRefine(project, prompt) : null; // no refiner wired: the prompt goes through as one task
      } catch (err) { error = String(err.message || err); }
      if (token.cancelled) return;
      st.refining = null; hideStatus();
      res = normalizeResult(res, prompt, error);
      if (res.noTiers) return noTiers(prompt, MODE_NAMES[res.mode] || 'one agent');
      line(save({ role: 'refiner', requestId: res.requestId, original: res.original, cleaned: res.cleaned, summary: res.summary, refiner: res.refiner, error: res.error, tasks: res.tasks.map(t => t.title) }));
      if (res.question) {
        st.question = { original: prompt, question: res.question };
        line(save({ role: 'operant', kind: 'question', requestId: res.requestId, text: res.question }));
        return;
      }
      if (host.autoSend()) send(res, 'cleaned'); else showReview(res);
    }
    function cancelRefine() {
      const tk = st.refining;
      tk.cancelled = true; st.refining = null; hideStatus();
      box.value = tk.prompt; autosize(); box.focus();
      line(save({ role: 'operant', kind: 'info', text: 'Cancelled. Your prompt is back in the box.' }));
    }
    function submit() {
      const text = box.value.trim();
      if (!text || st.refining) return;
      if (st.review) endReview();
      closeMenu();
      st.hist.push(text); st.histIdx = st.hist.length; st.draft = '';
      box.value = ''; autosize();
      line(save({ role: 'user', text }));
      const kind = st.question ? 'prompt' : inputKind(text);
      if (kind === 'slash') return void runSlash(parseSlash(text)).catch(err => info(String(err.message || err)));
      if (kind === 'shell') return void runShell(text.slice(1).trim());
      if (kind === 'memory') return void remember(text.slice(1).trim());
      const q = st.question;
      st.question = null;
      const tc = !q && !targetRow.classList.contains('hidden') && target.value !== 'new' ? cards.get(target.value) : null;
      st.picked = false;
      if (tc?.ask) { answerAsk(tc, text); return; }
      if (tc) { followUp(tc, text); return; }
      refine(q ? `${q.original}\n\nYou asked: ${q.question}\nMy answer: ${text}` : text);
    }
    const info = (text, rid) => line(save({ role: 'operant', kind: 'info', ...(rid ? { requestId: rid } : {}), text }));
    // #n: the newest card with that number.
    const cardN = n => [...cards.values()].filter(c => c.entry.idx === n - 1).pop() || null;
    const needCard = cmd => { if (cmd.card == null) throw new Error(`/${cmd.name} needs a task number, like /${cmd.name} #1`); const c = cardN(cmd.card); if (!c) throw new Error(`There is no task #${cmd.card}.`); return c; };
    async function runSlash(cmd) {
      const n = cmd.name;
      if (!cmd.known) return info(`Unknown command /${n}. /help lists them.`);
      if (n === 'help') return info(['Commands:', ...SLASH.map(x => `/${x.name}${x.args ? ' ' + x.args : ''} - ${x.desc}`), '',
        '!<command> runs it in a shell tile and shows the result · #<fact> saves a project memory · @ completes a file path',
        'Ctrl+R searches earlier prompts · Esc Esc clears the box · pasted images go to the workers as files'].join('\n'));
      if (n === 'clear') return $('[data-v="clear"]').click();
      if (n === 'settings') return host.openProjectSettings?.();
      if (n === 'diff') { await host.control('diff', { dir: project, focus: true }); return; }
      if (n === 'auto') { host.setAutoSend(!host.autoSend()); drawAuto(); return info(`Auto-send is ${host.autoSend() ? 'on: cleaned prompts go straight to the agents' : 'off: you review each cleaned prompt first'}.`); }
      if (n === 'tier') {
        const want = cmd.rest.toLowerCase();
        if (!want || want === 'auto') { st.tier = null; return info('Tiers are picked per task again.'); }
        const allowed = host.allowedTiers();
        if (!allowed.includes(want)) throw new Error(`No tier "${want}" here. Allowed: ${allowed.join(', ') || 'none'}.`);
        st.tier = want; drawHint();
        return info(`Your next prompts all run on the ${want} tier. /tier auto goes back to per-task picks.`);
      }
      if (n === 'original') {
        if (!cmd.rest) throw new Error('/original needs the prompt, like /original fix the login bug');
        return send({ requestId: newId(), original: cmd.rest, tasks: [] }, 'original');
      }
      if (n === 'stop') {
        if (cmd.card == null) { if (!st.latest) throw new Error('Nothing is running.'); return stopAll(st.latest); }
        const c = needCard(cmd); await stopCard(c); return info(`Stopped #${cmd.card}. It stays open: message it, or /close #${cmd.card}.`, c.entry.requestId);
      }
      if (n === 'close') { const c = needCard(cmd); await closeCard(c, cmd.rest); paint(); return; }
      if (n === 'approve' || n === 'reject') {
        const c = needCard(cmd), t = taskOf(c.entry);
        if (!t || t.status !== 'review' && t.status !== 'blocked') throw new Error(`#${cmd.card} is not waiting for review.`);
        if (n === 'reject' && !cmd.rest) throw new Error('/reject needs the reason, like /reject #1 the tests still fail');
        await host.control('task', n === 'approve' ? { sub: 'approve', id: t.id } : { sub: 'reject', id: t.id, note: cmd.rest });
        paint(); return;
      }
      if (n === 'retry') {
        const c = needCard(cmd), e = c.entry, next = Math.max(...cardsOf(e.requestId).map(x => x.entry.idx)) + 1;
        return launch(e.requestId, [{ title: `Retry: ${clip(e.title, 50)}`, prompt: c.task?.prompt || e.prompt, agent: e.agent, model: e.model, effort: e.effort, tier: e.tier, files: e.files, why: `Retry of #${cmd.card}` }], next);
      }
      if (n === 'tasks') {
        const all = [...cards.values()];
        if (!all.length) return info('No tasks yet.');
        return info(all.slice(-20).map(c => { const v = view(c); return `#${c.entry.idx + 1} ${clip(c.entry.title, 60)} - ${statusOf({ status: v.status })[0]}${c.entry.tier ? ' · ' + c.entry.tier : ''}${c.entry.boardId != null ? ' · task ' + c.entry.boardId : ''}`; }).join('\n'));
      }
      if (n === 'cost') {
        const vs = [...cards.values()].map(view), paid = vs.reduce((a, v) => a + (v.paid || 0), 0), usd = vs.reduce((a, v) => a + (v.usd || 0), 0);
        const unknown = vs.filter(v => v.paid && v.usd == null).length, freeTok = vs.filter(v => v.free).reduce((a, v) => a + (v.total || 0), 0);
        const ref = [...reqs.values()].map(r => r.refiner?.tokens).filter(Boolean).reduce((a, t) => a + (t.input || 0) + (t.output || 0), 0);
        return info([`${vs.length} task${vs.length === 1 ? '' : 's'} in this conversation.`, `Paid tokens: ${fmtN(paid)}${paid ? (unknown ? ` (≈ ${fmtUsd(usd) || '$0'} plus ${unknown} unpriced)` : ` (≈ ${fmtUsd(usd) || '$0'})`) : ''}.`,
          `Free tokens: ${fmtN(freeTok)}.`, `Refiner: ${fmtN(ref)} tokens.`].join('\n'));
      }
      if (n === 'status') {
        const am = host.agentMode?.() || {}, allowed = host.allowedTiers();
        return info([`Agents: ${am.label || 'Claude and OpenCode'}.`, `Tiers allowed: ${allowed.join(', ') || 'none'}${st.tier ? ` (next prompts: ${st.tier})` : ''}.`,
          `Free worker slots: ${host.freeWorkers()}. Subagents per worker: up to ${host.subagentLimit?.() || 9}.`, `Auto-send: ${host.autoSend() ? 'on' : 'off'}. Waiting to start: ${st.queue.length}.`].join('\n'));
      }
    }
    // !command: runs in its own shell tile; the output comes back here once it goes quiet.
    async function runShell(command) {
      const r = await host.control('run', { command, cwd: project, title: `! ${clip(command, 36)}` }).catch(err => { info(String(err.message || err)); return null; });
      if (!r) return;
      const node = line(save({ role: 'operant', kind: 'info', text: `Running \`${clip(command, 120)}\` in tile ${r.id}...` }));
      try {
        const out = await host.control('wait', { id: r.id, lines: 60 });
        const text = shellOutput(out?.text);
        info(`Output of \`${clip(command, 120)}\` (tile ${r.id}):\n\`\`\`\n${text || '(no output)'}\n\`\`\``);
      } catch (err) { info(`Could not read tile ${r.id}: ${String(err.message || err)}`); }
      void node;
    }
    async function remember(text) {
      if (!text) return;
      try {
        const r = await op.memory('remember', { cwd: project, text });
        if (r && r.ok === false) throw new Error(r.error);
        info(`Saved to project memory: ${clip(text, 160)}`);
      } catch (err) { info(`Could not save it: ${String(err.message || err)}`); }
    }

    // ---- the menu above the box: / commands, @ files, Ctrl+R history. Arrows move, Tab or Enter picks, Esc closes.
    let files = null, filesAt = 0;
    async function projectFiles() {
      if (!files || Date.now() - filesAt > 20000) { filesAt = Date.now(); files = await Promise.resolve(op.listFiles?.(project)).catch(() => []) || []; }
      return files;
    }
    function drawMenu() {
      const m = st.menu;
      menu.classList.toggle('hidden', !m || !m.items.length);
      if (!m || !m.items.length) { menu.innerHTML = ''; return; }
      m.sel = Math.min(Math.max(0, m.sel), m.items.length - 1);
      menu.innerHTML = (m.kind === 'hist' ? '<div class="ot-menu-head">Earlier prompts</div>' : '') + m.items.map((it, i) => `<div class="ot-menu-item${i === m.sel ? ' sel' : ''}" data-i="${i}"><span class="ot-menu-label">${esc(it.label)}</span>${it.desc ? `<span class="ot-dim">${esc(it.desc)}</span>` : ''}</div>`).join('');
      menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
    function closeMenu() { st.menu = null; drawMenu(); }
    async function updateMenu() {
      const v = box.value, caret = box.selectionStart;
      if (st.menu?.kind === 'hist') { st.menu.items = histMatches(st.hist, v).map(h => ({ label: clip(h, 120), value: h })); return drawMenu(); }
      if (/^\/\S*$/.test(v) && caret === v.length) {
        st.menu = { kind: 'slash', sel: st.menu?.kind === 'slash' ? st.menu.sel : 0, items: slashMatches(v).map(x => ({ label: `/${x.name}${x.args ? ' ' + x.args : ''}`, desc: x.desc, value: `/${x.name}` })) };
        return drawMenu();
      }
      const at = atToken(v, caret);
      if (at) {
        const list = fileMatches(await projectFiles(), at.query);
        if (box.value !== v) return; // typed on while the list loaded
        st.menu = { kind: 'file', sel: st.menu?.kind === 'file' ? st.menu.sel : 0, at, items: list.map(f => ({ label: f, value: f })) };
        return drawMenu();
      }
      closeMenu();
    }
    function pickMenu(i = st.menu?.sel) {
      const m = st.menu, it = m?.items[i];
      if (!it) return;
      if (m.kind === 'slash') box.value = it.value + (SLASH.find(x => '/' + x.name === it.value)?.args ? ' ' : '');
      else if (m.kind === 'hist') box.value = it.value;
      else { const v = box.value, end = box.selectionStart; box.value = v.slice(0, m.at.start) + '@' + it.value + ' ' + v.slice(end); const pos = m.at.start + it.value.length + 2; box.setSelectionRange(pos, pos); }
      closeMenu(); autosize(); box.focus();
    }
    menu.addEventListener('mousedown', e => { const it = e.target.closest('.ot-menu-item'); if (it) { e.preventDefault(); pickMenu(Number(it.dataset.i)); } });
    // Menu keys first; true = the key was used.
    function menuKey(e) {
      const m = st.menu;
      if (!m || !m.items.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { m.sel += e.key === 'ArrowDown' ? 1 : -1; if (m.sel < 0) m.sel = m.items.length - 1; if (m.sel >= m.items.length) m.sel = 0; drawMenu(); return true; }
      if (e.key === 'Escape') { closeMenu(); return true; }
      if (e.key === 'Tab') { pickMenu(); return true; }
      if (e.key === 'Enter' && !e.shiftKey) {
        const it = m.items[m.sel];
        if (m.kind === 'slash' && box.value.trim() === it.value) { closeMenu(); return false; } // the whole command is typed: Enter runs it
        pickMenu(); return true;
      }
      return false;
    }
    const drawHint = () => { const h = el.querySelector('.ot-hint'); if (h) h.dataset.tier = st.tier || ''; box.placeholder = st.tier ? `Ask Operant to do something… (all on the ${st.tier} tier)` : 'Ask Operant to do something…'; };
    box.addEventListener('input', updateMenu);
    box.addEventListener('click', updateMenu);
    box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) closeMenu(); }, 100));
    box.addEventListener('input', autosize);
    box.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (st.refining) { if (e.key === 'Escape') { e.preventDefault(); cancelRefine(); } else if (e.key === 'Enter') e.preventDefault(); return; }
      if (menuKey(e)) { e.preventDefault(); return; }
      if (e.key === 'r' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); st.menu = { kind: 'hist', sel: 0, items: [] }; updateMenu(); return; }
      const act = st.review && reviewKey(e, box.value === '');
      if (act) { e.preventDefault(); return reviewAct(act); }
      if (e.key === 'Escape' && box.value) {
        if (Date.now() - st.lastEsc < 700) { e.preventDefault(); st.draft = ''; box.value = ''; autosize(); st.lastEsc = 0; return; }
        st.lastEsc = Date.now(); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); return submit(); }
      const lines = box.value.split('\n').length, multi = lines > 1;
      if (e.key === 'ArrowUp' && !e.shiftKey && (!multi || box.selectionStart === 0) && st.histIdx > 0) {
        e.preventDefault();
        if (st.histIdx === st.hist.length) st.draft = box.value;
        st.histIdx = historyStep(st.hist.length, st.histIdx, -1); box.value = st.hist[st.histIdx]; autosize();
        box.setSelectionRange(0, 0);
      } else if (e.key === 'ArrowDown' && !e.shiftKey && (!multi || box.selectionStart === box.value.length) && st.histIdx < st.hist.length) {
        e.preventDefault();
        st.histIdx = historyStep(st.hist.length, st.histIdx, 1); box.value = st.histIdx === st.hist.length ? st.draft : st.hist[st.histIdx]; autosize();
      }
    });
    // Text pastes as it is. An image is saved as a file and its path goes in the prompt, so the workers can open it.
    box.addEventListener('paste', async e => {
      if (![...(e.clipboardData?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/')) || e.clipboardData.getData('text')) return;
      e.preventDefault();
      const file = await Promise.resolve(op.saveClipboardImage?.()).catch(() => null);
      if (!file) { host.toast('<b>Could not save the pasted image</b>'); return; }
      const at = box.selectionStart, v = box.value, ins = `[image: ${file}] `;
      box.value = v.slice(0, at) + ins + v.slice(box.selectionEnd); box.setSelectionRange(at + ins.length, at + ins.length); autosize();
    });
    // Reads from the transcript (Ctrl+C on a selection) and clicks in it keep the keyboard on the box.
    el.addEventListener('keydown', e => {
      if (e.target !== box && !e.target.matches('input, select') && st.review) {
        const act = reviewKey(e, true);
        if (act) { e.preventDefault(); reviewAct(act); }
        else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) box.focus(); // anything else you type goes to the box
      }
    });

    // ---- header
    const drawAuto = () => { autoBtn.classList.toggle('on', host.autoSend()); autoBtn.title = host.autoSend() ? 'Auto-send is on for this project: cleaned prompts go straight to the agents' : 'Auto-send is off: you review the cleaned prompt first'; };
    autoBtn.addEventListener('click', () => { host.setAutoSend(!host.autoSend()); drawAuto(); });
    $('[data-v="clear"]').addEventListener('click', async () => {
      if (await op.ask({ message: 'Clear this conversation?', detail: 'The saved history for this project is deleted. Tasks already sent keep running.', buttons: ['Clear', 'Cancel'], cancelId: 1 }) !== 0) return;
      if (st.review) endReview();
      await op.terminalClear(project);
      log.innerHTML = ''; cards.clear(); reqs.clear(); st.queue = []; st.latest = null; st.hist = []; st.histIdx = 0; st.question = null; empty();
    });
    drawAuto();

    // ---- restore: the saved conversation
    (async () => {
      let saved = [];
      try { saved = (await op.terminalHistory(project, 300)) || []; } catch { /* no history yet */ }
      for (const e of saved) { line(e); if (e.role === 'user') st.hist.push(e.text); }
      st.histIdx = st.hist.length;
      // A task that was still waiting for a worker when Operant closed never started.
      for (const c of cards.values()) if (c.entry.queued && !c.task) { c.entry.queued = false; c.entry.error = 'Still waiting for a free worker when Operant closed, so it never started'; persist(c.entry); }
      st.restored = true;
      empty(); scroll(); refreshCards();
    })();
    const pulse = setInterval(() => { if (w.alive === false) return clearInterval(pulse); if (st.restored && (st.queue.length || [...cards.values()].some(c => !isSettled(view(c).status)))) refreshCards(); }, 5000);
    autosize();

    return { refresh: refreshCards, focus: () => box.focus({ preventScroll: true }), drawAuto, ask };
  }

  const api = { mount, modeNote, assertTierAllowed, dispatchArgs, planDispatch, bundleTasks, masterPrompt, SLASH, parseSlash, slashMatches, atToken, fileMatches, histMatches, inputKind, shellOutput, handoffText, isLive, isSettled, defaultTarget, tokenLine, requestFooter, summaryText, flatText, followUpPlan, sumSegmentUsd, diffOps, diffHtml, renderText, reviewKey, historyStep, normalizeResult, estTokens, statusOf, STATUS };
  return api;
})();

if (typeof window !== 'undefined') window.OperantTerminal = OperantTerminal;
if (typeof module !== 'undefined') module.exports = OperantTerminal;
