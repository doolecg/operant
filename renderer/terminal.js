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
      requestId: r.requestId || newId(), original: r.original || prompt, cleaned: typeof r.refined === 'string' && r.refined.trim() ? r.refined : null,
      question: typeof r.question === 'string' && r.question.trim() ? r.question.trim() : null, summary: r.summary || '',
      tasks: tasks.map(t => ({ ...t, title: t.title || clip(t.prompt || prompt, 60), prompt: t.prompt || prompt })),
      refiner: r.refiner || null, brief: r.brief || null, error: r.error || error || null,
    };
  }
  // Board status -> [label, look].
  const STATUS = { todo: ['Queued', 'wait'], doing: ['Working', 'run'], verifying: ['Running checks', 'run'], review: ['Ready for review', 'ok'],
    done: ['Done', 'ok'], failed: ['Failed', 'bad'], blocked: ['Blocked', 'bad'] };
  const statusOf = t => STATUS[t?.status] || ['Not on the board', 'wait'];

  // ---- the tile

  // host: { operant, tierDot(tier), tasks(), control(cmd, args), autoSend(), setAutoSend(on), focusTile(id), toast(html) }
  function mount(w, host) {
    const { el, cwd: project } = w, op = host.operant;
    const $ = s => el.querySelector(s);
    const log = $('.ot-log'), box = $('.ot-box textarea'), status = $('.ot-status'), autoBtn = $('[data-v="auto"]');
    const st = { review: null, question: null, refining: null, hist: [], histIdx: 0, draft: '' };
    const cards = new Map(); // requestId:idx -> { entry, node, reject }
    let statusTimer = null;

    const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const scroll = () => { log.scrollTop = log.scrollHeight; };
    const append = html => { const stick = atBottom(); log.insertAdjacentHTML('beforeend', html); const n = log.lastElementChild; if (stick) scroll(); return n; };
    const autosize = () => { box.style.height = 'auto'; box.style.height = box.scrollHeight ? Math.min(box.scrollHeight, 180) + 'px' : ''; };
    const save = entry => { const e = { t: Date.now(), ...entry }; op.terminalAppend?.(project, e); return e; };

    function empty() {
      if (log.querySelector('.ot-msg, .ot-card, .ot-refined')) return;
      if (!log.querySelector('.ot-hello')) log.insertAdjacentHTML('afterbegin', `<div class="ot-hello"><div class="ot-mark">◆</div><h3>Operant Terminal</h3>
        <p>Say what you want done in <b>${esc(project.split(/[\\/]/).filter(Boolean).pop() || project)}</b>. Operant cleans the prompt, splits it into tasks, picks the cheapest agent and model that fits each, and reports back here.</p></div>`);
    }
    function line(entry) {
      log.querySelector('.ot-hello')?.remove();
      if (entry.role === 'user') return append(`<div class="ot-msg user"><span class="ot-who">You</span><div class="ot-body">${renderText(entry.text)}</div></div>`);
      if (entry.role === 'operant') return append(`<div class="ot-msg operant ${esc(entry.kind || '')}"><span class="ot-who">Operant</span><div class="ot-body">${renderText(entry.text)}</div></div>`);
      if (entry.role === 'refiner') {
        const r = entry.refiner, meta = [r?.provider && `${r.provider}${r.model ? ' ' + r.model : ''}`, r?.tokens && `${fmtN(r.tokens.input || 0)} in / ${fmtN(r.tokens.output || 0)} out`, fmtUsd(r?.usd)].filter(Boolean).join(' · ');
        return append(`<details class="ot-refined"><summary><span class="ot-dim">Cleaned prompt</span> ${esc(entry.summary || clip(entry.cleaned || entry.original, 90))}${entry.error ? ` <span class="ot-bad">(${esc(clip(entry.error, 80))})</span>` : ''}</summary>
          <div class="ot-pre">${esc(entry.cleaned || entry.original || '')}</div>${meta ? `<div class="ot-dim">${esc(meta)}</div>` : ''}</details>`);
      }
      if (entry.role === 'task') return card(entry);
      return null;
    }

    // ---- result cards (item 77): a card per task, keyed by requestId + task index, following the board
    const taskOf = e => host.tasks().find(t => t.id === e.taskId && (!t.requestId || t.requestId === e.requestId));
    function cardHtml(c) {
      const e = c.entry, t = taskOf(e), [label, look] = e.error ? ['Not started', 'bad'] : statusOf(t);
      const tokens = t?.tokens ? (t.tokens.input || 0) + (t.tokens.output || 0) + (t.tokens.cacheWrite || 0) : 0;
      const pick = [e.agent, e.model, e.effort].filter(Boolean).join(' · ');
      const check = t?.check ? `<span class="${t.check.ok ? 'ot-ok' : 'ot-bad'}" title="${esc(t.check.summary || '')}">${t.check.ok ? '✓' : '✗'} ${esc(t.check.command || 'checks')}</span>` : '';
      const open = e.tile != null && host.tileAlive(e.tile) || t?.owner != null && host.tileAlive(t.owner);
      const reviewing = t?.status === 'review' || t?.status === 'blocked';
      return `<div class="ot-card-head">${host.tierDot(e.tier)}<b class="ot-card-title">${esc(e.title || 'Task')}</b><span class="ot-pill ${look}">${esc(label)}</span></div>
        ${pick ? `<div class="ot-dim">${esc(pick)}${e.tier ? ' · ' + esc(e.tier) : ''}${t?.id != null ? ' · task #' + t.id : ''}</div>` : ''}
        ${e.why ? `<div class="ot-why">${esc(e.why)}</div>` : ''}
        ${e.error ? `<div class="ot-bad">${esc(e.error)}</div>` : ''}
        ${t?.note ? `<div class="ot-note">${renderText(t.note)}</div>` : ''}
        ${check || t?.diffStat || tokens ? `<div class="ot-dim">${[check, t?.diffStat && esc(t.diffStat), tokens && `${fmtN(tokens)} tokens`].filter(Boolean).join(' · ')}</div>` : ''}
        <div class="ot-card-acts">${reviewing ? '<button class="btn primary" data-c="approve">Approve</button><button class="btn" data-c="reject">Reject</button>' : ''}${open ? '<button class="btn" data-c="open">Open tile</button>' : ''}</div>
        ${c.reject ? `<div class="ot-reject"><input class="ot-reject-note" type="text" placeholder="Why? The worker is told this" value="${esc(c.reject.text)}"><button class="btn primary" data-c="reject-send">Send</button><button class="btn" data-c="reject-cancel">Cancel</button></div>` : ''}`;
    }
    function card(entry) {
      const key = `${entry.requestId}:${entry.idx}`, c = { entry, reject: null, key };
      c.node = append(`<div class="ot-card"></div>`);
      c.node.innerHTML = cardHtml(c);
      cards.set(key, c);
      return c.node;
    }
    function refreshCards() {
      for (const c of cards.values()) {
        if (!c.node.isConnected) continue;
        if (c.node.contains(document.activeElement) && document.activeElement.matches('input')) continue; // typing a rejection note
        const html = cardHtml(c);
        if (html !== c.html) { c.html = html; c.node.innerHTML = html; }
      }
    }
    log.addEventListener('click', async e => {
      const b = e.target.closest('[data-c]');
      const node = b?.closest('.ot-card'), c = node && [...cards.values()].find(x => x.node === node);
      if (!c) return;
      const t = taskOf(c.entry), what = b.dataset.c;
      try {
        if (what === 'open') { const id = c.entry.tile != null && host.tileAlive(c.entry.tile) ? c.entry.tile : t?.owner; host.focusTile(id); }
        else if (what === 'approve' && t) await host.control('task', { sub: 'approve', id: t.id });
        else if (what === 'reject') { c.reject = { text: '' }; c.node.innerHTML = cardHtml(c); c.node.querySelector('.ot-reject-note').focus(); return; }
        else if (what === 'reject-cancel') { c.reject = null; }
        else if (what === 'reject-send' && t) {
          const note = c.node.querySelector('.ot-reject-note').value.trim();
          if (!note) return c.node.querySelector('.ot-reject-note').focus();
          c.reject = null;
          await host.control('task', { sub: 'reject', id: t.id, note });
        }
      } catch (err) { host.toast(`<b>${esc(err.message || err)}</b>`); }
      c.html = null; refreshCards();
    });
    log.addEventListener('keydown', e => {
      if (!e.target.matches('.ot-reject-note')) return;
      if (e.key === 'Enter') { e.preventDefault(); e.target.closest('.ot-card').querySelector('[data-c="reject-send"]').click(); }
      else if (e.key === 'Escape') { e.stopPropagation(); e.target.closest('.ot-card').querySelector('[data-c="reject-cancel"]').click(); }
    });

    // ---- dispatch (item 76 wires effort, results and routing checks properly; this is the seam)
    // Sends each task to a worker through the renderer's existing `agent` control. -> [{ ok, id, taskId, tier, error }]
    async function dispatchTasks(requestId, tasks) {
      const out = [];
      for (const t of tasks) {
        try {
          const r = await host.control('agent', { prompt: t.prompt, agent: t.agent, model: t.model, tier: t.tier, cwd: project, requestId, title: t.title });
          out.push({ ok: true, id: r.id, taskId: r.taskId ?? null, tier: r.tier || t.tier });
        } catch (err) { out.push({ ok: false, error: String(err.message || err) }); }
      }
      return out;
    }
    // ---- end of dispatch seam

    async function send(res, which) {
      const tasks = which === 'original' ? [{ title: clip(res.original, 60), prompt: res.original }] : res.tasks;
      const results = await dispatchTasks(res.requestId, tasks);
      tasks.forEach((t, idx) => {
        const r = results[idx];
        line(save({ role: 'task', requestId: res.requestId, idx, taskId: r.taskId ?? null, tile: r.id ?? null, title: t.title, agent: t.agent, model: t.model, effort: t.effort,
          tier: r.tier || t.tier, why: t.why, files: t.files, ...(r.ok ? {} : { error: r.error }) }));
      });
      refreshCards();
    }

    // ---- review (item 75)
    function reviewHtml(res) {
      const cleaned = res.cleaned && res.cleaned.trim() !== res.original.trim() ? res.cleaned : null;
      const d = cleaned ? diffHtml(res.original, cleaned) : null, r = res.refiner;
      const before = estTokens(res.original), after = estTokens(cleaned || res.original);
      const rmeta = r && (r.tokens || r.provider) ? [r.provider && `${r.provider}${r.model ? ' ' + r.model : ''}`, r.tokens && `${fmtN(r.tokens.input || 0)} in / ${fmtN(r.tokens.output || 0)} out`, r.usd != null ? fmtUsd(r.usd) : r.tokens ? 'cost unknown' : null].filter(Boolean).join(' · ') : '';
      return `<div class="ot-review"><div class="ot-rv-head"><b>Review</b><span class="ot-dim">${esc(res.summary)}</span></div>
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
      box.focus();
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
      if (e.target !== box && !e.target.matches('input') && st.review) { const act = reviewKey(e, true); if (act) { e.preventDefault(); reviewAct(act); } }
    });

    // ---- header
    const drawAuto = () => { autoBtn.classList.toggle('on', host.autoSend()); autoBtn.title = host.autoSend() ? 'Auto-send is on for this project: cleaned prompts go straight to the agents' : 'Auto-send is off: you review the cleaned prompt first'; };
    autoBtn.addEventListener('click', () => { host.setAutoSend(!host.autoSend()); drawAuto(); });
    $('[data-v="clear"]').addEventListener('click', async () => {
      if (await op.ask({ message: 'Clear this conversation?', detail: 'The saved history for this project is deleted. Tasks already sent keep running.', buttons: ['Clear', 'Cancel'], cancelId: 1 }) !== 0) return;
      if (st.review) endReview();
      await op.terminalClear(project);
      log.innerHTML = ''; cards.clear(); st.hist = []; st.histIdx = 0; st.question = null; empty();
    });
    drawAuto();

    // ---- restore: the saved conversation
    (async () => {
      let saved = [];
      try { saved = (await op.terminalHistory(project, 300)) || []; } catch { /* no history yet */ }
      for (const e of saved) { line(e); if (e.role === 'user') st.hist.push(e.text); }
      st.histIdx = st.hist.length;
      empty(); scroll(); refreshCards();
    })();
    autosize();

    return { refresh: refreshCards, focus: () => box.focus({ preventScroll: true }), drawAuto };
  }

  const api = { mount, diffOps, diffHtml, renderText, reviewKey, historyStep, normalizeResult, estTokens, statusOf, STATUS };
  return api;
})();

if (typeof window !== 'undefined') window.OperantTerminal = OperantTerminal;
if (typeof module !== 'undefined') module.exports = OperantTerminal;
