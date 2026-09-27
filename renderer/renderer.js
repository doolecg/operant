// Operant: a Hyprland-style tiler for terminal AI agents (Claude Code, Codex, OpenCode, ...)
// and Claude's subagents.

(async () => {
  const cfg = await operant.config();
  const defaults = await operant.defaults();
  const $ = s => document.querySelector(s);
  const desktop = $('#desktop');
  const root = document.documentElement.style;

  const WS_COUNT = 9;
  const workspaces = [];       // { el, hint, tree, focused, fullscreen }
  const wins = new Map();      // id -> win
  const sessionWin = new Map();// Claude Code sessionId -> win (to place its subagents next to it)
  const agentWin = new Map();  // agentId -> win
  let current = 0;
  let nextId = 1;
  let lastCwd = cfg.defaultCwd;

  // ------------------------------------------------------------ workspaces

  for (let i = 0; i < WS_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'workspace' + (i === 0 ? '' : ' right');
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    el.appendChild(hint);
    desktop.appendChild(el);
    workspaces.push({ el, hint, tree: null, focused: null, fullscreen: null, layout: cfg.defaultLayout, mfact: cfg.masterRatio });
  }

  function renderHints() {
    const k = a => bindLabel(a) ? `<kbd>${esc(Panels.pretty(bindLabel(a)))}</kbd>` : '';
    workspaces.forEach((ws, i) => {
      ws.hint.innerHTML = `<div class="big">◈</div><div class="headline">What should we build?</div><div>Workspace ${i + 1} is empty</div>
        <div class="row"><span>${k('newAgent')} new ${esc(defaultAgent()?.name || 'agent')}</span><span>${k('pickAgent')} pick an agent…</span>
        <span>${k('newAgentIn')} agent in folder…</span><span>${k('help')} keybinds</span><span>${k('settings')} settings</span></div>
        <div>Claude Code subagents open here in their own tiles as soon as they start.</div>`;
    });
  }

  function switchWorkspace(i) {
    if (i === current || i < 0 || i >= WS_COUNT) return;
    workspaces.forEach((w, j) => {
      w.el.classList.toggle('left', j < i);
      w.el.classList.toggle('right', j > i);
    });
    current = i;
    layout(i, true);
    const f = wins.get(workspaces[i].focused);
    if (f) focusWin(f); else refreshBar();
  }

  // ------------------------------------------------------- dwindle tree
  // node: { win } leaf | { split: 'h'|'v', ratio, a, b }. 'h' = side by side.

  const leaves = (n, out = []) => { if (!n) return out; if (n.win) out.push(n); else { leaves(n.a, out); leaves(n.b, out); } return out; };
  const findLeaf = (n, win) => leaves(n).find(l => l.win === win);
  function parentOf(n, target, p = null) {
    if (!n) return null;
    if (n === target) return p;
    if (n.win) return null;
    return parentOf(n.a, target, n) || parentOf(n.b, target, n);
  }
  const wsWins = i => leaves(workspaces[i].tree).map(l => l.win);

  function area() {
    const r = desktop.getBoundingClientRect();
    const g = cfg.gapsOut;
    return { x: g, y: g - 4, w: r.width - 2 * g, h: r.height - 2 * g + 4 };
  }

  function rects(n, r, out = new Map()) {
    if (!n) return out;
    if (n.win) { out.set(n.win.id, r); return out; }
    const gap = cfg.gapsIn * 2;
    if (n.split === 'h') {
      const w1 = (r.w - gap) * n.ratio;
      rects(n.a, { x: r.x, y: r.y, w: w1, h: r.h }, out);
      rects(n.b, { x: r.x + w1 + gap, y: r.y, w: r.w - w1 - gap, h: r.h }, out);
    } else {
      const h1 = (r.h - gap) * n.ratio;
      rects(n.a, { x: r.x, y: r.y, w: r.w, h: h1 }, out);
      rects(n.b, { x: r.x, y: r.y + h1 + gap, w: r.w, h: r.h - h1 - gap }, out);
    }
    return out;
  }

  // Master layout: the first tile in tree order takes the left pane, the rest stack on the right.
  function tileRects(i) {
    const ws = workspaces[i], A = area();
    if (ws.layout !== 'master') return rects(ws.tree, A);
    const list = wsWins(i), out = new Map(), gap = cfg.gapsIn * 2;
    if (list.length === 1) out.set(list[0].id, A);
    if (list.length < 2) return out;
    const mw = (A.w - gap) * ws.mfact;
    out.set(list[0].id, { x: A.x, y: A.y, w: mw, h: A.h });
    const rest = list.slice(1), h = (A.h - gap * (rest.length - 1)) / rest.length;
    rest.forEach((w, k) => out.set(w.id, { x: A.x + mw + gap, y: A.y + k * (h + gap), w: A.w - mw - gap, h }));
    return out;
  }

  function insert(win, wsIndex, target) {
    const ws = workspaces[wsIndex];
    win.ws = wsIndex;
    ws.el.appendChild(win.el);
    const leaf = { win };
    if (!ws.tree) { ws.tree = leaf; return; }
    const tl = (target && target.ws === wsIndex && findLeaf(ws.tree, target)) || findLeaf(ws.tree, wins.get(ws.focused)) || leaves(ws.tree).at(-1);
    const r = rects(ws.tree, area()).get(tl.win.id);
    const split = { split: r.w >= r.h * 0.9 ? 'h' : 'v', ratio: 0.5, a: { win: tl.win }, b: leaf };
    replaceNode(ws, tl, split);
  }

  function replaceNode(ws, node, repl) {
    const p = parentOf(ws.tree, node);
    if (!p) ws.tree = repl; else if (p.a === node) p.a = repl; else p.b = repl;
  }

  function detach(win) {
    const ws = workspaces[win.ws];
    const l = findLeaf(ws.tree, win);
    if (!l) return;
    const p = parentOf(ws.tree, l);
    if (!p) ws.tree = null; else replaceNode(ws, p, p.a === l ? p.b : p.a);
    if (ws.fullscreen === win.id) ws.fullscreen = null;
    if (ws.focused === win.id) ws.focused = null;
  }

  function layout(i = current, instant = false) {
    const ws = workspaces[i];
    const all = tileRects(i);
    const A = area();
    for (const [id, r0] of all) {
      const w = wins.get(id);
      const fs = ws.fullscreen === id;
      const r = fs ? A : r0;
      w.el.classList.toggle('fullscreen', fs);
      w.el.classList.toggle('hidden-by-fs', ws.fullscreen != null && !fs);
      if (instant) w.el.classList.add('no-anim');
      Object.assign(w.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      if (instant) { void w.el.offsetWidth; w.el.classList.remove('no-anim'); }
      scheduleFit(w, instant ? 0 : 440);
    }
    ws.hint.style.opacity = ws.tree ? 0 : 1;
    refreshBar();
  }

  function scheduleFit(w, delay) {
    clearTimeout(w.fitTimer);
    w.fitTimer = setTimeout(() => {
      if (!w.alive) return;
      try { w.fit.fit(); } catch {}
      if (w.ptyId) operant.resizePty(w.ptyId, w.term.cols, w.term.rows);
    }, delay);
  }

  // ------------------------------------------------------------- windows

  function makeWin(kind, title, icon) {
    const id = nextId++;
    const el = document.createElement('div');
    el.className = `win ${kind} opening`;
    el.innerHTML = `<div class="inner"><div class="tbar"><span class="ico">${esc(icon || (kind === 'agent' ? '◆' : '❯'))}</span>
      <span class="title"></span><span class="badge"></span><button class="x" title="Close">✕</button></div><div class="term"></div></div>`;
    const term = new Terminal({
      ...termOptions(kind), allowTransparency: true,
      disableStdin: kind === 'agent', cursorInactiveStyle: 'none', allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const w = { id, kind, el, term, fit, title, alive: true, ws: current, lastActivity: Date.now(), closeIn: null };
    el.querySelector('.title').textContent = title;
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); closeWin(w); });
    el.addEventListener('mousedown', e => onWinMouseDown(e, w), true);
    term.attachCustomKeyEventHandler(e => handleTermKey(e, w));
    wins.set(id, w);
    return w;
  }

  // ------------------------------------------------------------ appearance

  const theme = () => THEMES[cfg.theme] || THEMES.obsidian;
  const accent = () => cfg.accent || theme().accent;
  function rgba(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${a})`;
  }

  const ANSI = {
    red: '#e06c5a', green: '#9cb88a', yellow: '#e3b27a', blue: '#8fa9c7', magenta: '#c89ab8', cyan: '#8dbab3', white: '#f0eee6',
    brightBlack: '#8a857a', brightRed: '#f08a78', brightGreen: '#b4cfa3', brightYellow: '#f0c995', brightBlue: '#abc2dc',
    brightMagenta: '#dcb4ce', brightCyan: '#a9d0ca', brightWhite: '#faf9f5',
  };

  function termOptions(kind) {
    const t = theme();
    return {
      fontFamily: cfg.fontFamily, fontSize: cfg.fontSize, lineHeight: cfg.lineHeight, scrollback: cfg.scrollback,
      cursorStyle: cfg.cursorStyle, cursorBlink: kind !== 'agent' && cfg.cursorBlink,
      theme: {
        background: 'rgba(0,0,0,0)', foreground: t.text, cursor: kind === 'agent' ? 'rgba(0,0,0,0)' : accent(),
        cursorAccent: t.bg, selectionBackground: rgba(accent(), 0.3),
        black: t.termBlack, ...ANSI, ...(t.ansi || {}),
      },
    };
  }

  function applyAppearance() {
    const t = theme();
    const vars = {
      '--bg': t.bg, '--glow': t.glow, '--bar-rgb': t.bar, '--glass-rgb': t.glass, '--card-rgb': t.card, '--ink-rgb': t.ink,
      '--text': t.text, '--dim': t.dim, '--inactive': t.inactive, '--accent': accent(), '--theme-accent': t.accent,
      '--agent': t.agent, '--done': t.done, '--rounding': cfg.rounding + 'px', '--border': cfg.borderSize + 'px',
      '--opacity': cfg.opacity, '--blur': cfg.blur + 'px', '--flow': cfg.borderAnimationSeconds + 's',
    };
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    document.body.className = `wp-${cfg.wallpaper} border-${cfg.borderAnimation}`;
    applySidebar();
    for (const w of wins.values()) Object.assign(w.term.options, termOptions(w.kind));
    workspaces.forEach((_, i) => layout(i, i !== current));
  }

  function mount(w, wsIndex, target, { focus = true } = {}) {
    insert(w, wsIndex, target);
    w.term.open(w.el.querySelector('.term'));
    w.term.textarea?.addEventListener('focus', () => { if (workspaces[w.ws].focused !== w.id) focusWin(w, false); });
    // Keys never fall into nothing: if the focused tile loses the keyboard to no other control
    // (a tile closing, a redraw, a click on empty space), it takes it straight back.
    w.term.textarea?.addEventListener('blur', e => {
      if (e.relatedTarget) return;
      setTimeout(() => {
        if (focused() === w && document.hasFocus() && document.activeElement === document.body && !openPanel()) w.term.focus();
      });
    });
    // Start at the spot the tile will occupy so it scales in place.
    layout(wsIndex, false);
    // Force a style flush so the scale-in transition runs; rAF would stall while the window is hidden.
    void w.el.offsetWidth;
    w.el.classList.remove('opening');
    if (focus || !workspaces[wsIndex].focused) {
      if (wsIndex !== current && focus) switchWorkspace(wsIndex);
      focusWin(w, focus);
    }
    try { w.fit.fit(); } catch {}
  }

  function setTitle(w, t) { w.title = t; w.el.querySelector('.title').textContent = t; if (w.el.classList.contains('focused')) refreshBar(); }
  function setBadge(w, html) { w.el.querySelector('.badge').innerHTML = html; }

  const defaultAgent = () => cfg.agents.find(a => a.id === cfg.defaultAgent) || cfg.agents[0];

  // kind: 'ai' (an agent CLI from cfg.agents) or 'shell'.
  async function newTerminal(kind, cwd, { master = false, agentId = cfg.defaultAgent, run, title } = {}) {
    const agent = kind === 'ai' ? cfg.agents.find(a => a.id === agentId) || defaultAgent() : null;
    if (kind === 'ai' && !agent) { toast('No agents set up. Add one in Settings › Agents.'); return; }
    const name = title || (agent ? agent.name : 'Shell');
    const w = makeWin(kind, name, agent?.icon || '●');
    w.agentName = name;
    if (master) { w.master = true; w.el.classList.add('master'); }
    mount(w, current, null);
    const info = await operant.createPty({ kind, agentId: agent?.id, cwd: cwd || lastCwd, cols: w.term.cols, rows: w.term.rows, run });
    w.ptyId = info.id;
    w.sessionId = info.sessionId;
    w.cwd = info.cwd;
    if (info.sessionId) sessionWin.set(info.sessionId, w);
    updateBadge(w);
    setTitle(w, name);
    ptyWins.set(info.id, w);
    w.term.onData(d => { touch(w); w.lastInput = lastKey = Date.now(); w.typed = true; w.busySince = null; operant.writePty(info.id, d); });
    // The shell sets its own path as the title; only keep titles the agent sets.
    w.term.onTitleChange(t => t && !/\.exe$/i.test(t.trim()) && setTitle(w, t));
    w.term.onBell(() => { if (kind === 'ai') notify(w, `${name} needs your attention`, shortPath(w.cwd || '')); });
    scheduleFit(w, 50);
  }

  function shortPath(p) { const parts = p.split(/[\\/]/).filter(Boolean); return parts.slice(-2).join('\\'); }

  function closeWin(w) {
    if (!w.alive) return;
    w.alive = false;
    const wsIndex = w.ws;
    const wasFocused = workspaces[wsIndex].focused === w.id;
    const neighbour = wasFocused ? nearestAfterClose(w) : null;
    detach(w);
    if (w.ptyId) { operant.killPty(w.ptyId); ptyWins.delete(w.ptyId); }
    if (w.sessionId) sessionWin.delete(w.sessionId);
    if (w.agentId) agentWin.delete(w.agentId);
    w.el.classList.add('closing');
    setTimeout(() => { w.term.dispose(); w.el.remove(); }, 320);
    wins.delete(w.id);
    layout(wsIndex);
    if (wasFocused) {
      const n = neighbour || wins.get(wsWins(wsIndex).at(-1)?.id);
      if (n) focusWin(n, wsIndex === current);
    }
    refreshBar();
  }

  function nearestAfterClose(w) {
    const ws = workspaces[w.ws];
    const l = findLeaf(ws.tree, w);
    const p = l && parentOf(ws.tree, l);
    if (!p) return null;
    const sib = p.a === l ? p.b : p.a;
    return leaves(sib)[0]?.win || null;
  }

  function focusWin(w, grabKeyboard = true) {
    if (!w || !w.alive) return;
    const ws = workspaces[w.ws];
    // Looking at a tile counts as activity, so leaving one doesn't make it vanish at once.
    const prev = wins.get(ws.focused);
    if (prev) touch(prev);
    touch(w);
    ws.focused = w.id;
    for (const o of wins.values()) if (o.ws === w.ws) o.el.classList.toggle('focused', o === w);
    if (w.ws !== current) return refreshBar();
    flushBacklog(w);
    if (grabKeyboard) w.term.focus();
    refreshBar();
  }

  const focused = () => wins.get(workspaces[current].focused);

  // ------------------------------------------------------------- pty data

  const ptyWins = new Map();
  operant.on('pty:data', ({ id, data }) => {
    const w = ptyWins.get(id);
    if (!w) return;
    const now = Date.now();
    w.lastActivity = now;
    // Output well after the last keystroke is the agent working (not echo of typing).
    if (w.kind === 'ai' && w.typed && now - w.lastInput > 1500) { w.busySince ??= now; w.lastOut = now; }
    output(w, data);
  });

  // The tile you're typing in comes first. Its output is written the moment it arrives; every
  // other tile's is gathered and written in the gaps, one batch per tile at a time and less
  // often while you type, so busy terminals elsewhere never hold up your keys.
  const backlog = new Map(); // win -> pending output
  let lastKey = 0, drainT = null;
  function output(w, data) {
    if (w.ws === current && workspaces[current].focused === w.id) { flushBacklog(w); w.term.write(data); return; }
    backlog.set(w, (backlog.get(w) || '') + data);
    drainT ??= setTimeout(drain, Date.now() - lastKey < 1000 ? 250 : 33);
  }
  function flushBacklog(w) {
    const data = backlog.get(w);
    if (data == null) return;
    backlog.delete(w);
    if (w.alive) w.term.write(data);
  }
  function drain() {
    drainT = null;
    for (const [w, data] of backlog) {
      if (!w.alive) { backlog.delete(w); continue; }
      if (w.writing) continue; // still parsing its last batch
      backlog.delete(w);
      w.writing = true;
      w.term.write(data, () => { w.writing = false; });
    }
    if (backlog.size) drainT = setTimeout(drain, Date.now() - lastKey < 1000 ? 250 : 33);
  }

  // ------------------------------------------------------------ notifications
  // An agent that worked for a while and has now gone quiet is done or waiting for an answer.

  async function notify(w, title, body) {
    if (!cfg.notifications || !w.alive) return;
    if (w.lastNotified && Date.now() - w.lastNotified < 5000) return;
    if (cfg.notifyOnlyUnfocused && w.ws === current && workspaces[w.ws].focused === w.id && await operant.windowFocused()) return;
    w.lastNotified = Date.now();
    operant.notify({ title, body, tileId: w.id });
  }

  setInterval(() => {
    const now = Date.now();
    for (const w of wins.values()) {
      if (!w.busySince || now - w.lastOut < cfg.notifyWhenIdleSeconds * 1000) continue;
      const worked = w.lastOut - w.busySince;
      w.busySince = null;
      if (worked >= 2500) w.unchecked = true;
      if (worked >= 2500 && cfg.notifyWhenIdleSeconds > 0) notify(w, `${w.agentName} is waiting for you`, `${w.title !== w.agentName ? w.title + ' · ' : ''}${shortPath(w.cwd || '')}`);
    }
  }, 1000);

  operant.on('focus-tile', id => {
    const w = wins.get(Number(id));
    if (!w || !w.alive) return;
    if (w.ws !== current) switchWorkspace(w.ws);
    focusWin(w);
  });
  operant.on('pty:exit', ({ id }) => { const w = ptyWins.get(id); if (w) closeWin(w); });

  // ------------------------------------------------------------- subagents

  operant.on('agent:new', info => {
    if (agentWin.has(info.agentId)) return;
    const parent = sessionWin.get(info.sessionId);
    if (!parent && !cfg.showExternalAgents) return;

    // Keep an agent near whatever spawned it: its Claude tile, or a sibling agent from the same session.
    const sibling = [...agentWin.values()].reverse().find(a => a.sessionId === info.sessionId && a.alive);
    const anchor = parent || sibling || null;
    let wsIndex = anchor ? anchor.ws : current;
    if (wsWins(wsIndex).length >= cfg.maxTilesPerWorkspace) {
      const order = [...Array(WS_COUNT).keys()].map(k => (wsIndex + 1 + k) % WS_COUNT);
      wsIndex = order.find(k => wsWins(k).length < cfg.maxTilesPerWorkspace) ?? wsIndex;
    }
    const target = anchor && anchor.ws === wsIndex ? (sibling && sibling.ws === wsIndex ? sibling : anchor) : null;

    const w = makeWin('agent', info.description);
    Object.assign(w, { agentId: info.agentId, sessionId: info.sessionId, info, status: 'running', state: { first: true, tools: new Map() }, tools: 0 });
    agentWin.set(info.agentId, w);
    mount(w, wsIndex, target, { focus: false });
    w.term.write(AgentRender.header(info));
    updateBadge(w);
    if (wsIndex !== current) toast(`<b>◆ ${esc(info.agentType)}</b> ${esc(info.description)} → workspace ${wsIndex + 1}`, () => { switchWorkspace(wsIndex); focusWin(w); });
    refreshBar();
  });

  operant.on('agent:entries', ({ agentId, entries }) => {
    const w = agentWin.get(agentId);
    if (!w || !w.alive) return;
    let text = '';
    for (const e of entries) {
      text += AgentRender.entry(e, w.state);
      w.tools += e.blocks.filter(b => b.type === 'tool_use').length;
      if (e.role === 'assistant') w.status = e.stop === 'end_turn' ? 'done' : 'running';
      else if (e.blocks.some(b => b.type === 'text')) w.status = 'running';
    }
    if (text) output(w, text);
    touch(w);
    if (w.status === 'done' && !w.doneMarked) {
      w.doneMarked = true;
      w.unchecked = true;
      output(w, '\x1b[38;2;156;184;138m✓ finished\x1b[0m\r\n\r\n');
      if (cfg.notifySubagents) notify(w, `✓ ${w.info.agentType} finished`, w.info.description);
    }
    if (w.status !== 'done') w.doneMarked = false;
    updateBadge(w);
    refreshBar();
  });

  function updateBadge(w) {
    const closing = w.closeIn != null ? ` · closing ${w.closeIn}s` : w.unchecked ? ' · new' : '';
    if (w.kind !== 'agent') {
      setBadge(w, `${w.master ? 'master · ' : ''}${w.cwd ? shortPath(w.cwd) : ''}${closing}`);
      return;
    }
    w.el.classList.toggle('running', w.status === 'running');
    w.el.classList.toggle('done', w.status === 'done');
    const tools = `${w.tools} tool${w.tools === 1 ? '' : 's'}`;
    if (w.status === 'running') setBadge(w, `<span class="spin">✻</span> ${w.info.agentType} · ${tools}${closing}`);
    else setBadge(w, `✓ done · ${tools}${closing}`);
  }

  // ------------------------------------------------------------ idle reaper
  // A tile closes once nothing has happened in it for its limit: no output, no typing,
  // no transcript lines, and not being looked at. The master and focused tiles are exempt.
  // Nothing that is still working closes, and nothing that finished closes before you've seen
  // it: a finished tile counts as checked once it's on screen while Operant has focus, and its
  // countdown starts from then.

  const touch = w => { w.lastActivity = Date.now(); };

  function idleLimit(w) {
    if (w.kind === 'agent') return w.status === 'done' ? cfg.autoCloseDoneAgentsSeconds * 1000 : 0;
    if (w.busySince) return 0;
    return cfg.idleCloseTerminalMinutes * 60000;
  }

  const onScreen = w => w.ws === current && document.hasFocus() && !document.hidden;

  setInterval(() => {
    const now = Date.now();
    for (const w of [...wins.values()]) {
      if (w.unchecked && onScreen(w)) { w.unchecked = false; touch(w); updateBadge(w); }
      const limit = idleLimit(w);
      const isFocused = w.ws === current && workspaces[w.ws].focused === w.id;
      let closeIn = null;
      if (limit && !w.master && !isFocused && !w.unchecked) {
        const left = limit - (now - w.lastActivity);
        if (left <= 0) { closeWin(w); continue; }
        if (left <= 30000) closeIn = Math.ceil(left / 1000);
      }
      if (closeIn !== w.closeIn) { w.closeIn = closeIn; updateBadge(w); }
    }
  }, 1000);

  // ------------------------------------------------------------ navigation

  function neighbour(dir) {
    const f = focused();
    if (!f) return null;
    const all = tileRects(current);
    const a = all.get(f.id);
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    let best = null, bestScore = Infinity;
    for (const [id, r] of all) {
      if (id === f.id) continue;
      const bx = r.x + r.w / 2, by = r.y + r.h / 2;
      const dx = bx - cx, dy = by - cy;
      const ok = dir === 'Left' ? r.x + r.w <= a.x + 1 : dir === 'Right' ? r.x >= a.x + a.w - 1 : dir === 'Up' ? r.y + r.h <= a.y + 1 : r.y >= a.y + a.h - 1;
      if (!ok) continue;
      const horiz = dir === 'Left' || dir === 'Right';
      const overlap = horiz ? Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y) : Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x);
      const score = (horiz ? Math.abs(dx) : Math.abs(dy)) + (overlap > 0 ? 0 : 10000) + (horiz ? Math.abs(dy) : Math.abs(dx)) * 0.1;
      if (score < bestScore) { bestScore = score; best = wins.get(id); }
    }
    return best;
  }

  function swapWith(other) {
    const f = focused();
    if (!f || !other) return;
    swapWins(f, other);
    focusWin(f);
  }

  function swapWins(x, y) {
    if (x.ws !== y.ws) return;
    const ws = workspaces[x.ws];
    const lx = findLeaf(ws.tree, x), ly = findLeaf(ws.tree, y);
    lx.win = y; ly.win = x;
    layout(x.ws);
  }

  function resize(dir) {
    const f = focused();
    if (!f) return;
    const ws = workspaces[current];
    const axis = dir === 'Left' || dir === 'Right' ? 'h' : 'v';
    if (ws.layout === 'master') {
      if (axis === 'h') { ws.mfact = Math.min(0.85, Math.max(0.2, ws.mfact + (dir === 'Right' ? 0.05 : -0.05))); layout(); }
      return;
    }
    let node = findLeaf(ws.tree, f), p;
    while ((p = parentOf(ws.tree, node)) && p.split !== axis) node = p;
    if (!p) return;
    const delta = (dir === 'Right' || dir === 'Down' ? 1 : -1) * 0.05;
    p.ratio = Math.min(0.9, Math.max(0.1, p.ratio + delta));
    layout();
  }

  function toggleSplit() {
    const f = focused();
    if (!f) return;
    const ws = workspaces[current];
    const p = parentOf(ws.tree, findLeaf(ws.tree, f));
    if (p) { p.split = p.split === 'h' ? 'v' : 'h'; layout(); }
  }

  function toggleLayout() {
    const ws = workspaces[current];
    ws.layout = ws.layout === 'master' ? 'dwindle' : 'master';
    toast(`Layout: <b>${ws.layout}</b>`);
    layout();
  }

  // Swap the focused tile into the master slot; it also inherits the idle-proof "master" status.
  function promoteMaster() {
    const f = focused();
    const first = wsWins(current)[0];
    if (!f || !first) return;
    if (f !== first) swapWins(f, first);
    for (const w of wsWins(current)) {
      w.master = w === f && w.kind !== 'agent';
      w.el.classList.toggle('master', w.master);
      updateBadge(w);
    }
    focusWin(f);
  }

  function toggleFullscreen() {
    const f = focused();
    if (!f) return;
    const ws = workspaces[current];
    ws.fullscreen = ws.fullscreen === f.id ? null : f.id;
    layout();
  }

  function moveToWorkspace(i) {
    const f = focused();
    if (!f || i === f.ws) return;
    const from = f.ws;
    detach(f);
    insert(f, i, null);
    workspaces[i].focused = f.id;
    f.el.classList.remove('focused');
    layout(from); layout(i, true);
    const n = wins.get(wsWins(from).at(-1)?.id);
    if (n) focusWin(n);
    refreshBar();
  }

  function closeDoneAgents() {
    for (const w of [...wins.values()]) if (w.kind === 'agent' && w.status === 'done') closeWin(w);
  }

  // ------------------------------------------------------------ mouse

  let drag = null;
  function onWinMouseDown(e, w) {
    if (!w.alive) return;
    if (workspaces[w.ws].focused !== w.id || !w.el.classList.contains('focused')) focusWin(w);
    if (!e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    drag = { w, button: e.button, x: e.clientX, y: e.clientY, target: null };
    if (e.button === 0) w.el.classList.add('dragging');
  }
  window.addEventListener('contextmenu', e => { if (e.altKey) e.preventDefault(); }, true);
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    if (drag.button === 0) {
      const over = document.elementsFromPoint(e.clientX, e.clientY).map(el => el.closest?.('.win')).find(el => el && el !== drag.w.el);
      const tw = over && [...wins.values()].find(o => o.el === over);
      if (drag.target && drag.target !== tw) drag.target.el.classList.remove('drop-target');
      drag.target = tw || null;
      tw?.el.classList.add('drop-target');
    } else if (drag.button === 2) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const ws = workspaces[drag.w.ws];
      const A = area();
      if (ws.layout === 'master') {
        ws.mfact = Math.min(0.85, Math.max(0.2, ws.mfact + dx / A.w));
        return layout(drag.w.ws, true);
      }
      for (const [axis, d, size] of [['h', dx, A.w], ['v', dy, A.h]]) {
        if (!d) continue;
        let node = findLeaf(ws.tree, drag.w), p;
        while ((p = parentOf(ws.tree, node)) && p.split !== axis) node = p;
        if (p) p.ratio = Math.min(0.9, Math.max(0.1, p.ratio + d / size * 1.6));
      }
      layout(drag.w.ws, true);
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag.w.el.classList.remove('dragging');
    if (drag.target) { drag.target.el.classList.remove('drop-target'); swapWins(drag.w, drag.target); }
    drag = null;
  });
  desktop.addEventListener('wheel', e => {
    if (!e.altKey) return;
    e.preventDefault();
    switchWorkspace(Math.min(WS_COUNT - 1, Math.max(0, current + Math.sign(e.deltaY))));
  }, { passive: false });

  // ------------------------------------------------------------ keys

  const norm = code => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace(/^NumpadEnter$/, 'Enter');
  const MODS = ['Ctrl', 'Alt', 'Shift'];
  const canon = combo => { const p = combo.split('+').map(s => s.trim()); const k = p.pop(); return [...MODS.filter(m => p.includes(m)), k].join('+'); };
  const eventCombo = e => [...(e.ctrlKey ? ['Ctrl'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), norm(e.code)].join('+');

  const actions = {
    newAgent: () => newTerminal('ai'),
    newAgentIn: async () => { const d = await operant.pickFolder(); if (d) { lastCwd = d; newTerminal('ai', d); } },
    pickAgent: () => togglePanel('launcher'),
    newShell: () => newTerminal('shell'),
    close: () => { const f = focused(); if (f) closeWin(f); },
    fullscreen: toggleFullscreen,
    toggleSplit,
    closeDoneAgents,
    toggleSidebar,
    newWindow: () => operant.newWindow(),
    toggleLayout,
    promoteMaster,
    focusLeft: () => focusWin(neighbour('Left')), focusRight: () => focusWin(neighbour('Right')),
    focusUp: () => focusWin(neighbour('Up')), focusDown: () => focusWin(neighbour('Down')),
    swapLeft: () => swapWith(neighbour('Left')), swapRight: () => swapWith(neighbour('Right')),
    swapUp: () => swapWith(neighbour('Up')), swapDown: () => swapWith(neighbour('Down')),
    resizeLeft: () => resize('Left'), resizeRight: () => resize('Right'), resizeUp: () => resize('Up'), resizeDown: () => resize('Down'),
    prevWorkspace: () => switchWorkspace(current - 1), nextWorkspace: () => switchWorkspace(current + 1),
    help: () => togglePanel('keys'),
    settings: () => togglePanel('settings'),
    openConfig: () => operant.openConfig(),
    devtools: () => operant.devtools(),
    mediaPlayPause: () => operant.media('toggle'),
    mediaNext: () => operant.media('next'),
    mediaPrev: () => operant.media('prev'),
    mediaShuffle: () => operant.media('shuffle'),
    tokenUsage: () => togglePanel('usage'),
  };
  const bindMap = new Map();
  for (let i = 1; i <= WS_COUNT; i++) {
    actions[`ws${i}`] = () => switchWorkspace(i - 1);
    actions[`mv${i}`] = () => moveToWorkspace(i - 1);
  }
  function rebuildBinds() {
    bindMap.clear();
    for (const [action, combos] of Object.entries(cfg.keybinds)) if (actions[action]) for (const c of [].concat(combos)) bindMap.set(canon(c), action);
    for (let i = 1; i <= WS_COUNT; i++) { bindMap.set(`Alt+${i}`, `ws${i}`); bindMap.set(`Alt+Shift+${i}`, `mv${i}`); }
  }
  rebuildBinds();
  function bindLabel(action) { return [].concat(cfg.keybinds[action] || [])[0] || ''; }

  function handleTermKey(e, w) {
    if (e.type !== 'keydown') return true;
    if (bindMap.has(eventCombo(e))) return false;
    // Windows-style clipboard: Ctrl+C copies when there's a selection, Ctrl+V pastes.
    if (e.ctrlKey && !e.altKey && e.code === 'KeyC' && w.term.hasSelection()) {
      navigator.clipboard.writeText(w.term.getSelection()); w.term.clearSelection(); return false;
    }
    if (e.ctrlKey && !e.altKey && e.code === 'KeyV' && w.ptyId) {
      navigator.clipboard.readText().then(t => t && w.term.paste(t)); e.preventDefault(); return false;
    }
    return true;
  }

  window.addEventListener('keydown', e => {
    if (recording) { e.preventDefault(); e.stopPropagation(); return recordKey(e); }
    const panel = openPanel();
    if (e.key === 'Escape' && panel) { closePanels(); e.preventDefault(); return; }
    if (panel === 'launcher' && !e.ctrlKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
      e.preventDefault(); return launch(+e.code.at(-1) - 1, e.shiftKey);
    }
    const action = bindMap.get(eventCombo(e));
    if (!action) return;
    // With a panel open only the panel keys work, so nothing happens to the tiles behind it.
    if (panel && action !== 'help' && action !== 'settings' && action !== 'pickAgent' && action !== 'tokenUsage') return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat || action.startsWith('resize')) actions[action]();
  }, true);
  // Stop a lone Alt press from doing anything odd in the frameless window.
  window.addEventListener('keyup', e => { if (e.key === 'Alt') e.preventDefault(); }, true);

  // ------------------------------------------------------------ panels

  const PANELS = ['keys', 'settings', 'launcher', 'usage'];
  const openPanel = () => PANELS.find(p => !$('#' + p).classList.contains('hidden'));
  function togglePanel(name) {
    const was = openPanel();
    closePanels(was === name);
    if (was === name) return;
    if (name === 'keys') { keysTarget = $('#keys-body'); renderKeys(); } else if (name === 'launcher') renderLauncher(); else if (name === 'usage') { usageHover = -1; renderUsage(); } else renderSettings();
    $('#' + name).classList.remove('hidden');
    $('#' + name + ' .card-body').scrollTop = 0;
    document.activeElement?.blur();
  }
  function closePanels(refocus = true) {
    recording = null;
    welcome = null; // dismissed without choosing: ask again next start
    PANELS.forEach(p => $('#' + p).classList.add('hidden'));
    if (refocus) focused()?.term.focus();
  }
  for (const p of PANELS) {
    $('#' + p).addEventListener('mousedown', e => { if (e.target.id === p) closePanels(); });
    $('#' + p).querySelector('[data-close]').onclick = () => closePanels();
  }
  $('#btn-keys').onclick = () => togglePanel('keys');
  $('#btn-new').onclick = () => togglePanel('launcher');

  // Agent launcher: 1-9 (or a click) opens that agent, Shift picks a folder first.
  // On first run it asks which agent to use instead; the answer becomes the default.
  let welcome = null; // { dir } while the first-run question is showing
  function renderLauncher() {
    $('#launcher-title').textContent = welcome ? 'Choose your agent' : 'New agent';
    $('#launcher-sub').textContent = welcome ? '1–9 or click to choose' : '1–9 opens one · Shift picks a folder first';
    $('#launcher-foot').textContent = welcome ? 'It opens now and each time Operant starts. Change it in Settings › Agents.' : 'Add or change agents in Settings › Agents';
    $('#launcher-body').innerHTML = cfg.agents.map((a, i) => `<button class="launch-row" data-i="${i}">
      <span class="ico">${esc(a.icon || '●')}</span><span class="nm">${esc(a.name)}<small>${esc([a.command, ...[].concat(a.args || [])].join(' '))}</small></span>
      ${a.id === cfg.defaultAgent && !welcome ? '<span class="def">default</span>' : ''}${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}</button>`).join('')
      + (welcome ? '' : `<button class="launch-row" data-shell><span class="ico">❯</span><span class="nm">Shell<small>${esc(cfg.shell)}</small></span>${k('newShell')}</button>`
        + `<button class="launch-row" data-window><span class="ico">◈</span><span class="nm">New Operant window<small>Its own workspaces and tiles</small></span>${k('newWindow')}</button>`);
    $('#launcher-body').querySelectorAll('[data-i]').forEach(b => b.onclick = e => launch(+b.dataset.i, e.shiftKey));
    const sh = $('#launcher-body [data-shell]');
    if (sh) sh.onclick = () => { closePanels(false); newTerminal('shell'); };
    const nw = $('#launcher-body [data-window]');
    if (nw) nw.onclick = () => { closePanels(false); operant.newWindow(); };
  }
  const k = a => bindLabel(a) ? `<kbd>${esc(Panels.pretty(bindLabel(a)))}</kbd>` : '';
  async function launch(i, pickDir) {
    const a = cfg.agents[i];
    if (!a) return;
    const first = welcome;
    closePanels(false);
    if (first) {
      setSetting('defaultAgent', a.id);
      return newTerminal('ai', first.dir, { agentId: a.id, master: true });
    }
    let dir;
    if (pickDir) { dir = await operant.pickFolder(); if (!dir) return; lastCwd = dir; }
    newTerminal('ai', dir, { agentId: a.id });
  }
  $('#btn-settings').onclick = () => togglePanel('settings');

  // Settings save a moment after the last change, so dragging a slider writes once.
  let pending = {}, saveT;
  function save(patch) {
    Object.assign(pending, patch);
    clearTimeout(saveT);
    saveT = setTimeout(() => { operant.setConfig(pending); pending = {}; }, 300);
  }

  const LIVE_LAYOUT = new Set(['defaultLayout', 'masterRatio']);
  function setSetting(key, value) {
    cfg[key] = value;
    save({ [key]: value });
    if (LIVE_LAYOUT.has(key)) for (const ws of workspaces) if (!ws.tree) { ws.layout = cfg.defaultLayout; ws.mfact = cfg.masterRatio; }
    if (key === 'agents' || key === 'defaultAgent') renderHints();
    if (key === 'mediaControls') renderMedia();
    if (key === 'tokenUsage' || key === 'usageSeries') { renderUsagePill(); drawUsage(); }
    if (key === 'sidebarHiddenFiles') dirCache.clear();
    if (key === 'defaultAgent' && !cfg.agentChosen) { cfg.agentChosen = true; save({ agentChosen: true }); }
    applyAppearance();
  }
  let updateStatus = null;
  const renderSettings = () => Panels.renderSettings($('#settings-body'), cfg, setSetting, operant.pickFolder, {
    renderKeys: el => { keysTarget = el; renderKeys(); },
    renderCodegraph,
    update: () => ({ version, status: updateStatus }),
    checkUpdate: () => operant.checkUpdate(),
    installUpdate: () => operant.installUpdate(),
    openReleases: () => operant.openReleases(),
    openLink: url => operant.openLink(url),
  });
  // Settings › CodeGraph: the installed version, install/update, index everything.
  let cgVersion; // undefined until asked, null when not installed
  async function renderCodegraph(el) {
    const draw = () => {
      const known = cgVersion !== undefined;
      el.innerHTML = `<div class="update-card"><span class="uc-logo">◇</span><div class="uc-main"><div class="uc-name">CodeGraph${cgVersion ? ' ' + esc(cgVersion) : ''}</div>`
        + `<div class="uc-status">${!known ? 'Checking…' : cgVersion ? 'Installed' : 'Not installed'}</div></div>`
        + `<button class="btn" data-cg="install">${cgVersion ? 'Update' : 'Install'} CodeGraph</button>`
        + `<button class="btn" data-cg="index"${cgVersion ? '' : ' disabled'}>Index all projects</button></div>`
        + '<div class="cg-note">A code index your agents query instead of grepping. Installing runs <code>codegraph install</code>, which connects it to your agents. Index a project with ◇ in the sidebar.</div>';
      el.querySelector('[data-cg="install"]').onclick = () => {
        closePanels(false); cgVersion = undefined;
        newTerminal('shell', null, { run: 'npm i -g @colbymchenry/codegraph@latest; if ($?) { codegraph install }', title: 'CodeGraph' });
      };
      el.querySelector('[data-cg="index"]').onclick = () => { closePanels(false); runCodegraph(allProjects(), 'all projects'); };
    };
    draw();
    cgVersion = await operant.codegraphVersion();
    if (el.isConnected) draw();
  }
  $('#set-json').onclick = () => operant.openConfig();
  const resetBtn = $('#set-reset');
  resetBtn.onclick = () => {
    if (!resetBtn.dataset.armed) {
      resetBtn.dataset.armed = '1'; resetBtn.textContent = 'Click again to reset';
      return setTimeout(() => { delete resetBtn.dataset.armed; resetBtn.textContent = 'Reset to defaults'; }, 3000);
    }
    const patch = {};
    for (const k of Object.keys(defaults)) if (k !== 'keybinds') { patch[k] = null; cfg[k] = defaults[k]; }
    save(patch);
    applyAppearance(); renderSettings(); renderHints();
    toast('Settings reset to defaults. Keybinds were kept.');
  };

  // Keybinds: only the ones that differ from the defaults are saved.
  let recording = null;
  let keysTarget = null; // the keybinds popup, or the Keybinds tab in Settings
  function saveKeybinds() {
    const diff = {};
    for (const [a, v] of Object.entries(cfg.keybinds)) if (JSON.stringify(v) !== JSON.stringify(defaults.keybinds[a])) diff[a] = v;
    save({ keybinds: diff });
    rebuildBinds(); renderHints(); renderKeys();
  }
  function renderKeys() {
    Panels.renderKeys(keysTarget || $('#keys-body'), cfg.keybinds, recording, {
      onAdd: a => { recording = recording === a ? null : a; renderKeys(); },
      onRemove: (a, i) => { cfg.keybinds[a] = [].concat(cfg.keybinds[a]).filter((_, j) => j !== i); saveKeybinds(); },
    });
  }
  function recordKey(e) {
    if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(e.code)) return;
    const a = recording;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { recording = null; return renderKeys(); }
    const combo = eventCombo(e);
    if (!e.ctrlKey && !e.altKey && !/^F\d+$/.test(norm(e.code))) return toast('Use Ctrl or Alt with it (or an F-key), so typing still reaches the terminal.');
    if (/^Alt\+(Shift\+)?[1-9]$/.test(combo)) return toast(`<b>${combo}</b> is fixed for workspaces.`);
    recording = null;
    for (const [other, combos] of Object.entries(cfg.keybinds)) {
      const list = [].concat(combos);
      if (other !== a && list.some(c => canon(c) === combo)) {
        cfg.keybinds[other] = list.filter(c => canon(c) !== combo);
        toast(`<b>${combo}</b> moved from “${esc(Panels.actionName(other))}”.`);
      }
    }
    const mine = [].concat(cfg.keybinds[a] || []);
    if (!mine.some(c => canon(c) === combo)) cfg.keybinds[a] = [...mine, combo];
    saveKeybinds();
  }
  $('#keys-reset').onclick = () => { cfg.keybinds = structuredClone(defaults.keybinds); recording = null; saveKeybinds(); toast('Keybinds reset to defaults.'); };

  // ------------------------------------------------------------ bar

  const wsBar = $('#workspaces');
  function refreshBar() {
    wsBar.innerHTML = '';
    for (let i = 0; i < WS_COUNT; i++) {
      const list = wsWins(i);
      if (i > 4 && !list.length && i !== current) continue;
      const b = document.createElement('button');
      b.className = 'ws-btn' + (i === current ? ' active' : '') + (list.length ? ' occupied' : '')
        + (list.some(isWorking) ? ' busy' : '');
      b.textContent = i + 1;
      b.onclick = () => switchWorkspace(i);
      wsBar.appendChild(b);
    }
    const f = focused();
    $('#bar-title').textContent = f ? f.title : '';
    refreshStats();
    sidebarChanged();
  }

  // Agent CLI tiles (the master among them) count as running while output is streaming, idle otherwise.
  const aiWorking = w => w.busySince && Date.now() - w.lastOut < 3000;
  const isWorking = w => w.kind === 'agent' ? w.status === 'running' : w.kind === 'ai' && aiWorking(w);
  let lastStats = '', lastBusy = '';
  function refreshStats() {
    const all = [...wins.values()];
    const ag = all.filter(w => w.kind === 'agent');
    const ai = all.filter(w => w.kind === 'ai');
    const agRun = ag.filter(w => w.status === 'running').length;
    const aiRun = ai.filter(aiWorking).length;
    const html = `◆ <span class="run">${agRun + aiRun} running</span> · <span class="idle">${ai.length - aiRun} idle</span> · <span class="ok">${ag.length - agRun} done</span>`;
    if (html !== lastStats) $('#stat-agents').innerHTML = lastStats = html;
  }
  // Working state changes without any other event, so redraw the bar when a workspace's busy dot would.
  setInterval(() => {
    const busy = workspaces.map((_, i) => wsWins(i).some(isWorking) ? 1 : 0).join('');
    if (busy !== lastBusy) { lastBusy = busy; refreshBar(); } else refreshStats();
  }, 1000);

  function toast(html, onClick) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    t.onclick = () => { onClick?.(); t.remove(); };
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 5000);
  }
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  tick(); setInterval(tick, 10000);
  $('#wc-min').onclick = operant.minimize; $('#wc-max').onclick = operant.maximize; $('#wc-close').onclick = operant.close;

  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { workspaces.forEach((_, i) => layout(i, true)); drawUsage(); }, 60); });

  // ------------------------------------------------------------ sidebar
  // Pinned projects and the folders open tiles run in, each a lazily loaded folder tree.
  // Selecting a folder makes it where new tiles open; right-click for more.

  const sideBody = $('#side-body'), sideMenu = $('#side-menu');
  const dirCache = new Map();          // folder -> entries (null = unreadable)
  // Folders you opened, and projects you closed (projects start open). Remembered per profile.
  let expanded = new Set(), collapsed = new Set(), selected = null, sideSig = '';
  try {
    expanded = new Set(JSON.parse(localStorage.getItem('operant.sidebar.expanded') || '[]'));
    collapsed = new Set(JSON.parse(localStorage.getItem('operant.sidebar.collapsed') || '[]'));
  } catch {}
  const saveExpanded = () => { try {
    localStorage.setItem('operant.sidebar.expanded', JSON.stringify([...expanded]));
    localStorage.setItem('operant.sidebar.collapsed', JSON.stringify([...collapsed]));
  } catch {} };
  const isOpen = (p, project) => project ? !collapsed.has(p) : expanded.has(p);

  const normPath = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const isUnder = (p, rootDir) => { const a = normPath(p), b = normPath(rootDir); return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/'); };
  const baseName = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const tileDirs = () => [...wins.values()].filter(w => w.cwd && w.kind !== 'agent').map(w => w.cwd);

  function applySidebar() {
    document.body.classList.toggle('side-open', !!cfg.sidebar);
    root.setProperty('--side-w', cfg.sidebarWidth + 'px');
    $('#side-cg').hidden = !cfg.codegraphButtons;
    $('#btn-sidebar').title = `${cfg.sidebar ? 'Hide' : 'Show'} the projects sidebar${bindLabel('toggleSidebar') ? ` (${Panels.pretty(bindLabel('toggleSidebar'))})` : ''}`;
    if (cfg.sidebar) renderSidebar();
  }

  async function loadDir(dir, force = false) {
    if (!force && dirCache.has(dir)) return dirCache.get(dir);
    const list = await operant.listDir(dir, cfg.sidebarHiddenFiles);
    dirCache.set(dir, list);
    return list;
  }

  // Every pinned project: the ungrouped ones, then each group's.
  const groups = () => cfg.projectGroups || [];
  const allProjects = () => [...cfg.projects, ...groups().flatMap(g => g.projects || [])].filter(Boolean);
  const isPinned = p => allProjects().some(x => normPath(x) === normPath(p));
  const groupOf = p => groups().findIndex(g => (g.projects || []).some(x => normPath(x) === normPath(p)));
  function roots() {
    const projects = cfg.projects.filter(Boolean), all = allProjects();
    const others = [];
    for (const d of tileDirs()) if (!all.some(p => isUnder(d, p)) && !others.some(o => normPath(o) === normPath(d))) others.push(d);
    return { projects, others };
  }

  // Group headers. editing = { i, value } while a group's name is being typed in its header.
  let editing = null, redrawing = false;
  const cgOn = () => cfg.codegraphButtons !== false && typeof runCodegraph === 'function';
  function groupHtml(g, i) {
    const open = !collapsed.has('group:' + g.name), list = (g.projects || []).filter(Boolean);
    let html = `<div class="group-row${open ? ' open' : ''}" data-group="${i}" title="${esc(g.name)}"><span class="tw">▶</span>`
      + (editing?.i === i ? `<input class="group-name" value="${esc(editing.value)}" spellcheck="false">` : `<span class="nm">${esc(g.name)}</span>`)
      + `<span class="gcount">${list.length}</span>`
      + `<span class="acts">${cgOn() ? '<button data-gact="cg" title="Index group with CodeGraph">◇</button>' : ''}<button data-gact="add" title="Add a project to this group">＋</button></span></div>`;
    if (open) html += list.length ? list.map(p => nodeHtml({ name: baseName(p), path: p, dir: true }, 1, true)).join('')
      : `<div class="side-empty" style="padding-left:12px">Right-click a project and choose <i>Move to ${esc(g.name)}</i>, or use ＋.</div>`;
    return html;
  }

  function nodeHtml(entry, depth, project = false) {
    const p = entry.path, open = entry.dir && isOpen(p, project);
    const f = focused();
    const count = project ? tileDirs().filter(d => isUnder(d, p)).length : 0;
    const cls = ['node-row', entry.dir ? 'dir' : 'file', open ? 'open' : '', project ? 'project' : '',
      project && f?.cwd && isUnder(f.cwd, p) ? 'active' : '', selected && normPath(selected) === normPath(p) ? 'sel' : ''].filter(Boolean).join(' ');
    const agent = defaultAgent();
    let html = `<div class="${cls}" data-path="${esc(p)}" data-dir="${entry.dir ? 1 : ''}" data-project="${project ? 1 : ''}" title="${esc(p)}" style="padding-left:${4 + depth * 12}px">`
      + `<span class="tw">${entry.dir ? '▶' : ''}</span>`
      + (project ? '<span class="fi">◈</span>' : entry.dir ? '' : '<span class="fi">·</span>')
      + `<span class="nm">${esc(entry.name)}</span>`
      + (count ? `<span class="count" title="${count} open tile${count === 1 ? '' : 's'}">${count}</span>` : '')
      + (entry.dir ? `<span class="acts">${project && cfg.codegraphButtons ? '<button data-act="cg" title="Index with CodeGraph">◇</button>' : ''}${project ? `<button data-act="ide" title="Open in ${esc(ideName())}">⌨</button>` : ''}<button data-act="agent" title="New ${esc(agent?.name || 'agent')} here">${esc(agent?.icon || '✻')}</button><button data-act="shell" title="New shell here">❯</button></span>` : '')
      + '</div>';
    if (open) {
      const kids = dirCache.get(p);
      if (kids === undefined) html += `<div class="side-empty" style="padding-left:${16 + depth * 12}px">…</div>`;
      else if (kids === null) html += `<div class="side-empty" style="padding-left:${16 + depth * 12}px">Can't read this folder</div>`;
      else if (!kids.length) html += `<div class="side-empty" style="padding-left:${16 + depth * 12}px">Empty</div>`;
      else for (const k of kids) html += nodeHtml(k, depth + 1);
    }
    return html;
  }

  // Loads every expanded folder that isn't cached yet, then draws. force re-reads them all.
  async function renderSidebar(force = false) {
    if (!cfg.sidebar) return;
    const { projects, others } = roots();
    const draw = () => {
      let html = '';
      html += projects.map(p => nodeHtml({ name: baseName(p), path: p, dir: true }, 0, true)).join('');
      if (!allProjects().length) html += `<div class="side-empty">Pin folders here with ＋, or right-click a folder below and choose <i>Pin as project</i>.</div>`
        + nodeHtml({ name: baseName(cfg.defaultCwd), path: cfg.defaultCwd, dir: true }, 0, true);
      html += groups().map(groupHtml).join('');
      if (others.length) html += `<div class="side-group">OPEN IN TILES</div>` + others.map(p => nodeHtml({ name: baseName(p), path: p, dir: true }, 0, true)).join('');
      const top = sideBody.scrollTop, old = sideBody.querySelector('.group-name'), sel = old && [old.selectionStart, old.selectionEnd];
      redrawing = true; sideBody.innerHTML = html; redrawing = false;
      sideBody.scrollTop = top;
      const input = editing && sideBody.querySelector('.group-name');
      if (input) { input.focus(); if (sel) input.setSelectionRange(...sel); else input.select(); }
    };
    if (force) dirCache.clear();
    draw();
    const visibleOpen = () => [...sideBody.querySelectorAll('.node-row.open')].map(r => r.dataset.path).filter(p => !dirCache.has(p));
    for (let missing = visibleOpen(); missing.length; missing = visibleOpen()) {
      await Promise.all(missing.map(p => loadDir(p)));
      draw();
    }
  }

  // Redraw when the projects, the open tiles' folders or the focused tile change.
  function sidebarChanged() {
    const sig = JSON.stringify([cfg.projects, cfg.projectGroups, tileDirs(), focused()?.cwd, cfg.defaultAgent]);
    if (sig !== sideSig) { sideSig = sig; renderSidebar(); }
  }

  function toggleSidebar() { setSetting('sidebar', !cfg.sidebar); }
  $('#btn-sidebar').onclick = toggleSidebar;
  $('#side-hide').onclick = toggleSidebar;
  $('#side-refresh').onclick = () => renderSidebar(true);
  $('#side-add').onclick = async () => { const d = await operant.pickFolder(); if (d) pinProject(d); };
  $('#side-cg').onclick = () => runCodegraph(allProjects(), 'all projects');
  $('#side-group').onclick = () => newGroup();
  window.addEventListener('focus', () => { if (cfg.sidebar) renderSidebar(true); });

  function pinProject(p) {
    if (isPinned(p)) return;
    setSetting('projects', [...cfg.projects, p]);
    collapsed.delete(p); saveExpanded();
  }
  const without = (list, p) => (list || []).filter(x => normPath(x) !== normPath(p));
  function unpinProject(p) {
    setSetting('projects', without(cfg.projects, p));
    setSetting('projectGroups', groups().map(g => ({ ...g, projects: without(g.projects, p) })));
    renderSidebar();
  }

  // Groups: gi is a group's index, -1 for the ungrouped projects.
  function moveToGroup(p, gi) {
    setSetting('projects', gi < 0 ? [...without(cfg.projects, p), p] : without(cfg.projects, p));
    setSetting('projectGroups', groups().map((g, i) => ({ ...g, projects: [...without(g.projects, p), ...(i === gi ? [p] : [])] })));
    collapsed.delete(p); saveExpanded();
    renderSidebar();
  }
  function newGroup(p) {
    let name = 'New group';
    for (let k = 2; groups().some(g => g.name === name); k++) name = `New group ${k}`;
    if (p) setSetting('projects', without(cfg.projects, p));
    const gs = groups().map(g => ({ ...g, projects: p ? without(g.projects, p) : [...(g.projects || [])] }));
    setSetting('projectGroups', [...gs, { name, projects: p ? [p] : [] }]);
    collapsed.delete('group:' + name); saveExpanded();
    editing = { i: gs.length, value: name };
    renderSidebar();
  }
  function commitGroupName(keep) {
    if (!editing) return;
    const { i, value } = editing, g = groups()[i], name = value.trim();
    editing = null;
    if (keep && g && name && name !== g.name && !groups().some(x => x.name === name)) {
      if (collapsed.delete('group:' + g.name)) { collapsed.add('group:' + name); saveExpanded(); }
      setSetting('projectGroups', groups().map((x, j) => j === i ? { ...x, name } : x));
    }
    renderSidebar();
  }
  function removeGroup(i) {
    const g = groups()[i];
    if (!g) return;
    const back = (g.projects || []).filter(p => p && !cfg.projects.some(x => normPath(x) === normPath(p)));
    setSetting('projects', [...cfg.projects, ...back]);
    setSetting('projectGroups', groups().filter((_, j) => j !== i));
    collapsed.delete('group:' + g.name); saveExpanded();
    renderSidebar();
  }
  async function groupAct(i, act) {
    const g = groups()[i];
    if (!g) return;
    if (act === 'cg') return runCodegraph((g.projects || []).filter(Boolean), g.name);
    if (act === 'rename') { editing = { i, value: g.name }; return renderSidebar(); }
    if (act === 'add') { const d = await operant.pickFolder(); if (d) moveToGroup(d, i); }
  }

  const ideName = () => cfg.ide === 'custom' ? 'IDE' : (IDES.find(i => i[0] === cfg.ide)?.[1] || cfg.ide);
  async function openInIde(dir) {
    const err = await operant.openInIde(dir);
    if (err) toast(`<b>Couldn't open ${esc(ideName())}</b><br>${esc(err)}`);
  }

  function openHere(dir, what) {
    if (what === 'ide') return openInIde(dir);
    lastCwd = dir;
    if (what === 'agent') newTerminal('ai', dir);
    else if (what === 'shell') newTerminal('shell', dir);
    else if (what === 'pick') togglePanel('launcher');
    else if (what === 'cg') runCodegraph([dir]);
  }

  // One shell tile that indexes each folder with CodeGraph: sync if it has a .codegraph, init otherwise.
  function runCodegraph(dirs, label) {
    dirs = (dirs || []).filter(Boolean);
    if (!dirs.length) return toast('No projects to index. Pin a folder first.');
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const steps = dirs.map(d => `Write-Host ''; Write-Host ${q('== ' + d)} -ForegroundColor Cyan; `
      + `if (Test-Path -LiteralPath (Join-Path ${q(d)} '.codegraph')) { codegraph sync ${q(d)} } else { codegraph init -y ${q(d)} }`);
    const run = `if (-not (Get-Command codegraph -ErrorAction SilentlyContinue)) { Write-Host 'CodeGraph is not installed. Install it from Settings > CodeGraph.' -ForegroundColor Yellow } else { `
      + steps.join('; ') + `; Write-Host ''; Write-Host 'CodeGraph done for ${dirs.length} project(s)' -ForegroundColor Green }`;
    newTerminal('shell', dirs[0], { run, title: `CodeGraph · ${label || baseName(dirs[0])}` });
  }

  sideBody.addEventListener('click', e => {
    const grow = e.target.closest('.group-row');
    if (grow && !e.target.closest('.group-name')) {
      const i = +grow.dataset.group, gact = e.target.closest('[data-gact]');
      if (gact) return groupAct(i, gact.dataset.gact);
      const k = 'group:' + groups()[i]?.name;
      if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
      saveExpanded();
      return renderSidebar();
    }
    const row = e.target.closest('.node-row');
    if (!row) return;
    const p = row.dataset.path;
    const act = e.target.closest('[data-act]');
    if (act) return openHere(p, act.dataset.act);
    selected = p;
    if (row.dataset.dir) {
      lastCwd = p;
      const set = row.dataset.project ? collapsed : expanded;
      if (set.has(p)) set.delete(p); else set.add(p);
      saveExpanded();
    }
    renderSidebar();
  });
  sideBody.addEventListener('dblclick', e => {
    const grow = e.target.closest('.group-row');
    if (grow && !e.target.closest('.group-name, [data-gact]')) return groupAct(+grow.dataset.group, 'rename');
    const row = e.target.closest('.node-row');
    if (row && !row.dataset.dir) operant.openPath(row.dataset.path);
  });
  sideBody.addEventListener('input', e => { if (editing && e.target.matches('.group-name')) editing.value = e.target.value; });
  sideBody.addEventListener('keydown', e => {
    if (!e.target.matches('.group-name')) return;
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); commitGroupName(e.key === 'Enter'); }
  });
  sideBody.addEventListener('focusout', e => { if (!redrawing && e.target.matches('.group-name')) commitGroupName(true); });

  function showMenu(x, y, items) {
    sideMenu.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}"><span class="ico">${it[0]}</span>${esc(it[1])}</button>`).join('');
    sideMenu.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { hideMenu(); items[+b.dataset.i][2](); });
    sideMenu.classList.remove('hidden');
    const r = sideMenu.getBoundingClientRect();
    sideMenu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
    sideMenu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  }
  const hideMenu = () => sideMenu.classList.add('hidden');
  window.addEventListener('mousedown', e => { if (!sideMenu.contains(e.target)) hideMenu(); }, true);
  window.addEventListener('blur', hideMenu);

  sideBody.addEventListener('contextmenu', e => {
    const grow = e.target.closest('.group-row');
    if (grow) {
      if (e.target.closest('.group-name')) return;
      e.preventDefault();
      const i = +grow.dataset.group;
      return showMenu(e.clientX, e.clientY, [
        ['✎', 'Rename', () => groupAct(i, 'rename')],
        ...(cgOn() ? [['◇', 'Index group with CodeGraph', () => groupAct(i, 'cg')]] : []),
        ['＋', 'Add project…', () => groupAct(i, 'add')],
        '-',
        ['✕', 'Remove group', () => removeGroup(i)],
      ]);
    }
    const row = e.target.closest('.node-row');
    if (!row) return;
    e.preventDefault();
    const p = row.dataset.path;
    const copy = ['⧉', 'Copy path', () => navigator.clipboard.writeText(p)];
    if (!row.dataset.dir) return showMenu(e.clientX, e.clientY, [['↗', 'Open', () => operant.openPath(p)], ['▤', 'Show in Explorer', () => operant.reveal(p)], copy]);
    const pinned = isPinned(p), gi = groupOf(p);
    const grouping = !pinned ? [] : [
      ...groups().map((g, i) => i === gi ? null : ['▣', `Move to ${g.name}`, () => moveToGroup(p, i)]).filter(Boolean),
      ['▣', 'Move to new group…', () => newGroup(p)],
      ...(gi >= 0 ? [['↩', 'Remove from group', () => moveToGroup(p, -1)]] : []),
    ];
    const agent = defaultAgent();
    showMenu(e.clientX, e.clientY, [
      [esc(agent?.icon || '✻'), `New ${agent?.name || 'agent'} here`, () => openHere(p, 'agent')],
      ['☰', 'Pick an agent here…', () => openHere(p, 'pick')],
      ['❯', 'New shell here', () => openHere(p, 'shell')],
      '-',
      ['⌨', `Open in ${ideName()}`, () => openInIde(p)],
      ['▤', 'Open in Explorer', () => operant.openPath(p)],
      ...(cfg.codegraphButtons ? [['◇', 'Index with CodeGraph', () => runCodegraph([p])]] : []),
      copy,
      '-',
      ...grouping,
      pinned ? ['✕', 'Remove from projects', () => unpinProject(p)] : ['◈', 'Pin as project', () => pinProject(p)],
    ]);
  });

  // Drag the right edge to resize; the tiles follow.
  $('#side-grip').addEventListener('mousedown', e => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.classList.add('drag'); document.body.classList.add('side-resizing');
    const move = ev => {
      cfg.sidebarWidth = Math.round(Math.min(600, Math.max(160, ev.clientX)));
      root.setProperty('--side-w', cfg.sidebarWidth + 'px');
      layout(current, true);
    };
    const up = () => {
      grip.classList.remove('drag'); document.body.classList.remove('side-resizing');
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      setSetting('sidebarWidth', cfg.sidebarWidth);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });

  // ------------------------------------------------------------ media
  // What Windows is playing (Spotify, a browser tab, ...), from the helper in main. The volume is
  // that app's own mixer volume, or the system volume when the app has no audio session of its own.

  const mediaEl = $('#media'), volEl = $('#media-volume');
  let mediaState = { active: false }, volDragUntil = 0, volSendT = null, volBeforeMute = 0.5;

  function renderMedia(s = mediaState) {
    mediaState = s;
    const show = !!(cfg.mediaControls && s.active && (s.title || s.artist));
    mediaEl.classList.toggle('hidden', !show);
    $('.bar-center').classList.toggle('has-media', show);
    if (!show) return;
    const art = $('#media-art');
    if (s.art) { if (art.getAttribute('src') !== s.art) art.src = s.art; art.classList.remove('none'); }
    else { art.removeAttribute('src'); art.classList.add('none'); }
    $('#media-title').textContent = s.title || '';
    $('#media-artist').textContent = s.artist || '';
    const app = String(s.app || '').replace(/\.exe$/i, '').split('!').pop();
    mediaEl.title = [s.title, s.artist, s.album].filter(Boolean).join(' · ') + (app ? `\n${app}` : '');
    mediaEl.classList.toggle('playing', !!s.playing);
    $('#media-play').title = s.playing ? 'Pause' : 'Play';
    $('#media-play').disabled = !s.canPlayPause;
    $('#media-prev').disabled = !s.canPrev;
    $('#media-next').disabled = !s.canNext;
    const shuffle = $('#media-shuffle');
    shuffle.disabled = !s.canShuffle;
    shuffle.classList.toggle('on', !!s.shuffle);
    shuffle.title = s.shuffle ? 'Shuffle is on' : 'Shuffle';
    const hasVol = s.volume >= 0;
    $('.media-vol').style.display = hasVol ? '' : 'none';
    if (hasVol && Date.now() > volDragUntil) showVolume(s.volume);
    volEl.title = `${s.appVolume ? app || 'App' : 'System'} volume: ${Math.round((s.volume || 0) * 100)}%`;
  }

  function showVolume(v) {
    volEl.value = v;
    volEl.style.setProperty('--v', v * 100 + '%');
    mediaEl.classList.toggle('muted', v <= 0.001);
  }

  function setVolume(v) {
    v = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
    if (v > 0) volBeforeMute = v;
    showVolume(v);
    volDragUntil = Date.now() + 1500; // the helper's next report may still carry the old level
    clearTimeout(volSendT);
    volSendT = setTimeout(() => operant.media('vol ' + v), 40);
  }

  const mediaCmd = cmd => { operant.media(cmd); if (cmd === 'toggle') mediaEl.classList.toggle('playing'); };
  $('#media-play').onclick = () => mediaCmd('toggle');
  $('#media-prev').onclick = () => mediaCmd('prev');
  $('#media-next').onclick = () => mediaCmd('next');
  $('#media-shuffle').onclick = () => { $('#media-shuffle').classList.toggle('on'); mediaCmd('shuffle'); };
  $('#media-mute').onclick = () => setVolume(+volEl.value > 0.001 ? 0 : volBeforeMute || 0.5);
  volEl.oninput = () => setVolume(+volEl.value);
  $('.media-vol').addEventListener('wheel', e => { e.preventDefault(); setVolume(+volEl.value + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
  operant.on('media:state', s => renderMedia(s));
  operant.mediaState().then(renderMedia);

  // ------------------------------------------------------------ token usage
  // Claude Code's tokens today in the bar, and a stacked graph of them over time. Main reads the
  // transcripts; the series ticked in Settings › Usage (or on the graph) are the ones counted.

  const usagePill = $('#usage-pill'), usageBody = $('#usage-body');
  let usageSum = null, usageData = null, usageHover = -1;
  let usageRange = '24h';
  try { usageRange = localStorage.getItem('operant.usage.range') || usageRange; } catch {}
  const counted = () => USAGE_SERIES.filter(([k]) => [].concat(cfg.usageSeries || []).includes(k));
  const countOf = o => counted().reduce((n, [k]) => n + (o[k] || 0), 0);
  const fmtTok = n => n >= 1e9 ? +(n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B' : n >= 1e6 ? +(n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
    : n >= 1e3 ? +(n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n);
  const fullTok = n => Math.round(n).toLocaleString();

  function renderUsagePill(s = usageSum) {
    usageSum = s;
    const show = !!(cfg.tokenUsage && s?.ready);
    usagePill.classList.toggle('hidden', !show);
    if (!show) return;
    usagePill.innerHTML = `<svg viewBox="0 0 16 16"><path d="M2 13.5h12v1.3H2zM3 8h2.3v4.5H3zm3.8-5h2.3v9.5H6.8zm3.9 3h2.3v6.5h-2.3z"/></svg>${fmtTok(countOf(s.today))} <span class="dim">today</span>`;
    usagePill.title = 'Claude Code tokens today\n'
      + USAGE_SERIES.map(([k, n]) => `${n}: ${fullTok(s.today[k])}${counted().some(c => c[0] === k) ? '' : ' (not counted)'}`).join('\n')
      + `\nLast hour: ${fmtTok(countOf(s.hour))}\nClick for the graph`;
  }
  usagePill.onclick = () => togglePanel('usage');
  operant.on('usage:changed', s => {
    renderUsagePill(s);
    if (openPanel() === 'usage') loadUsage();
  });
  operant.usageSummary().then(renderUsagePill);

  async function loadUsage() {
    usageData = await operant.usageSeries(usageRange);
    drawUsage();
  }
  function renderUsage() {
    $('#usage-range').querySelectorAll('[data-range]').forEach(b => b.classList.toggle('on', b.dataset.range === usageRange));
    if (!usageData || usageData.range !== usageRange) usageBody.innerHTML = '<div class="usage-empty">Reading transcripts…</div>';
    loadUsage();
  }
  $('#usage-range').querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    usageRange = b.dataset.range;
    try { localStorage.setItem('operant.usage.range', usageRange); } catch {}
    usageHover = -1;
    renderUsage();
  });
  function toggleSeries(k) {
    const on = new Set(cfg.usageSeries);
    if (on.has(k)) { if (on.size > 1) on.delete(k); } else on.add(k);
    setSetting('usageSeries', USAGE_SERIES.map(s => s[0]).filter(s => on.has(s)));
  }

  // Time labels for the x axis (short) and the tooltip (the whole bucket).
  function usageTime(t, step, long) {
    const d = new Date(t);
    const hm = x => x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (step >= 86400e3) return d.toLocaleDateString([], long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
    const day = step >= 3600e3 ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' : '';
    return long ? `${day}${hm(d)}–${hm(new Date(t + step))}` : day + hm(d);
  }
  const niceStep = v => { const p = 10 ** Math.floor(Math.log10(v || 1)); return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= v); };

  function drawUsage() {
    const d = usageData;
    if (!d || openPanel() !== 'usage') return;
    const series = counted();
    const on = new Set(series.map(s => s[0]));
    const total = countOf(d.totals);
    const tiles = `<div class="usage-tiles"><div class="u-tile total"><span class="u-lbl">Counted</span><span class="u-val">${fmtTok(total)}</span><span class="u-sub">${fullTok(total)}</span></div>`
      + USAGE_SERIES.map(([k, n]) => `<button class="u-tile${on.has(k) ? '' : ' off'}" data-series="${k}" title="${on.has(k) ? 'Leave out' : 'Count'} ${n.toLowerCase()} tokens">`
        + `<span class="u-lbl"><i class="sw s-${k}"></i>${n}</span><span class="u-val">${fmtTok(d.totals[k])}</span><span class="u-sub">${fullTok(d.totals[k])}</span></button>`).join('') + '</div>';
    const projects = d.projects.map(p => ({ name: p.name, n: countOf(p) })).filter(p => p.n > 0).sort((a, b) => b.n - a.n);
    const top = projects.slice(0, 8), rest = projects.slice(8).reduce((n, p) => n + p.n, 0);
    if (rest) top.push({ name: `${projects.length - 8} more`, n: rest, other: true });
    const maxP = Math.max(1, ...top.map(p => p.n));
    const list = top.length ? `<h3>By project</h3><div class="usage-projects">${top.map(p => `<div class="up-row${p.other ? ' other' : ''}"><span class="up-nm" title="${esc(p.name)}">${esc(p.name)}</span>`
      + `<span class="up-bar"><i style="width:${(p.n / maxP * 100).toFixed(1)}%"></i></span><span class="up-val">${fmtTok(p.n)}</span></div>`).join('')}</div>` : '';
    usageBody.innerHTML = tiles + '<div class="usage-chart"><div class="u-tip hidden"></div></div>' + list;
    usageBody.querySelectorAll('[data-series]').forEach(b => b.onclick = () => toggleSeries(b.dataset.series));
    const chart = usageBody.querySelector('.usage-chart');
    if (!total) chart.insertAdjacentHTML('afterbegin', '<div class="usage-empty">No Claude Code tokens in this range.</div>');
    else drawUsageChart(chart, d, series);
  }

  // Stacked bars, one per bucket, in USAGE_SERIES order from the bottom; hover a column for its numbers.
  function drawUsageChart(el, d, series) {
    const W = el.clientWidth || 760, H = 230, L = 52, R = 8, T = 10, B = 24;
    const pw = W - L - R, ph = H - T - B, n = d.buckets.length;
    const peak = Math.max(...d.buckets.map(countOf));
    const step = niceStep(peak / 4);
    const max = step * Math.max(1, Math.ceil(peak / step));
    const y = v => T + ph - v / max * ph;
    const band = pw / n, bw = Math.max(2, band - Math.min(8, Math.max(2, band * 0.28)));
    let svg = `<svg class="u-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      svg += `<line class="u-grid${v ? '' : ' base'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="u-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtTok(v)}</text>`;
    }
    svg += `<rect class="u-hover" x="0" y="${T}" width="${band}" height="${ph}" visibility="hidden"/>`;
    const every = Math.ceil(n / Math.max(2, Math.floor(pw / 90)));
    d.buckets.forEach((b, i) => {
      const x = L + i * band + (band - bw) / 2;
      if ((n - 1 - i) % every === 0) svg += `<text class="u-axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(usageTime(b.t, d.step))}</text>`;
      const segs = series.map(([k]) => [k, b[k]]).filter(s => s[1] > 0);
      let base = 0;
      segs.forEach(([k, v], j) => {
        const y0 = y(base) - (j ? 1 : 0), y1 = y(base + v); // a hairline of surface between stacked segments
        base += v;
        const h = y0 - y1;
        if (h <= 0.4) return;
        if (j < segs.length - 1) return svg += `<rect class="s-${k}" x="${x}" y="${y1}" width="${bw}" height="${h}"/>`;
        const r = Math.min(4, bw / 2, h);
        svg += `<path class="s-${k}" d="M${x} ${y0}V${y1 + r}Q${x} ${y1} ${x + r} ${y1}H${x + bw - r}Q${x + bw} ${y1} ${x + bw} ${y1 + r}V${y0}Z"/>`;
      });
    });
    svg += d.buckets.map((_, i) => `<rect class="u-hit" data-i="${i}" x="${L + i * band}" y="0" width="${band}" height="${T + ph}"/>`).join('') + '</svg>';
    el.insertAdjacentHTML('beforeend', svg);
    const tip = el.querySelector('.u-tip'), hover = el.querySelector('.u-hover');
    const show = i => {
      usageHover = i;
      const b = d.buckets[i];
      if (!b) { tip.classList.add('hidden'); hover.setAttribute('visibility', 'hidden'); return; }
      hover.setAttribute('x', L + i * band); hover.setAttribute('visibility', 'visible');
      tip.innerHTML = `<div class="t-head">${esc(usageTime(b.t, d.step, true))}</div>`
        + [...series].reverse().map(([k, nm]) => `<div class="t-row"><i class="sw s-${k}"></i><span>${nm}</span><b>${fullTok(b[k])}</b></div>`).join('')
        + (series.length > 1 ? `<div class="t-row t-total"><span>Total</span><b>${fullTok(countOf(b))}</b></div>` : '');
      tip.classList.remove('hidden');
      const cx = L + (i + 0.5) * band, tw = tip.offsetWidth;
      tip.style.left = Math.max(0, cx + 14 + tw > W ? cx - 14 - tw : cx + 14) + 'px';
      tip.style.top = T + 'px';
    };
    el.querySelectorAll('.u-hit').forEach(r => r.onmouseenter = () => show(+r.dataset.i));
    el.querySelector('.u-svg').onmouseleave = () => show(-1);
    if (usageHover >= 0) show(usageHover);
  }

  // ------------------------------------------------------------ updates

  const pill = $('#update-pill');
  const version = await operant.version();
  updateStatus = await operant.updateState();
  operant.on('update:status', s => {
    const wasReady = updateStatus?.state === 'ready';
    updateStatus = s;
    if (openPanel() === 'settings' && Panels.settingsTab() === 'Updates') renderSettings();
    pill.classList.toggle('hidden', s.state !== 'downloading' && s.state !== 'ready');
    pill.classList.toggle('ready', s.state === 'ready');
    if (s.state === 'downloading') { pill.textContent = `↓ Downloading v${s.version}…`; pill.title = ''; }
    if (s.state === 'ready') {
      pill.textContent = `↑ Update to v${s.version}`;
      pill.title = `v${version} → v${s.version}. Click to install and restart (or it installs when you quit).\nWhat's new: Settings › Updates`;
      if (!wasReady) toast(`<b>Update ready</b> v${esc(s.version)}. Click the pill in the bar to restart.`);
    }
  });
  pill.onclick = () => { if (pill.classList.contains('ready')) operant.installUpdate(); };

  applyAppearance();
  renderHints();
  refreshBar();
  // Opened from Explorer's "Open in Operant": the master starts in that folder,
  // and later right-clicks (while running) each add a tile of the default agent there.
  const startDir = await operant.startupFolder();
  if (startDir) lastCwd = startDir;
  if (!cfg.agentChosen && cfg.agents.length > 1) {
    togglePanel('launcher');
    welcome = { dir: startDir || cfg.defaultCwd };
    renderLauncher();
  } else if (cfg.masterOnStartup || startDir) newTerminal('ai', startDir || cfg.defaultCwd, { master: true });
  operant.on('open-folder', dir => { lastCwd = dir; newTerminal('ai', dir); });
  // A setting changed in another Operant window.
  operant.on('config:changed', c => {
    Object.assign(cfg, c);
    applyAppearance(); rebuildBinds(); renderHints(); renderMedia(); renderUsagePill(); drawUsage();
    if (openPanel() === 'settings') renderSettings();
    if (openPanel() === 'keys') renderKeys();
  });
})();
