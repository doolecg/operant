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
      refiner: r.refiner || null, brief: r.brief || null, error: r.error || error || null,
    };
  }
  // Board status -> [label, look].
  const STATUS = { todo: ['Queued', 'wait'], doing: ['Working', 'run'], verifying: ['Running checks', 'run'], review: ['Ready for review', 'ok'],
    done: ['Done', 'ok'], failed: ['Failed', 'bad'], blocked: ['Blocked', 'bad'],
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
  // Follow-up for a worker: the task, what it was asked, its last note and the new ask; never the history.
  function handoffText({ title, asked, note, ask }) {
    return [`Follow-up on your task "${clip(title, 80)}".`, `You were asked: ${clip(asked, 400) || 'unknown'}`,
      `Your last note: ${clip(note, 400) || 'none'}`, `New ask: ${String(ask || '').trim()}`].join('\n');
  }
  const flatText = t => String(t).replace(/\s*\n\s*/g, ' ');
  // Open = a live worker is on it; anything else gets a new task.
  const LIVE = ['todo', 'doing', 'verifying'];
  const isLive = (status, tileAlive) => !!tileAlive && LIVE.includes(status);
  const SETTLED = ['done', 'failed', 'blocked', 'error'];
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
  //   tileAlive(id), allowedTiers() (names up to the top tier), freeWorkers(), usageOf(task) -> { tokens, free, model, escalated },
  //   message(tileId, text) (operant msg when messaging is on, else typed into the tile), notifyAway(title, body) }
  function mount(w, host) {
    const { el, cwd: project } = w, op = host.operant;
    const $ = s => el.querySelector(s);
    const log = $('.ot-log'), box = $('.ot-box textarea'), status = $('.ot-status'), autoBtn = $('[data-v="auto"]');
    const st = { review: null, question: null, refining: null, hist: [], histIdx: 0, draft: '', queue: [], pumping: false, restored: false, latest: null, picked: false };
    const cards = new Map(); // requestId:idx -> { entry, node, input, usd, costKey, html, task }
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
    const taskOf = e => e.boardId != null ? host.tasks().find(t => t.id === e.boardId) : null;
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
        if (u.escalated || !u.model) c.usd = null; // earlier attempts ran on other models: no honest single price
        else {
          const key = u.model + ':' + JSON.stringify(u.tokens);
          if (c.costKey !== key) {
            c.costKey = key;
            Promise.resolve(op.priceTokens?.(u.model, u.tokens)).then(r => { if (c.costKey !== key) return; c.usd = r && typeof r.usd === 'number' ? r.usd : null; c.html = null; paint(); }).catch(() => { c.usd = null; });
          }
        }
      }
      if ((v.status === 'done' || v.status === 'failed') && (c.usd !== undefined || !v.total || v.free)) {
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
      const inp = c.input;
      return `<div class="ot-card-head">${host.tierDot(e.tier)}<b class="ot-card-title">${esc(`#${e.idx + 1} ${e.title || 'Task'}`)}</b><span class="ot-pill ${look}">${esc(label)}</span></div>
        ${pick ? `<div class="ot-dim">${esc(pick)}${e.tier ? ' · ' + esc(e.tier) : ''}${e.boardId != null ? ' · task #' + e.boardId : ''}</div>` : ''}
        ${e.why ? `<div class="ot-why">${esc(e.why)}</div>` : ''}
        ${e.error ? `<div class="ot-bad">${esc(e.error)}</div>` : ''}
        ${v.note ? `<div class="ot-note">${renderText(v.note)}</div>` : ''}
        ${facts ? `<div class="ot-dim">${facts}</div>` : ''}
        <div class="ot-card-acts">${reviewing ? '<button class="btn primary" data-c="approve">Approve</button><button class="btn" data-c="reject">Reject</button>' : ''}${tile != null ? '<button class="btn" data-c="open">Open tile</button>' : ''}${tile != null && t && !e.final ? '<button class="btn" data-c="msg">Message worker</button>' : ''}</div>
        ${inp ? `<div class="ot-reject"><input class="ot-reject-note" type="text" placeholder="${inp.kind === 'msg' ? 'Message for the worker' : 'Why? The worker is told this'}" value="${esc(inp.text)}"><button class="btn primary" data-c="input-send">Send</button><button class="btn" data-c="input-cancel">Cancel</button></div>` : ''}`;
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
      if (!r.foot) { r.foot = document.createElement('div'); r.foot.className = 'ot-foot ot-dim'; }
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
        if (r.foot.textContent !== text) r.foot.textContent = text;
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
    function refreshCards() { pump(); paint(); }
    log.addEventListener('click', async e => {
      const b = e.target.closest('[data-c]');
      const node = b?.closest('.ot-card'), c = node && [...cards.values()].find(x => x.node === node);
      if (!c) return;
      const t = taskOf(c.entry), what = b.dataset.c;
      try {
        if (what === 'open') host.focusTile(tileOf(c));
        else if (what === 'approve' && t) await host.control('task', { sub: 'approve', id: t.id });
        else if (what === 'reject' || what === 'msg') { c.input = { kind: what, text: '' }; c.node.innerHTML = cardHtml(c); c.node.querySelector('.ot-reject-note').focus(); return; }
        else if (what === 'input-cancel') { c.input = null; }
        else if (what === 'input-send') {
          const note = c.node.querySelector('.ot-reject-note').value.trim(), kind = c.input?.kind;
          if (!note) return c.node.querySelector('.ot-reject-note').focus();
          c.input = null;
          if (kind === 'reject' && t) await host.control('task', { sub: 'reject', id: t.id, note });
          else if (kind === 'msg' && tileOf(c) != null) await host.message(tileOf(c), flatText(note));
        }
      } catch (err) { host.toast(`<b>${esc(err.message || err)}</b>`); }
      c.html = null; paint();
    });
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
      const tasks = which === 'original' ? [{ title: clip(res.original, 60), prompt: res.original }] : res.tasks;
      await launch(res.requestId, tasks, 0);
    }
    // ---- follow-ups (item 78): a short structured handoff, never the history
    async function followUp(c, text) {
      const e = c.entry, t = taskOf(e), tile = tileOf(c), v = view(c);
      if (isLive(t?.status, tile != null)) {
        try {
          const r = await host.message(tile, flatText(handoffText({ title: e.title, asked: e.prompt || t.text, note: t.note, ask: text })));
          line(save({ role: 'operant', kind: 'info', requestId: e.requestId, text: `Sent to the worker on #${e.idx + 1}${r?.delivered === false ? '; it gets it at its next turn' : ''}.` }));
        } catch (err) { line(save({ role: 'operant', kind: 'info', requestId: e.requestId, text: `Could not reach the worker on #${e.idx + 1}: ${String(err.message || err)}` })); }
        return;
      }
      const next = Math.max(...cardsOf(e.requestId).map(x => x.entry.idx)) + 1;
      await launch(e.requestId, [{ title: `Follow-up: ${clip(e.title, 50)}`, prompt: handoffText({ title: e.title, asked: e.prompt, note: v.note, ask: text }),
        agent: e.agent, model: e.model, effort: e.effort, tier: e.tier, why: `Follow-up on #${e.idx + 1}, same tier` }], next);
    }

    // ---- review (item 75)
    function reviewHtml(res) {
      const cleaned = res.cleaned && res.cleaned.trim() !== res.original.trim() ? res.cleaned : null;
      const d = cleaned ? diffHtml(res.original, cleaned) : null, r = res.refiner;
      const before = estTokens(res.original), after = estTokens(cleaned || res.original);
      const rmeta = r && (r.tokens || r.provider) ? [r.provider && `${r.provider}${r.model ? ' ' + r.model : ''}`, r.tokens && `${fmtN(r.tokens.input || 0)} in / ${fmtN(r.tokens.output || 0)} out`, r.usd != null ? fmtUsd(r.usd) : r.tokens ? 'cost unknown' : null].filter(Boolean).join(' · ') : '';
      return `<div class="ot-review" tabindex="-1"><div class="ot-rv-head"><b>Review</b><span class="ot-dim">${esc(res.summary)}</span></div>
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
    el.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (b && st.review) reviewAct(b.dataset.r); });

    // ---- the prompt
    const tick = () => { const s = Math.round((Date.now() - st.refining.at) / 1000); status.querySelector('.ot-elapsed').textContent = s ? ` ${s}s` : ''; };
    function showStatus() {
      status.innerHTML = `<span class="ot-spin"></span><span>${esc(host.refinerLabel())}</span><span class="ot-elapsed"></span><span class="ot-dim"> · Esc cancels</span>`;
      status.classList.remove('hidden');
      statusTimer = setInterval(tick, 1000);
    }
    function hideStatus() { clearInterval(statusTimer); status.classList.add('hidden'); }
    async function refine(prompt) {
      const token = { at: Date.now(), prompt, cancelled: false };
      st.refining = token; showStatus();
      let res, error = null;
      try {
        res = op.terminalRefine ? await op.terminalRefine(project, prompt) : null; // no refiner wired: the prompt goes through as one task
      } catch (err) { error = String(err.message || err); }
      if (token.cancelled) return;
      st.refining = null; hideStatus();
      res = normalizeResult(res, prompt, error);
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
      st.hist.push(text); st.histIdx = st.hist.length; st.draft = '';
      box.value = ''; autosize();
      line(save({ role: 'user', text }));
      const q = st.question;
      st.question = null;
      const tc = !q && !targetRow.classList.contains('hidden') && target.value !== 'new' ? cards.get(target.value) : null;
      st.picked = false;
      if (tc) { followUp(tc, text); return; }
      refine(q ? `${q.original}\n\nYou asked: ${q.question}\nMy answer: ${text}` : text);
    }
    box.addEventListener('input', autosize);
    box.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (st.refining) { if (e.key === 'Escape') { e.preventDefault(); cancelRefine(); } else if (e.key === 'Enter') e.preventDefault(); return; }
      const act = st.review && reviewKey(e, box.value === '');
      if (act) { e.preventDefault(); return reviewAct(act); }
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
    // Text pastes as it is. Images are a later item: say so instead of silently dropping them.
    box.addEventListener('paste', e => {
      if ([...(e.clipboardData?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/')) && !e.clipboardData.getData('text')) {
        e.preventDefault();
        host.toast('<b>Image paste is not supported in the Operant Terminal yet</b>');
      }
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

    return { refresh: refreshCards, focus: () => box.focus({ preventScroll: true }), drawAuto };
  }

  const api = { mount, assertTierAllowed, dispatchArgs, planDispatch, handoffText, isLive, isSettled, defaultTarget, tokenLine, requestFooter, summaryText, flatText, diffOps, diffHtml, renderText, reviewKey, historyStep, normalizeResult, estTokens, statusOf, STATUS };
  return api;
})();

if (typeof window !== 'undefined') window.OperantTerminal = OperantTerminal;
if (typeof module !== 'undefined') module.exports = OperantTerminal;
