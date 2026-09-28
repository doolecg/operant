// Operant: a Hyprland-style tiler for terminal AI agents (Claude Code, Codex, OpenCode, ...)
// and Claude's subagents.

(async () => {
  const cfg = await operant.config();
  const defaults = await operant.defaults();
  // Installed browsers, for Settings' "Open links in" / "Second browser" selects. Detection touches
  // the registry, so it's fetched once, off the startup path, and Settings redraws if it's open.
  cfg.__browsers = [];
  operant.browsers().then(list => { cfg.__browsers = list; if (openPanel() === 'settings') renderSettings(); });
  const $ = s => document.querySelector(s);
  const desktop = $('#desktop');
  const root = document.documentElement.style;

  const WS_COUNT = 9;
  const workspaces = [];       // { el, hint, tree, focused, fullscreen }
  const wins = new Map();      // id -> win
  const sessionWin = new Map();// Claude Code sessionId -> win (to place its subagents next to it)
  const agentWin = new Map();  // agentId -> win
  const closedAgentInfo = new Map(); // agentId -> info, kept a while so a resumed agent can reopen its tile
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
      ws.hint.innerHTML = `<div class="big">◈</div><div class="headline">What should we build?</div><div>${esc(wsName(i) || `Workspace ${i + 1}`)} is empty</div>
        <div class="row"><span>${k('newAgent')} new ${esc(defaultAgent()?.name || 'agent')}</span><span>${k('pickAgent')} pick an agent…</span>
        <span>${k('newAgentIn')} agent in folder…</span><span>${k('help')} keybinds</span><span>${k('settings')} settings</span></div>
        <div>Claude Code subagents open here in their own tiles as soon as they start.</div>`;
    });
  }

  function switchWorkspace(i) {
    if (i === current || i < 0 || i >= WS_COUNT) return;
    const prev = current;
    workspaces.forEach((w, j) => {
      w.el.classList.toggle('left', j < i);
      w.el.classList.toggle('right', j > i);
    });
    current = i;
    layout(i, true);
    // Only the current workspace's tiles keep a WebGL context: drop the ones we're leaving,
    // pick back up the ones we're arriving at (capped), and redraw so nothing looks stale.
    for (const w of wsWins(prev)) gpu(w);
    for (const w of wsWins(i)) {
      gpu(w);
      if (w.term) try { w.term.refresh(0, w.term.rows - 1); } catch {}
    }
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

  // Tile moves/resizes are FLIP-animated: left/top/width/height land instantly (cheap, no layout
  // thrash from a long-running transition), then a short JS transform animation fakes the motion.
  function flipDuration() {
    const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--anim-flip'));
    return Number.isFinite(v) ? v : 0;
  }
  function flipTile(w, old, r, dur) {
    w.flipAnim?.cancel();
    const dx = old.x - r.x, dy = old.y - r.y, sx = old.w / r.w, sy = old.h / r.h;
    w.el.style.transformOrigin = 'top left';
    w.el.classList.add('flipping');
    w.flipAnim = w.el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
      { duration: dur, easing: 'cubic-bezier(0.05, 0.9, 0.1, 1.05)' });
    const done = () => { w.el.classList.remove('flipping'); w.el.style.transform = ''; scheduleFit(w, 0); };
    w.flipAnim.onfinish = done; w.flipAnim.oncancel = done;
  }

  function layout(i = current, instant = false) {
    const ws = workspaces[i];
    const all = tileRects(i);
    const A = area();
    const animOff = document.body.classList.contains('anim-off');
    const dur = instant || animOff ? 0 : flipDuration();
    for (const [id, r0] of all) {
      const w = wins.get(id);
      const fs = ws.fullscreen === id;
      const r = fs ? A : r0;
      w.el.classList.toggle('fullscreen', fs);
      w.el.classList.toggle('hidden-by-fs', ws.fullscreen != null && !fs);
      const old = w._rect;
      const moved = old && (old.x !== r.x || old.y !== r.y || old.w !== r.w || old.h !== r.h);
      if (!dur || !moved) {
        w.el.classList.add('no-anim');
        Object.assign(w.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        void w.el.offsetWidth;
        w.el.classList.remove('no-anim');
        scheduleFit(w, 0);
      } else {
        Object.assign(w.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        flipTile(w, old, r, dur);
        scheduleFit(w, dur);
      }
      w._rect = r;
    }
    ws.hint.style.opacity = ws.tree ? 0 : 1;
    drawSplitters(i);
    refreshBar();
    updateBorderFlow();
  }

  // Composited-only border flow is costly per running tile, so it's kept off for tiles that can't
  // be seen: another workspace, or agent tiles beyond the first couple visible on this one.
  function updateBorderFlow() {
    let shown = 0;
    for (const w of wins.values()) {
      const onCurrent = w.ws === current;
      let pause = !onCurrent;
      if (onCurrent && w.el.classList.contains('running') && !w.el.classList.contains('hidden-by-fs')) {
        if (++shown > 2) pause = true;
      }
      w.el.classList.toggle('flow-paused', pause);
    }
  }

  // The gaps between tiles are handles: drag one to resize the tiles on either side.
  function drawSplitters(i) {
    const ws = workspaces[i], A = area(), gap = cfg.gapsIn * 2, list = [];
    if (ws.tree && ws.fullscreen == null) {
      if (ws.layout === 'master') {
        if (wsWins(i).length > 1) { const mw = (A.w - gap) * ws.mfact; list.push({ axis: 'h', x: A.x + mw, y: A.y, w: gap, h: A.h, r: A, master: true }); }
      } else {
        const walk = (n, r) => {
          if (!n || n.win) return;
          if (n.split === 'h') {
            const w1 = (r.w - gap) * n.ratio;
            list.push({ axis: 'h', x: r.x + w1, y: r.y, w: gap, h: r.h, r, node: n });
            walk(n.a, { x: r.x, y: r.y, w: w1, h: r.h }); walk(n.b, { x: r.x + w1 + gap, y: r.y, w: r.w - w1 - gap, h: r.h });
          } else {
            const h1 = (r.h - gap) * n.ratio;
            list.push({ axis: 'v', x: r.x, y: r.y + h1, w: r.w, h: gap, r, node: n });
            walk(n.a, { x: r.x, y: r.y, w: r.w, h: h1 }); walk(n.b, { x: r.x, y: r.y + h1 + gap, w: r.w, h: r.h - h1 - gap });
          }
        };
        walk(ws.tree, A);
      }
    }
    const els = [...ws.el.querySelectorAll(':scope > .splitter')];
    list.forEach((s, k) => {
      let el = els[k];
      if (!el) { el = document.createElement('div'); ws.el.appendChild(el); el.addEventListener('mousedown', e => startSplit(e, i, el)); }
      el.className = `splitter ${s.axis}`;
      el.split = s;
      // At least 8px to grab, however small the gap.
      const pad = Math.max(0, (8 - (s.axis === 'h' ? s.w : s.h)) / 2);
      Object.assign(el.style, s.axis === 'h'
        ? { left: s.x - pad + 'px', top: s.y + 'px', width: s.w + 2 * pad + 'px', height: s.h + 'px' }
        : { left: s.x + 'px', top: s.y - pad + 'px', width: s.w + 'px', height: s.h + 2 * pad + 'px' });
    });
    els.slice(list.length).forEach(el => el.remove());
  }
  function startSplit(e, i, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    const ws = workspaces[i], gap = cfg.gapsIn * 2, box = desktop.getBoundingClientRect(), s = el.split;
    document.body.classList.add(s.axis === 'h' ? 'split-h' : 'split-v');
    el.classList.add('drag');
    const move = ev => {
      const x = ev.clientX - box.left, y = ev.clientY - box.top;
      if (s.master) ws.mfact = Math.min(0.85, Math.max(0.2, (x - s.r.x - gap / 2) / (s.r.w - gap)));
      else if (s.axis === 'h') s.node.ratio = Math.min(0.9, Math.max(0.1, (x - s.r.x - gap / 2) / (s.r.w - gap)));
      else s.node.ratio = Math.min(0.9, Math.max(0.1, (y - s.r.y - gap / 2) / (s.r.h - gap)));
      layout(i, true);
    };
    const up = () => {
      document.body.classList.remove('split-h', 'split-v');
      el.classList.remove('drag');
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      focusKeys(focused());
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  function scheduleFit(w, delay) {
    clearTimeout(w.fitTimer);
    w.fitTimer = setTimeout(() => {
      if (!w.alive) return;
      if (w.term) { try { w.fit.fit(); } catch {} if (w.ptyId) operant.resizePty(w.ptyId, w.term.cols, w.term.rows); }
      else if (w.kind === 'view' && w.image && w.imgFit) drawImgSize(w);
      if (w.kind === 'ai') layoutIbar(w);
    }, delay);
  }

  // ------------------------------------------------------------- windows

  // Paths dropped from Explorer (real files) or dragged from the sidebar (text/plain).
  function pathsFromDrop(e) {
    const paths = [...e.dataTransfer.files].map(f => { try { return operant.pathForFile(f); } catch { return null; } }).filter(Boolean);
    if (!paths.length) { const t = e.dataTransfer.getData('text/plain'); if (t) paths.push(t); }
    return paths;
  }
  // Dropping files onto empty desktop (not onto a tile) opens each one in its own viewer.
  desktop.addEventListener('dragover', e => { if (!e.target.closest('.win')) e.preventDefault(); });
  desktop.addEventListener('drop', async e => {
    if (e.target.closest('.win')) return;
    e.preventDefault();
    for (const p of pathsFromDrop(e)) if (!(await operant.isDir(p))) openFile(p, 'view');
  });

  function makeWin(kind, title, icon) {
    const id = nextId++;
    const el = document.createElement('div');
    el.className = `win ${kind} opening`;
    el.innerHTML = `<div class="inner"><div class="tbar"><span class="ico">${esc(icon || (kind === 'agent' ? '◆' : '❯'))}</span>
      <span class="title"></span><span class="waiting"></span><span class="badge"></span><span class="runaway"></span><button class="x" title="Close">✕</button></div><div class="ibar"><span class="ib-model"></span><span class="ib-ctx"><i class="ib-bar"><b></b></i><span class="ib-ctxtxt"></span></span><span class="ib-tok"></span><span class="ib-cache"></span><span class="ib-sp"></span><span class="ib-folder"></span><span class="ib-branch"></span></div><div class="term"></div></div>`;
    const term = new Terminal({
      ...termOptions(kind), allowTransparency: true,
      disableStdin: kind === 'agent', cursorInactiveStyle: 'none', allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const w = { id, kind, el, term, fit, title, alive: true, ws: current, lastActivity: Date.now(), closeIn: null };
    el.querySelector('.title').textContent = title;
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); requestClose(w); });
    el.querySelector('.runaway').addEventListener('click', e => { e.stopPropagation(); stopTile(w); });
    el.addEventListener('mousedown', e => onWinMouseDown(e, w), true);
    term.attachCustomKeyEventHandler(e => handleTermKey(e, w));
    // Copy on select: copies once when the drag ends, not on every selection tick.
    let hasSel = false;
    term.onSelectionChange(() => { hasSel = term.hasSelection(); });
    el.querySelector('.term').addEventListener('mouseup', () => {
      if (cfg.copyOnSelect && hasSel) { navigator.clipboard.writeText(term.getSelection()); toastCopied(); }
    });
    // Dropping files (from Explorer or the sidebar) types their paths into this tile, space-separated.
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (!w.ptyId) return;
      const paths = pathsFromDrop(e);
      if (!paths.length) return;
      operant.writePty(w.ptyId, paths.map(p => /\s/.test(p) ? `"${p}"` : p).join(' '));
    });
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
    document.body.className = `wp-${cfg.wallpaper} border-${cfg.borderAnimation} anim-${cfg.animations}`;
    applySidebar();
    for (const w of wins.values()) if (w.term) Object.assign(w.term.options, termOptions(w.kind));
    workspaces.forEach((_, i) => layout(i, i !== current));
  }

  function mount(w, wsIndex, target, { focus = true } = {}) {
    insert(w, wsIndex, target);
    if (w.term) { w.term.open(w.el.querySelector('.term')); gpu(w); }
    w.term?.textarea?.addEventListener('focus', () => { if (workspaces[w.ws].focused !== w.id) focusWin(w, false); });
    // Keys never fall into nothing: if the focused tile loses the keyboard to no other control
    // (a tile closing, a redraw, a click on empty space), it takes it straight back.
    w.term?.textarea?.addEventListener('blur', e => {
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
    try { w.fit?.fit(); } catch {}
  }

  // Agents retitle their tiles many times a second while working, so only the title itself is redrawn.
  // Settings › Terminal › GPU-accelerated terminals: WebGL drawing. A tile whose context is lost (the GPU
  // reset, or too many tiles for the browser's limit) goes back to the normal renderer.
  const liveGlCount = () => { let n = 0; for (const x of wins.values()) if (x.gl) n++; return n; };
  function gpu(w) {
    if (!w.term || !w.alive) return;
    // Without hardware acceleration WebGL runs in software, slower than the normal renderer.
    // Only the current workspace's tiles hold a context (switchWorkspace disposes/reattaches
    // as you switch), and at most 12 are live at once; the rest stay on the normal renderer.
    const want = cfg.gpuTerminals && cfg.hardwareAcceleration && typeof WebglAddon !== 'undefined' && w.ws === current;
    if (!want && w.gl) { try { w.gl.dispose(); } catch {} w.gl = null; }
    if (!want || w.gl || w.glLost || liveGlCount() >= 12) return;
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => { try { gl.dispose(); } catch {} if (w.gl === gl) { w.gl = null; w.glLost = true; } });
      w.term.loadAddon(gl);
      w.gl = gl;
    } catch { w.gl = null; }
  }

  function setTitle(w, t) {
    if (w.title === t) return;
    w.title = t; w.el.querySelector('.title').textContent = t;
    if (focused() === w) drawBarTitle();
  }
  function setBadge(w, html) { w.el.querySelector('.badge').innerHTML = html; }

  const defaultAgent = () => cfg.agents.find(a => a.id === cfg.defaultAgent) || cfg.agents[0];
  // Settings › Projects: what tiles opened in a project start with (the innermost project, if they nest).
  function projectDefaults(dir) {
    const d = cfg.projectDefaults || {};
    const k = Object.keys(d).filter(p => dir && isUnder(dir, p)).sort((a, b) => b.length - a.length)[0];
    return (k && d[k]) || {};
  }

  // kind: 'ai' (an agent CLI from cfg.agents) or 'shell'.
  // resume: a Claude session id to continue; ws/focus: where a restored tile goes, without taking focus.
  async function newTerminal(kind, cwd, { master = false, agentId, run, title, resume, ws = current, focus = true, edit, icon, near = null, prompt, model, effort, worker } = {}) {
    agentId ??= projectDefaults(cwd || lastCwd).agent || cfg.defaultAgent;
    const agent = kind === 'ai' ? cfg.agents.find(a => a.id === agentId) || defaultAgent() : null;
    if (kind === 'ai' && !agent) { toast('No agents set up. Add one in Settings › Agents.'); return; }
    const name = title || (agent ? agent.name : 'Shell');
    const w = makeWin(kind, name, icon || agent?.icon || '●');
    Object.assign(w, { agentName: name, agentConf: agent?.id, customTitle: title, run, edit });
    if (edit && /vim/i.test(editorName || '')) w.el.querySelector('.inner').insertAdjacentHTML('beforeend', VIM_KEYS);
    if (master) { w.master = true; w.el.classList.add('master'); }
    mount(w, ws, near, { focus });
    const info = await operant.createPty({ kind, agentId: agent?.id, cwd: cwd || lastCwd, cols: w.term.cols, rows: w.term.rows, run, resume, edit, tileId: w.id, prompt, model, effort, worker });
    w.ptyId = info.id;
    w.sessionId = info.sessionId;
    w.cwd = info.cwd;
    if (info.sessionId) sessionWin.set(info.sessionId, w);
    updateBadge(w);
    setTitle(w, name);
    ptyWins.set(info.id, w);
    w.term.onData(d => { touch(w); w.lastInput = lastKey = Date.now(); w.typed = true; w.busySince = null; operant.writePty(info.id, d); });
    // The shell sets its own path as the title; only keep titles the agent sets. Vim's title ends in [+]
    // while the file has unsaved changes (main sets its titlestring).
    w.term.onTitleChange(t => {
      if (edit) {
        if (!t || /\.exe$/i.test(t.trim())) return;
        w.tracksDirty = true;
        const dirty = /\[\+\]\s*$/.test(t);
        if (dirty !== w.dirty) { w.dirty = dirty; setTitle(w, name + (dirty ? ' ●' : '')); }
        return;
      }
      if (t && !/\.exe$/i.test(t.trim())) setTitle(w, t);
    });
    w.term.onBell(() => { if (kind === 'ai') notify(w, `${name} needs your attention`, shortPath(w.cwd || '')); });
    scheduleFit(w, 50);
    saveSession();
    return w;
  }

  // ------------------------------------------------------------- files
  // A file in the editor tile (vim or whatever Settings › Files picks; the tile closes when you quit
  // it), or in the viewer tile: Markdown rendered, other text with line numbers, reloaded when it changes.

  let editorName = null;
  let editorReady = null;
  const refreshEditorName = () => (editorReady = operant.editorName().then(n => { editorName = n; }));
  refreshEditorName();
  const dirOf = p => String(p).replace(/[\\/][^\\/]*$/, '');
  const isMarkdown = p => /\.(md|markdown|mdx|mdown)$/i.test(p);
  const isImageFile = p => /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i.test(p);

  // Vim shows no help of its own, so its tiles get the essentials along the bottom.
  const VIM_KEYS = '<div class="keys-foot">' + [['i', 'insert'], ['Esc', 'stop inserting'], [':w', 'save'], [':q', 'quit'], [':wq', 'save + quit'],
    [':q!', 'quit, no save'], ['u', 'undo'], ['Ctrl+R', 'redo'], ['/text', 'find'], ['n', 'next'], ['dd', 'cut line'], ['yy', 'copy line'], ['p', 'paste'],
    ['gg / G', 'top / end']].map(([k, d]) => `<span><kbd>${k}</kbd>${d}</span>`).join('') + '</div>';

  async function openEditor(file, { ws = current, focus = true, near = null } = {}) {
    await editorReady;
    return newTerminal('shell', dirOf(file), { edit: file, title: `${editorName || 'Editor'} · ${baseName(file)}`, icon: '✎', ws, focus, near });
  }

  // Keys that save and quit each editor, for "Save and close". Vim's title tells Operant when its file
  // has unsaved changes; with other editors, typing in the tile counts.
  const SAVE_QUIT = { vim: '\x1b:wq\r', nvim: '\x1b:wq\r', nano: '\x0f\r\x18', micro: '\x13\x11', edit: '\x13\x11' };
  // Save without quitting, for "Save and quit" (the tile itself stays open and reopens next start).
  const SAVE_ONLY = { vim: '\x1b:wa\r', nvim: '\x1b:wa\r', nano: '\x0f\r', micro: '\x13', edit: '\x13' };
  async function requestClose(w) {
    if (!w?.alive) return;
    if (w.edit && w.ptyId && (w.tracksDirty ? w.dirty : w.typed)) {
      const keys = cfg.editor === 'custom' ? null : SAVE_QUIT[String(editorName || '').toLowerCase()];
      const buttons = keys ? ['Save and close', 'Discard', 'Cancel'] : ['Discard and close', 'Cancel'];
      const r = await operant.ask({
        message: w.tracksDirty ? `${baseName(w.edit)} has unsaved changes` : `${baseName(w.edit)} may have unsaved changes`,
        detail: w.tracksDirty ? 'Closing the tile ends the editor.' : 'You typed in this editor. Closing the tile ends it without saving.',
        buttons, cancelId: buttons.length - 1,
      });
      if (!w.alive || r === buttons.length - 1) return;
      // The tile closes by itself when the editor quits; if saving fails, the editor stays open to say why.
      if (keys && r === 0) { operant.writePty(w.ptyId, keys); return; }
    }
    closeWin(w);
  }

  // "Save and quit": save every dirty editor tile in place (no quitting them), snapshot the
  // session right now, and tell main to close everything and reopen it all next start.
  async function doSaveQuit() {
    toast('Saving…', null, 4000);
    const dirty = [...wins.values()].filter(w => w.edit && w.ptyId && (w.tracksDirty ? w.dirty : w.typed));
    const keys = cfg.editor === 'custom' ? null : SAVE_ONLY[String(editorName || '').toLowerCase()];
    if (dirty.length && keys) {
      for (const w of dirty) operant.writePty(w.ptyId, keys);
      await new Promise(r => setTimeout(r, 600));
    }
    saveSessionNow();
    operant.saveAndQuit();
  }

  // Working agent tiles that Save and quit should wait for: busy 'ai' tiles, plus the parent
  // of any running subagent ('agent') tile (subagents have no terminal of their own to warn).
  function busyAgentTiles() {
    const set = new Map();
    for (const w of wins.values()) {
      if (w.kind === 'ai' && aiWorking(w)) set.set(w.id, w);
      else if (w.kind === 'agent' && w.status === 'running') {
        const parent = sessionWin.get(w.sessionId);
        if (parent) set.set(parent.id, parent);
      }
    }
    return [...set.values()];
  }

  const SAVE_QUIT_MSG = "Operant is closing. Finish your current step (don't start anything new), then write a "
    + 'short progress note to .operant/progress.md in the project (what\'s done, what\'s next, open questions), then stop.';
  let sq = null; // { ids, idleSince, timer } while the "saving and quitting" overlay is up
  async function saveAndQuit() {
    const busy = cfg.saveQuitWaits ? busyAgentTiles() : [];
    if (!busy.length) return doSaveQuit();
    for (const w of busy) if (w.ptyId) sendLine(w, SAVE_QUIT_MSG);
    sq = { ids: busy.map(w => w.id), idleSince: new Map() };
    $('#savequit').classList.remove('hidden');
    renderSaveQuit();
    sq.timer = setInterval(tickSaveQuit, 1000);
  }
  function tickSaveQuit() {
    const now = Date.now();
    for (const id of sq.ids) {
      const w = wins.get(id);
      if (w && w.alive && isWorking(w)) sq.idleSince.delete(id);
      else if (!sq.idleSince.has(id)) sq.idleSince.set(id, now);
    }
    renderSaveQuit();
    if (sq.ids.every(id => now - (sq.idleSince.get(id) ?? now) >= 3000)) forceSaveQuit();
  }
  function renderSaveQuit() {
    $('#savequit-body').innerHTML = sq.ids.map(id => {
      const w = wins.get(id);
      const done = !w || !w.alive || sq.idleSince.has(id);
      return `<div class="sq-row">${done ? '✓' : '…'} ${esc(w ? w.title : 'closed tile')}</div>`;
    }).join('');
  }
  function endSaveQuitOverlay() {
    if (sq) clearInterval(sq.timer);
    sq = null;
    $('#savequit').classList.add('hidden');
  }
  function cancelSaveQuit() { endSaveQuitOverlay(); }
  function forceSaveQuit() { endSaveQuitOverlay(); doSaveQuit(); }
  $('#sq-force').onclick = forceSaveQuit;
  $('#sq-cancel').onclick = cancelSaveQuit;

  // ------------------------------------------------------------ auto compact
  // When an agent tile's context passes cfg.autoCompact percent, wait until it's idle (like Save
  // and quit), ask it to write .operant/progress.md, wait idle again, then compact it: /compact for
  // Claude Code, OpenCode's own summarize API (falling back to /compact) for OpenCode. Fires once per
  // crossing — context has to drop back under the threshold before it can fire again — and never
  // touches a tile Save and quit is already handling. `operant compact` queues the same sequence
  // directly for the tile that asked, skipping the threshold.
  const COMPACT_MSG = "Before compacting: write a short progress note to .operant/progress.md in the "
    + "project (what's done, what's next, open questions), then stop.";
  const compacting = new Map(); // tile id -> { stage, idleSince, sentAt, seenActivity }
  const pctOf = w => w.ctx && w.ctx.max ? w.ctx.tokens / w.ctx.max : 0;

  function queueCompact(w) {
    if (!w.alive || !w.ptyId || compacting.has(w.id)) return;
    compacting.set(w.id, { stage: 'wait', idleSince: null });
  }

  // A long or multi-line paste, sent as one write with a trailing \r, can land in Claude Code's
  // input box as a draft rather than submitting: its TUI treats a big burst of characters as a
  // paste and doesn't read \r inside it as Enter. Typing the message, then Enter as its own write
  // a moment later, submits it the way a person pasting text and then pressing Enter would.
  function sendLine(w, text) {
    operant.writePty(w.ptyId, text);
    setTimeout(() => { if (w.alive && w.ptyId) operant.writePty(w.ptyId, '\r'); }, 150);
  }

  async function runCompact(w) {
    if (!w.alive || !w.ptyId) return;
    if (String(w.sessionId || '').startsWith('oc:')) {
      const r = await operant.summarizeOpenCode(w.ptyId).catch(() => null);
      if (r && r.ok) return;
    }
    sendLine(w, '/compact');
  }

  // A tile that was never typed into by hand (e.g. started with `operant agent`) never sets
  // w.typed, so isWorking() can't see it working and looks "idle" the instant we write to it.
  // Once the note request is sent, wait for real output after that (w.lastActivity moving past
  // sentAt) rather than trusting isWorking() alone — otherwise the /compact that follows can land
  // on top of a still-open, unsubmitted prompt and get typed into the same message as the note.
  function tickCompacting() {
    const now = Date.now();
    for (const [id, st] of [...compacting]) {
      const w = wins.get(id);
      if (!w || !w.alive || !w.ptyId) { compacting.delete(id); continue; }
      if (sq && sq.ids.includes(id)) continue; // Save and quit is already talking to this tile
      if (st.stage === 'wait') {
        if (isWorking(w)) { st.idleSince = null; continue; }
        if (st.idleSince == null) { st.idleSince = now; continue; }
        if (now - st.idleSince < 3000) continue;
        sendLine(w, COMPACT_MSG);
        Object.assign(st, { stage: 'note-sent', sentAt: now, seenActivity: false, idleSince: null });
      } else if (st.stage === 'note-sent') {
        if (w.lastActivity > st.sentAt) st.seenActivity = true;
        const settled = st.seenActivity && now - w.lastActivity >= 3000;
        if (settled || now - st.sentAt > 120000) { // give up waiting after 2 minutes and compact anyway
          compacting.delete(id);
          runCompact(w);
        }
      }
    }
  }

  function checkAutoCompact() {
    const threshold = (cfg.autoCompact || 0) / 100;
    if (threshold > 0) {
      for (const w of wins.values()) {
        if (w.kind !== 'ai' || !w.alive || !w.ptyId || !w.ctx || !w.ctx.max) continue;
        const above = pctOf(w) >= threshold;
        if (above && !w.compactAbove && !(sq && sq.ids.includes(w.id))) queueCompact(w);
        w.compactAbove = above;
      }
    }
    tickCompacting();
    tickCacheState();
  }
  setInterval(checkAutoCompact, 1000);

  // ------------------------------------------------------------ prompt cache
  // Claude's prompt cache expires after cfg.cacheTtlMinutes of no activity (default 5); a tile's
  // next message after that re-reads its whole context at full price. Mark an idle Claude Code
  // tile's info bar "cache cold" once past the TTL, warn with a countdown in the minute before,
  // and (cfg.compactBeforeCold) auto-compact a big, unfocused context shortly before it goes cold,
  // reusing queueCompact above.
  function cacheState(w) {
    if (w.kind !== 'ai' || !w.alive || !w.ctx || !w.ctx.max || !w.lastOut || isWorking(w) || !isClaudeTile(w)) return null;
    const ttlMs = (cfg.cacheTtlMinutes || 5) * 60000;
    const remaining = ttlMs - (Date.now() - w.lastOut);
    if (remaining <= 0) return { cold: true, remaining };
    if (remaining <= 60000 && w.ctx.tokens > 50000) return { cold: false, remaining };
    return null;
  }
  function tickCacheState() {
    for (const w of wins.values()) {
      if (w.kind !== 'ai' || !w.alive) continue;
      const el = w.el.querySelector('.ib-cache');
      if (!el) continue;
      const st = cacheState(w);
      let text = '', title = '';
      if (st && st.cold) {
        text = 'cache cold';
        title = `Idle longer than the prompt cache lasts: the next message re-reads the whole context `
          + `(~${fmtTok(w.ctx.tokens)} tokens at full price). Compacting first makes it cheaper.`;
      } else if (st) {
        const s = Math.max(0, Math.round(st.remaining / 1000));
        text = `cache warm · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        title = 'The prompt cache is about to expire; compacting now keeps this session cheap.';
      }
      if (el.textContent !== text) el.textContent = text;
      if (el.title !== title) el.title = title;
      if (st) el.classList.toggle('cold', !!st.cold); else el.classList.remove('cold');
      if (st && !st.cold && cfg.compactBeforeCold && w.ctx.tokens > 50000 && st.remaining <= 30000) {
        const isFocused = w.ws === current && workspaces[w.ws].focused === w.id;
        if (!isFocused) queueCompact(w);
      }
    }
  }

  const FIND_BAR = '<div class="find-bar hidden"><input placeholder="Find" spellcheck="false"><span class="find-n"></span>'
    + '<button data-f="prev" title="Previous (Shift+Enter)">↑</button><button data-f="next" title="Next (Enter)">↓</button><button data-f="close" title="Close (Esc)">✕</button></div>';

  function openViewer(file, { ws = current, focus = true, near = null } = {}) {
    const id = nextId++;
    const el = document.createElement('div');
    el.className = 'win view opening';
    el.innerHTML = `<div class="inner"><div class="tbar"><span class="ico">▤</span><span class="title"></span><span class="badge"></span>
      <span class="view-acts"><button data-v="source" title="Show the Markdown source">Source</button><button data-v="edit" title="Edit">✎</button>
      <button data-v="open" title="Open with Windows">↗</button></span><button class="x" title="Close">✕</button></div>
      <div class="plan-bar hidden"><span class="plan-msg">Review this plan</span><span class="plan-actions">
        <button class="btn primary" data-p="approve">Approve</button><button class="btn" data-p="change">Change</button></span>
        <div class="plan-change hidden"><input class="plan-note" type="text" placeholder="What should change?">
        <button class="btn primary" data-p="send">Send</button></div></div>
      <div class="view-wrap"><div class="view-page" tabindex="-1"><div class="view-body"></div></div>${FIND_BAR}</div></div>`;
    const w = { id, kind: 'view', el, term: null, file, title: baseName(file), alive: true, ws, lastActivity: Date.now(), closeIn: null,
      cwd: dirOf(file), page: el.querySelector('.view-page'), source: false, mtime: null, planQueue: [] };
    el.querySelector('.title').textContent = w.title;
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); requestClose(w); });
    el.addEventListener('mousedown', e => onWinMouseDown(e, w), true);
    el.querySelector('.view-acts').addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      if (b.dataset.v === 'source') { w.source = !w.source; drawView(w); }
      else if (b.dataset.v === 'edit') openEditor(w.file, { ws: w.ws });
      else operant.openPath(w.file);
    });
    const planBar = el.querySelector('.plan-bar'), planNote = el.querySelector('.plan-note');
    planBar.querySelector('[data-p="approve"]').onclick = () => resolvePlan(w, true, null);
    planBar.querySelector('[data-p="change"]').onclick = () => { planBar.querySelector('.plan-change').classList.remove('hidden'); planNote.focus(); };
    planBar.querySelector('[data-p="send"]').onclick = () => resolvePlan(w, false, planNote.value.trim());
    planNote.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); planBar.querySelector('[data-p="send"]').click(); } });
    w.page.addEventListener('click', e => {
      const a = e.target.closest('[data-href]');
      if (!a) return;
      e.preventDefault();
      const href = a.dataset.href;
      if (/^https?:\/\//i.test(href)) return operant.openLink(href, e.shiftKey);
      if (href.startsWith('#')) return w.page.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ behavior: 'smooth' });
      const target = resolvePath(dirOf(w.file), decodeURIComponent(href.split('#')[0]));
      showFile(w, target);
    });
    // Dropping a file (from Explorer or the sidebar) replaces this tile's file, like clicking a link to it.
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', e => {
      e.preventDefault();
      const target = pathsFromDrop(e)[0];
      if (target) showFile(w, target);
    });
    // Image viewer: click toggles fit/actual size, double-click resets to fit, drag pans when zoomed in.
    w.page.addEventListener('mousedown', e => {
      const img = e.target.closest('.view-img img');
      if (!img || e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, sl = w.page.scrollLeft, st = w.page.scrollTop;
      let moved = false;
      const move = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { moved = true; img.closest('.view-img').classList.add('dragging'); }
        if (moved) { w.page.scrollLeft = sl - dx; w.page.scrollTop = st - dy; }
      };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        img.closest('.view-img')?.classList.remove('dragging');
        if (!moved) toggleImgFit(w);
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    w.page.addEventListener('dblclick', e => { if (e.target.closest('.view-img img')) { w.imgFit = true; drawImgSize(w); } });
    w.page.addEventListener('mouseup', () => copySelection(w));
    w.page.addEventListener('wheel', e => {
      if (!e.ctrlKey || !w.image) return;
      const img = w.el.querySelector('.view-img img');
      if (!img || !img.naturalWidth) return;
      e.preventDefault();
      setImgZoom(w, imgPct(w, img) * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
    findBar(w);
    wins.set(id, w);
    mount(w, ws, near, { focus });
    updateBadge(w);
    operant.watchFile(w.id, w.file);
    loadView(w);
    saveSession();
    return w;
  }

  function resolvePath(dir, rel) {
    if (/^[a-z]:[\\/]/i.test(rel) || rel.startsWith('\\\\')) return rel;
    const parts = dir.split(/[\\/]/);
    for (const seg of rel.split(/[\\/]/)) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    return parts.join('\\');
  }

  // Swap a viewer tile to another file (a link, or a drop), like reopening it fresh.
  function showFile(w, target) {
    operant.isDir(target).then(d => {
      if (d || !w.alive) return;
      w.file = target; w.cwd = dirOf(target); setTitle(w, baseName(target)); updateBadge(w); w.page.scrollTop = 0;
      operant.watchFile(w.id, w.file); loadView(w); saveSession();
    });
  }

  // Plan approval bar on a viewer tile: `operant plan` queues a resolver per pending request
  // (usually just one) and shows the bar; Approve/Change/Send (or the tile closing) resolves the
  // oldest one and moves on to the next queued request, if any.
  function showPlanBar(w) {
    if (!w.alive) return;
    const bar = w.el.querySelector('.plan-bar');
    bar.querySelector('.plan-change').classList.add('hidden');
    bar.querySelector('.plan-note').value = '';
    bar.classList.remove('hidden');
  }
  function resolvePlan(w, approved, note) {
    const resolve = w.planQueue?.shift();
    if (!resolve) return;
    resolve({ approved, note: approved ? null : (note || '') });
    if (w.planQueue.length) showPlanBar(w);
    else w.el.querySelector('.plan-bar').classList.add('hidden');
  }

  async function loadView(w) {
    const r = await operant.readFile(w.file);
    if (!w.alive) return;
    Object.assign(w, { mtime: r.mtime ?? null, text: r.text, image: r.image, size: r.size, error: r.error });
    drawView(w);
  }

  const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes';
  // Image viewer sizing: "fit" scales down to the tile (never up past 100%); otherwise imgZoom (10-800%) applies.
  function fitPct(w, img) {
    const cw = w.page.clientWidth - 48, ch = w.page.clientHeight - 48;
    if (!img.naturalWidth || cw <= 0 || ch <= 0) return 100;
    return Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1) * 100;
  }
  const imgPct = (w, img) => w.imgFit ? fitPct(w, img) : (w.imgZoom || 100);
  function drawImgSize(w) {
    const img = w.el.querySelector('.view-img img'), wrap = w.el.querySelector('.view-img'), cap = w.el.querySelector('.view-cap');
    if (!img || !wrap || !img.naturalWidth) return;
    const pct = imgPct(w, img);
    img.style.width = (img.naturalWidth * pct / 100) + 'px';
    wrap.classList.toggle('pannable', img.naturalWidth * pct / 100 > w.page.clientWidth + .5 || img.naturalHeight * pct / 100 > w.page.clientHeight + .5);
    if (cap) cap.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${fmtBytes(w.size || 0)} · ${Math.round(pct)}%`;
  }
  function setImgZoom(w, pct, clientX, clientY) {
    const img = w.el.querySelector('.view-img img');
    if (!img || !img.naturalWidth) return;
    pct = Math.max(10, Math.min(800, pct));
    const before = img.getBoundingClientRect();
    w.imgFit = false; w.imgZoom = pct;
    drawImgSize(w);
    if (clientX == null || !before.width) return;
    const after = img.getBoundingClientRect(), fx = (clientX - before.left) / before.width, fy = (clientY - before.top) / before.height;
    w.page.scrollLeft += (after.left + fx * after.width) - clientX;
    w.page.scrollTop += (after.top + fy * after.height) - clientY;
  }
  function toggleImgFit(w) {
    w.imgFit = !w.imgFit;
    if (!w.imgFit) w.imgZoom = 100;
    drawImgSize(w);
  }
  function drawView(w) {
    const body = w.el.querySelector('.view-body'), md = isMarkdown(w.file) && !w.source, top = w.page.scrollTop, left = w.page.scrollLeft;
    const btn = w.el.querySelector('[data-v="source"]');
    btn.hidden = !isMarkdown(w.file);
    btn.textContent = w.source ? 'Rendered' : 'Source';
    btn.title = w.source ? 'Show it rendered' : 'Show the Markdown source';
    w.el.querySelector('[data-v="edit"]').hidden = !!w.image;
    w.el.classList.toggle('md', md);
    if (w.error) body.innerHTML = `<div class="view-msg">${esc(w.error)}<br><button class="btn" data-v2="open">Open with Windows</button></div>`;
    else if (w.image) {
      body.innerHTML = `<div class="view-img"><img alt="" draggable="false"><div class="view-cap"></div></div>`;
      const img = body.querySelector('img');
      if (w.imgFit === undefined) w.imgFit = true;
      img.onload = () => drawImgSize(w);
      img.src = w.image;
    } else if (md) {
      body.innerHTML = `<article class="md-doc">${MdView.render(w.text)}</article>`;
      body.querySelectorAll('pre.md-code[data-lang]').forEach(pre => {
        const l = Highlight.lang(pre.dataset.lang);
        if (l) pre.firstChild.innerHTML = Highlight.lines(pre.textContent, l).join('\n');
      });
      // Inline local images: resolve against the doc's folder and load as data URLs (remote ones stayed links).
      body.querySelectorAll('img.md-inline-img').forEach(img => {
        const target = resolvePath(dirOf(w.file), img.dataset.src);
        img.addEventListener('click', () => openViewer(target));
        operant.readFile(target).then(r => {
          if (!w.alive) return;
          if (r.image) { img.src = r.image; img.classList.add('loaded'); }
          else { const s = document.createElement('span'); s.className = 'md-img-broken'; s.textContent = `🖼 ${img.alt || img.dataset.src}`; img.replaceWith(s); }
        }).catch(() => {});
      });
    } else {
      // Rendered as 200-line chunks (each its own content-visibility:auto pre) so a huge file only
      // lays out and paints the chunks near the viewport. Highlighting all of a very long file is
      // itself expensive, so past 20,000 lines it's shown as plain escaped text instead.
      const lines = w.text.split('\n'), shown = lines.slice(0, 100000);
      const l = shown.length <= 20000 && w.text.length < 3e6 && Highlight.lang(w.file);
      let chunks = '';
      for (let i = 0; i < shown.length; i += 200) {
        const part = shown.slice(i, i + 200);
        const html = l ? Highlight.lines(part.join('\n'), l) : part.map(x => esc(x.replace(/\r$/, '')));
        chunks += `<pre class="src-chunk">${html.map((x, k) => `<span class="ln">${i + k + 1}</span>${x}`).join('\n')}</pre>`;
      }
      body.innerHTML = `<div class="view-src">${chunks}</div>`
        + (lines.length > shown.length ? `<div class="view-msg">Showing the first ${shown.length.toLocaleString()} of ${lines.length.toLocaleString()} lines</div>` : '');
    }
    body.querySelector('[data-v2="open"]')?.addEventListener('click', () => operant.openPath(w.file));
    w.page.scrollTop = top; w.page.scrollLeft = left;
    if (w.find?.q) runFind(w, true);
  }

  // Viewers follow their file as it changes (an agent writing it, or the editor tile saving it): main
  // watches the file's folder and says when it changed.
  operant.on('fs:changed', key => { const w = wins.get(Number(key)); if (w?.alive && w.kind === 'view') loadView(w); });

  // ------------------------------------------------------------- find in page
  // Ctrl+F in a viewer or diff tile: every match marked, Enter and Shift+Enter step through them.

  function findBar(w) {
    const bar = w.el.querySelector('.find-bar'), input = bar.querySelector('input');
    w.find = { bar, input, q: '', k: 0, n: 0 };
    input.addEventListener('input', () => { w.find.q = input.value; w.find.k = 0; runFind(w); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(w, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(w); }
    });
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      if (b.dataset.f === 'close') closeFind(w); else stepFind(w, b.dataset.f === 'prev' ? -1 : 1);
    });
  }
  function openFind(w) {
    if (!w?.find) return;
    w.find.bar.classList.remove('hidden');
    w.find.input.focus(); w.find.input.select();
    if (w.find.input.value) { w.find.q = w.find.input.value; runFind(w, true); }
  }
  function closeFind(w) {
    w.find.bar.classList.add('hidden');
    w.find.q = '';
    clearMarks(w);
    focusKeys(w);
  }
  const findRoot = w => w.el.querySelector(w.kind === 'diff' ? '.diff-body' : '.view-body');
  function clearMarks(w) {
    const root = findRoot(w);
    const marks = root.querySelectorAll('mark.hit');
    if (!marks.length) return;
    marks.forEach(m => m.replaceWith(...m.childNodes));
    root.normalize();
  }
  function runFind(w, keepPlace = false) {
    clearMarks(w);
    const f = w.find, q = f.q.toLowerCase(), root = findRoot(w);
    f.n = 0;
    if (q) {
      // Matches can span elements (a highlighted keyword and the bracket after it), so the text nodes are
      // searched as one string and each node wraps its own share of each match.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT,
        { acceptNode: n => n.parentElement.closest('.ln, .dl-n') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodes = [];
      let text = '';
      for (let n; (n = walker.nextNode());) { nodes.push([n, text.length]); text += n.data; }
      const low = text.toLowerCase(), hits = [];
      for (let i = low.indexOf(q); i >= 0 && hits.length < 5000; i = low.indexOf(q, i + q.length)) hits.push(i);
      f.n = hits.length;
      let m0 = 0;
      for (const [node, start] of nodes) {
        const end = start + node.data.length;
        while (m0 < hits.length && hits[m0] + q.length <= start) m0++;
        const segs = [];
        for (let m = m0; m < hits.length && hits[m] < end; m++) segs.push([Math.max(hits[m], start) - start, Math.min(hits[m] + q.length, end) - start, m]);
        for (const [a, b, m] of segs.reverse()) {
          const mid = node.splitText(a);
          mid.splitText(b - a);
          const mark = document.createElement('mark');
          mark.className = 'hit'; mark.dataset.m = m;
          mid.replaceWith(mark); mark.appendChild(mid);
        }
      }
    }
    if (!keepPlace || f.k >= f.n) f.k = 0;
    showFind(w, !keepPlace);
  }
  function stepFind(w, d) {
    const f = w.find;
    if (!f.n) return;
    f.k = (f.k + d + f.n) % f.n;
    showFind(w, true);
  }
  function showFind(w, scroll) {
    const f = w.find, root = findRoot(w);
    root.querySelectorAll('mark.hit.cur').forEach(m => m.classList.remove('cur'));
    const cur = root.querySelectorAll(`mark.hit[data-m="${f.k}"]`);
    cur.forEach(m => m.classList.add('cur'));
    if (scroll) cur[0]?.scrollIntoView({ block: 'center', inline: 'nearest' });
    f.bar.querySelector('.find-n').textContent = !f.q ? '' : f.n ? `${f.k + 1} of ${f.n}${f.n >= 5000 ? '+' : ''}` : 'No matches';
  }

  // ------------------------------------------------------------- browser tile
  // An in-app browser (<webview>, its own session, no Node/preload). Back/forward/reload/stop,
  // a URL bar, DevTools, and opening the page in the system browser. Console messages are kept
  // (last 500) for the control API; Alt/Ctrl keybinds are forwarded from main (see browser:key
  // below) since the guest's keyboard never reaches this page.

  const LEVEL_NAME = ['verbose', 'info', 'warning', 'error'];
  const browserConsoleCursors = new Map(); // cursorKey(caller, tile) -> console entries already read, for `console --new`
  function normalizeUrl(u) {
    u = String(u || '').trim();
    if (!u) return 'about:blank';
    // A scheme needs "//" after it (http://, file://…) or it's just a bare host:port (localhost:3000).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u === 'about:blank') return u;
    return 'http://' + u;
  }
  function urlHost(u) { try { return new URL(u).host; } catch { return ''; } }
  function drawBrowserBar(w) {
    const reload = w.el.querySelector('[data-b="reload"]'), back = w.el.querySelector('[data-b="back"]'), fwd = w.el.querySelector('[data-b="fwd"]');
    if (reload) { reload.textContent = w.loading ? '✕' : '⟳'; reload.title = w.loading ? 'Stop' : 'Reload'; }
    if (back) back.disabled = !w.webview.canGoBack();
    if (fwd) fwd.disabled = !w.webview.canGoForward();
  }
  function browserNavigate(w, url) {
    const u = normalizeUrl(url);
    w.url = u;
    w.urlInput.value = u === 'about:blank' ? '' : u;
    // Before the guest has ever attached, only setting the src attribute (not loadURL) triggers the attach.
    if (w.attached) w.webview.loadURL(u).catch(() => {});
    else w.webview.src = u;
  }
  function openBrowser(url, { ws = current, focus = true, near = null } = {}) {
    const id = nextId++;
    const el = document.createElement('div');
    el.className = 'win browser opening';
    el.innerHTML = `<div class="inner"><div class="tbar"><span class="ico">◎</span><span class="title">Browser</span><span class="badge"></span>
      <span class="view-acts"><button data-b="back" title="Back">←</button><button data-b="fwd" title="Forward">→</button>
      <button data-b="reload" title="Reload">⟳</button><button data-b="dev" title="DevTools">◫</button>
      <button data-b="open" title="Open in the system browser">↗</button></span><button class="x" title="Close">✕</button></div>
      <div class="browser-bar"><input class="browser-url" spellcheck="false" autocomplete="off" placeholder="Address"></div>
      <div class="browser-wrap"><webview class="browser-view" partition="persist:operant-browser" allowpopups></webview></div></div>`;
    const wv = el.querySelector('webview');
    const w = { id, kind: 'browser', el, term: null, title: 'Browser', alive: true, ws, lastActivity: Date.now(), closeIn: null,
      cwd: null, webview: wv, urlInput: el.querySelector('.browser-url'), console: [], loading: false, url: 'about:blank' };
    el.querySelector('.title').textContent = w.title;
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); requestClose(w); });
    el.addEventListener('mousedown', e => onWinMouseDown(e, w), true);
    el.querySelector('.view-acts').addEventListener('click', e => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      if (b.dataset.b === 'back') wv.goBack();
      else if (b.dataset.b === 'fwd') wv.goForward();
      else if (b.dataset.b === 'reload') { if (w.loading) wv.stop(); else wv.reload(); }
      else if (b.dataset.b === 'dev') { if (wv.isDevToolsOpened()) wv.closeDevTools(); else wv.openDevTools(); }
      else if (w.url) operant.openLink(w.url, true); // "open in system browser" always uses the second browser
    });
    w.urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); browserNavigate(w, w.urlInput.value); }
      else if (e.key === 'Escape') { e.preventDefault(); w.urlInput.value = w.url === 'about:blank' ? '' : w.url; focusKeys(w); }
    });
    wv.addEventListener('focus', () => { if (workspaces[w.ws].focused !== w.id) focusWin(w, false); });
    // A guest webview grabs the keyboard itself once its page is ready; a tile that opened with no
    // URL wants the address bar instead, so it's clawed back the first time that happens.
    wv.addEventListener('dom-ready', () => { w.attached = true; if (w.wantUrlFocus) { w.wantUrlFocus = false; w.urlInput.focus(); w.urlInput.select(); } });
    wv.addEventListener('did-start-loading', () => { w.loading = true; drawBrowserBar(w); });
    wv.addEventListener('did-stop-loading', () => { w.loading = false; drawBrowserBar(w); });
    const onNav = () => { w.url = wv.getURL() || w.url; w.urlInput.value = w.url === 'about:blank' ? '' : w.url; setBadge(w, urlHost(w.url)); drawBrowserBar(w); saveSession(); };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('page-title-updated', e => setTitle(w, e.title || urlHost(w.url) || 'Browser'));
    wv.addEventListener('console-message', e => {
      w.console.push({ level: e.level, message: e.message, line: e.line, source: e.sourceId });
      if (w.console.length > 500) w.console.shift();
    });
    wins.set(id, w);
    if (focus && !url) w.wantUrlFocus = true;
    mount(w, ws, near, { focus });
    browserNavigate(w, url || 'about:blank');
    saveSession();
    return w;
  }
  // Alt/Ctrl keybinds forwarded from main: the guest's key events never bubble to this page.
  operant.on('browser:key', combo => {
    const w = focused();
    if (!w || w.kind !== 'browser') return;
    const action = bindMap.get(combo);
    if (action && actions[action]) actions[action]();
  });

  // ------------------------------------------------------------- diff tile
  // What changed in a project since the last commit, file by file: staged, unstaged and new files.

  // A porcelain status code -> [letter, class]: modified, added (new, renamed), deleted, conflict.
  function gitKind(code) {
    if (code === '??') return ['U', 'a'];
    if (/U|AA|DD/.test(code)) return ['!', 'c'];
    if (code.includes('D')) return ['D', 'd'];
    if (code.includes('A')) return ['A', 'a'];
    if (code.includes('R') || code.includes('C')) return ['R', 'a'];
    return ['M', 'm'];
  }
  const GIT_NAMES = { U: 'New, not added to git yet', A: 'Added', D: 'Deleted', R: 'Renamed', M: 'Modified', '!': 'Conflict' };

  // IntelliJ-style committing: tick the files (all are ticked to start), write a message, Commit or
  // Commit and Push (Ctrl+Enter commits). The bar has the branch (click to switch), Pull and Push.
  function openDiff(dir, { ws = current, focus = true, near = null } = {}) {
    const open = [...wins.values()].find(x => x.kind === 'diff' && x.alive && normPath(x.cwd) === normPath(dir));
    if (open && focus) { if (open.ws !== current) switchWorkspace(open.ws); focusWin(open); loadDiff(open); return open; }
    const id = nextId++;
    const el = document.createElement('div');
    el.className = 'win diff opening';
    el.innerHTML = `<div class="inner"><div class="tbar"><span class="ico">±</span><span class="title"></span><span class="badge"></span>
      <span class="view-acts"><button data-v="branch" class="git-branch" title="Switch branch"></button><button data-v="pull" title="Pull from the remote">↓ Pull</button>
      <button data-v="push" title="Push commits to the remote">↑ Push</button><button data-v="refresh" title="Refresh">⟳</button></span><button class="x" title="Close">✕</button></div>
      <div class="diff-wrap"><div class="diff-side"><label class="diff-all"><input type="checkbox" checked><span></span></label><div class="diff-files"></div>
        <div class="commit-box"><textarea class="commit-msg" placeholder="Commit message" spellcheck="true"></textarea>
        <div class="commit-row"><label class="commit-amend" title="Change the last commit instead of making a new one"><input type="checkbox"> Amend</label><span class="commit-status"></span></div>
        <div class="commit-row"><button class="btn primary" data-c="commit" title="Ctrl+Enter">Commit</button><button class="btn" data-c="push">Commit and Push</button></div></div></div>
      <div class="view-wrap"><div class="view-page diff-page" tabindex="-1"><div class="diff-body"></div></div>${FIND_BAR}</div></div></div>`;
    const w = { id, kind: 'diff', el, term: null, title: `Changes · ${baseName(dir)}`, alive: true, ws, lastActivity: Date.now(), closeIn: null,
      cwd: dir, page: el.querySelector('.diff-page'), files: [], sel: null, skip: new Set() };
    el.querySelector('.title').textContent = w.title;
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); requestClose(w); });
    el.addEventListener('mousedown', e => onWinMouseDown(e, w), true);
    el.querySelector('.view-acts').addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      if (b.dataset.v === 'refresh') loadDiff(w);
      else if (b.dataset.v === 'branch') branchMenu(w, b);
      else gitOp(w, b.dataset.v);
    });
    const list = el.querySelector('.diff-files');
    list.addEventListener('click', e => {
      const b = e.target.closest('[data-file]');
      if (!b) return;
      if (e.target.matches('.df-check')) { if (e.target.checked) w.skip.delete(b.dataset.file); else w.skip.add(b.dataset.file); return markAll(w); }
      w.sel = b.dataset.file;
      el.querySelectorAll('.df-row').forEach(r => r.classList.toggle('on', r === b));
      showDiffFile(w);
    });
    const fullOf = f => w.status.root + '\\' + f.replace(/\//g, '\\');
    list.addEventListener('dblclick', e => {
      const b = e.target.closest('[data-file]');
      if (b && w.status && !e.target.matches('.df-check')) openViewer(fullOf(b.dataset.file), { ws: w.ws });
    });
    list.addEventListener('contextmenu', e => {
      const b = e.target.closest('[data-file]');
      if (!b || !w.status) return;
      e.preventDefault();
      const f = w.files.find(x => x.path === b.dataset.file), full = fullOf(f.path), gone = f.code.includes('D');
      showMenu(e.clientX, e.clientY, [
        ...(gone ? [] : [['▤', 'View', () => openViewer(full, { ws: w.ws })], ['✎', `Edit in ${editorName || 'editor'}`, () => openEditor(full, { ws: w.ws })],
          ['▤', 'Show in Explorer', () => operant.reveal(full)]]),
        '-',
        ['↶', 'Roll back…', () => rollback(w, f)],
      ]);
    });
    el.querySelector('.diff-all input').onchange = e => {
      if (e.target.checked) w.skip.clear(); else w.files.forEach(f => w.skip.add(f.path));
      list.querySelectorAll('.df-check').forEach(c => { c.checked = e.target.checked; });
      markAll(w);
    };
    const msg = el.querySelector('.commit-msg');
    msg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); commit(w, e.shiftKey); } });
    el.querySelector('.commit-amend input').onchange = async e => {
      if (e.target.checked && !msg.value.trim() && w.status) msg.value = (await operant.git('last-message', w.status.root)).trim();
    };
    el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => commit(w, b.dataset.c === 'push'));
    w.page.addEventListener('mouseup', () => copySelection(w));
    findBar(w);
    wins.set(id, w);
    mount(w, ws, near, { focus });
    loadDiff(w);
    saveSession();
    return w;
  }

  // Task board: one per window. `operant task add` opens it (without stealing focus) if none is open
  // yet; `operant task claim/done/note` and `operant board` all read/write the same w.tasks array.
  function getBoard() { return [...wins.values()].find(x => x.kind === 'board' && x.alive) || null; }
  function fmtOwner(id) {
    if (id == null) return null;
    const t = wins.get(id);
    return { id, title: t && t.alive ? t.title : `tile ${id} (closed)` };
  }
  function openBoard({ ws = current, focus = false, near = null, tasks = [] } = {}) {
    const id = nextId++;
    const el = document.createElement('div');
    el.className = 'win board opening';
    el.innerHTML = `<div class="inner"><div class="tbar"><span class="ico">☰</span><span class="title">Task board</span><span class="badge"></span>
      <button class="x" title="Close">✕</button></div>
      <div class="view-wrap"><div class="view-page board-page" tabindex="-1"><div class="board-body"></div></div></div></div>`;
    const w = { id, kind: 'board', el, term: null, title: 'Task board', alive: true, ws, lastActivity: Date.now(), closeIn: null,
      cwd: near?.cwd || lastCwd, page: el.querySelector('.board-page'), tasks: tasks.map(t => ({ ...t })) };
    w.nextTaskId = Math.max(0, ...w.tasks.map(t => t.id)) + 1;
    el.querySelector('.title').textContent = w.title;
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); requestClose(w); });
    el.addEventListener('mousedown', e => onWinMouseDown(e, w), true);
    w.page.querySelector('.board-body').addEventListener('click', e => {
      const b = e.target.closest('[data-owner]');
      if (!b) return;
      const t = wins.get(Number(b.dataset.owner));
      if (t?.alive) { if (t.ws !== current) switchWorkspace(t.ws); focusWin(t); }
    });
    wins.set(id, w);
    mount(w, ws, near, { focus });
    renderBoard(w);
    saveSession();
    return w;
  }
  function renderBoard(w) {
    if (!w.alive) return;
    const groups = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done']];
    const row = t => {
      const owner = fmtOwner(t.owner);
      return `<div class="board-row"><span class="board-id">#${t.id}</span><span class="board-text">${esc(t.text)}</span>`
        + (owner ? `<button class="board-owner" data-owner="${owner.id}">${esc(owner.title)}</button>` : '<span class="board-owner unassigned">unassigned</span>')
        + (t.note ? `<span class="board-note">${esc(t.note)}</span>` : '') + '</div>';
    };
    w.page.querySelector('.board-body').innerHTML = groups.map(([k, label]) => {
      const items = w.tasks.filter(t => t.status === k);
      return `<div class="board-group"><h3>${label} (${items.length})</h3>${items.length ? items.map(row).join('') : '<div class="board-empty">—</div>'}</div>`;
    }).join('');
    setBadge(w, `${w.tasks.filter(t => t.status !== 'done').length} open`);
  }

  function markAll(w) {
    const n = w.files.filter(f => !w.skip.has(f.path)).length, box = w.el.querySelector('.diff-all input');
    box.checked = n === w.files.length && n > 0;
    box.indeterminate = n > 0 && n < w.files.length;
    w.el.querySelector('.diff-all span').textContent = w.files.length ? `${n} of ${w.files.length} file${w.files.length === 1 ? '' : 's'} to commit` : 'Nothing to commit';
  }

  // Git's own words when something goes wrong (a rejected push, a merge conflict, a hook).
  const gitSaid = (what, out) => operant.ask({ message: what, detail: out || 'Git gave no reason.', buttons: ['OK'], cancelId: 0 });
  function gitBusy(w, text) {
    w.gitBusy = !!text;
    w.el.querySelector('.commit-status').textContent = text || '';
    w.el.querySelectorAll('[data-c], [data-v="pull"], [data-v="push"], [data-v="branch"]').forEach(b => { b.disabled = !!text; });
  }

  async function commit(w, push) {
    if (w.gitBusy || !w.status) return;
    const msg = w.el.querySelector('.commit-msg'), amend = w.el.querySelector('.commit-amend input');
    const files = w.files.filter(f => !w.skip.has(f.path));
    if (!msg.value.trim()) { msg.focus(); return toast('Write a commit message first'); }
    if (!files.length && !amend.checked) return toast('Tick the files to commit');
    gitBusy(w, push ? 'Committing and pushing…' : 'Committing…');
    const r = await operant.git('commit', { root: w.status.root, files: files.map(f => ({ path: f.path, orig: f.orig })), message: msg.value.trim(), amend: amend.checked, push });
    gitBusy(w, null);
    if (!w.alive) return;
    const committed = r.ok || (push && r.pushed === false);
    if (committed) { toast(`<b>${amend.checked ? 'Amended' : 'Committed'}</b> ${files.length} file${files.length === 1 ? '' : 's'}${r.pushed ? ' and pushed' : ''}`); msg.value = ''; amend.checked = false; gitChanged(); }
    if (!r.ok) gitSaid(committed ? 'Committed, but the push failed' : 'Git couldn’t commit', r.out);
  }

  async function gitOp(w, op) {
    if (w.gitBusy || !w.status) return;
    gitBusy(w, op === 'pull' ? 'Pulling…' : 'Pushing…');
    const r = await operant.git(op, w.status.root);
    gitBusy(w, null);
    if (!r.ok) return gitSaid(op === 'pull' ? 'Git couldn’t pull' : 'Git couldn’t push', r.out);
    toast(op === 'pull' ? `<b>Pulled</b> ${esc(r.out.split('\n').pop() || '')}` : '<b>Pushed</b>');
    gitChanged();
  }

  async function rollback(w, f) {
    const isNew = f.code === '??' || f.code[0] === 'A';
    const r = await operant.ask({ message: `Roll back ${f.path.split('/').pop()}?`,
      detail: isNew ? 'It’s a new file, so rolling it back deletes it.' : 'Its changes since the last commit are lost.', buttons: ['Roll back', 'Cancel'], cancelId: 1 });
    if (r !== 0) return;
    const res = await operant.git('rollback', { root: w.status.root, file: f });
    if (!res.ok) return gitSaid('Git couldn’t roll it back', res.out);
    gitChanged();
  }

  async function branchMenu(w, btn) {
    if (w.gitBusy || !w.status) return;
    const list = await operant.git('branches', w.status.root), r = btn.getBoundingClientRect();
    const to = async (branch, create) => {
      gitBusy(w, 'Switching…');
      const res = await operant.git('checkout', { root: w.status.root, branch, create });
      gitBusy(w, null);
      if (!res.ok) return gitSaid(`Git couldn’t switch to ${branch}`, res.out);
      toast(`On <b>${esc(branch)}</b>`);
      gitChanged();
    };
    showMenu(r.left, r.bottom + 4, [
      ...list.map(b => [b === w.status.branch ? '●' : '⎇', b, () => b !== w.status.branch && to(b)]),
      '-',
      ['＋', 'New branch…', () => {
        const input = document.createElement('input');
        input.className = 'branch-name'; input.placeholder = 'new-branch-name'; input.spellcheck = false;
        btn.replaceWith(input); input.focus();
        let done = false;
        const finish = keep => { if (done) return; done = true; input.replaceWith(btn); const n = input.value.trim(); if (keep && n) to(n, true); };
        input.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e.key === 'Enter'); } };
        input.onblur = () => finish(false);
      }],
    ]);
  }

  async function loadDiff(w) {
    if (w.loading) return;
    w.loading = true;
    const st = await operant.gitStatus(w.cwd);
    w.loading = false;
    if (!w.alive) return;
    w.status = st; w.loadedAt = Date.now();
    const list = w.el.querySelector('.diff-files'), body = w.el.querySelector('.diff-body');
    w.el.classList.toggle('no-git', !st);
    if (!st) { w.files = []; list.innerHTML = ''; markAll(w); body.innerHTML = `<div class="view-msg">${esc(baseName(w.cwd))} isn't in a git repository</div>`; return setBadge(w, ''); }
    // Only the project's own files, when it's a folder inside a bigger repository.
    const inside = f => isUnder(st.root + '\\' + f.path.replace(/\//g, '\\'), w.cwd);
    w.files = st.files.filter(inside);
    for (const p of [...w.skip]) if (!w.files.some(f => f.path === p)) w.skip.delete(p);
    setBadge(w, `${w.files.length} changed`);
    w.el.querySelector('[data-v="branch"]').textContent = `⎇ ${st.branch}`;
    w.el.querySelector('[data-v="push"]').textContent = `↑ Push${st.ahead ? ` ${st.ahead}` : ''}`;
    w.el.querySelector('[data-v="pull"]').textContent = `↓ Pull${st.behind ? ` ${st.behind}` : ''}`;
    if (!w.files.some(f => f.path === w.sel)) w.sel = w.files[0]?.path || null;
    list.innerHTML = w.files.map(f => {
      const [letter, cls] = gitKind(f.code), name = f.path.split('/').pop(), dir = f.path.slice(0, -name.length - 1);
      return `<div class="df-row${f.path === w.sel ? ' on' : ''}" data-file="${esc(f.path)}" title="${esc(GIT_NAMES[letter])} · ${esc(f.path)}">`
        + `<input type="checkbox" class="df-check"${w.skip.has(f.path) ? '' : ' checked'}>`
        + `<span class="df-code git-${cls}">${letter}</span><span class="df-nm">${esc(name)}</span><span class="df-dir">${esc(dir)}</span></div>`;
    }).join('');
    markAll(w);
    if (!w.files.length) { body.innerHTML = '<div class="view-msg">No changes since the last commit</div>'; return; }
    showDiffFile(w);
  }

  async function showDiffFile(w) {
    const f = w.files.find(x => x.path === w.sel), body = w.el.querySelector('.diff-body');
    if (!f) return;
    const r = await operant.gitDiff({ root: w.status.root, file: f.path, code: f.code });
    if (!w.alive || w.sel !== f.path) return;
    const head = `<div class="diff-head">${esc(f.path)}</div>`;
    if (r.error) body.innerHTML = head + `<div class="view-msg">${esc(r.error)}</div>`;
    else if (r.binary) body.innerHTML = head + '<div class="view-msg">A binary file changed</div>';
    else if (!r.text.trim()) body.innerHTML = head + `<div class="view-msg">${f.code.includes('D') ? 'Deleted' : 'No line changes (only its mode or name)'}</div>`;
    else {
      const l = Highlight.lang(f.path);
      let a = 0, b = 0, html = '';
      for (const line of r.text.replace(/\n$/, '').split('\n')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
        if (m) { a = +m[1]; b = +m[2]; html += `<div class="dl hunk"><span class="dl-n"></span><span class="dl-n"></span><span class="dl-t">${esc(line)}</span></div>`; continue; }
        if (line.startsWith('\\')) continue; // "No newline at end of file"
        const t = line[0], rest = line.slice(1);
        const code = l && rest.length < 2000 ? Highlight.lines(rest, l)[0] : esc(rest);
        if (t === '+') html += `<div class="dl add"><span class="dl-n"></span><span class="dl-n">${b++}</span><span class="dl-t">${code}</span></div>`;
        else if (t === '-') html += `<div class="dl del"><span class="dl-n">${a++}</span><span class="dl-n"></span><span class="dl-t">${code}</span></div>`;
        else html += `<div class="dl"><span class="dl-n">${a++}</span><span class="dl-n">${b++}</span><span class="dl-t">${code}</span></div>`;
      }
      body.innerHTML = head + `<div class="diff-lines">${html}</div>`;
    }
    w.page.scrollTop = 0;
    if (w.find?.q) runFind(w, true);
  }

  // The focused tile's project (its pinned project, or its own folder).
  const projectDir = dir => allProjects().filter(p => isUnder(dir, p)).sort((x, y) => y.length - x.length)[0] || dir;
  function showChanges(dir = focused()?.cwd || lastCwd) {
    if (!dir) return toast('Open a tile in a project first');
    openDiff(projectDir(dir));
  }

  // ------------------------------------------------------------- session
  // Main keeps each window's tiles and layout so they can be reopened after an update. Subagent
  // tiles and one-off command tiles (CodeGraph) aren't kept.

  const keepTile = w => w.alive && w.kind !== 'agent' && !w.run;
  function snapshot() {
    const tiles = [];
    const ser = n => {
      if (!n) return null;
      if (n.win) {
        if (!keepTile(n.win)) return null;
        const w = n.win;
        tiles.push({ kind: w.kind, agent: w.agentConf, cwd: w.cwd, title: w.customTitle, master: !!w.master,
          sessionId: w.sessionId && !w.sessionId.startsWith('oc:') ? w.sessionId : undefined,
          ...(w.kind === 'view' ? { file: w.file } : {}), ...(w.kind === 'browser' ? { url: w.url } : {}), ...(w.edit ? { edit: w.edit } : {}),
          ...(w.kind === 'board' ? { tasks: w.tasks } : {}) });
        w.snapIndex = tiles.length - 1;
        return { tile: w.snapIndex };
      }
      const a = ser(n.a), b = ser(n.b);
      return a && b ? { split: n.split, ratio: n.ratio, a, b } : a || b;
    };
    const idx = id => { const w = wins.get(id); return w && keepTile(w) ? w.snapIndex : null; };
    const spaces = workspaces.map(ws => {
      const tree = ser(ws.tree);
      return { layout: ws.layout, mfact: ws.mfact, tree, focused: tree ? idx(ws.focused) : null, fullscreen: tree ? idx(ws.fullscreen) : null };
    });
    return { current, tiles, workspaces: spaces };
  }
  let sessionT, lastSnap = '';
  function saveSession() {
    clearTimeout(sessionT);
    sessionT = setTimeout(() => {
      const snap = snapshot(), sig = JSON.stringify(snap);
      if (sig !== lastSnap) { lastSnap = sig; operant.saveSession(snap); }
    }, 300);
  }
  // Skips the debounce: used right before quitting, where the delayed save would never fire.
  function saveSessionNow() {
    clearTimeout(sessionT);
    const snap = snapshot();
    lastSnap = JSON.stringify(snap);
    operant.saveSession(snap);
  }

  // Reopens a snapshot's tiles in their workspaces, then puts back each layout exactly.
  async function restore(snap) {
    const made = await Promise.all(snap.tiles.map((t, i) => {
      const ws = Math.max(snap.workspaces.findIndex(s => JSON.stringify(s.tree || null).includes(`{"tile":${i}}`)), 0);
      if (t.kind === 'view') return openViewer(t.file, { ws, focus: false });
      if (t.kind === 'diff') return openDiff(t.cwd, { ws, focus: false });
      if (t.kind === 'browser') return openBrowser(t.url, { ws, focus: false });
      if (t.kind === 'board') return openBoard({ ws, focus: false, tasks: t.tasks || [] });
      if (t.edit) return openEditor(t.edit, { ws, focus: false });
      return newTerminal(t.kind, t.cwd, { agentId: t.agent, title: t.title, master: t.master, resume: t.sessionId, ws, focus: false });
    }));
    const build = n => {
      if (!n) return null;
      if ('tile' in n) { const w = made[n.tile]; return w?.alive ? findLeaf(workspaces[w.ws].tree, w) && { win: w } : null; }
      const a = build(n.a), b = build(n.b);
      return a && b ? { split: n.split, ratio: n.ratio, a, b } : a || b;
    };
    snap.workspaces.forEach((s, i) => {
      const ws = workspaces[i];
      if (!s || !ws) return;
      ws.layout = s.layout || ws.layout;
      ws.mfact = s.mfact || ws.mfact;
      if (!s.tree) return;
      const before = wsWins(i);
      ws.tree = build(s.tree) || ws.tree;
      // Anything that opened meanwhile (a subagent) keeps a place beside the restored layout.
      for (const w of before) if (!findLeaf(ws.tree, w)) ws.tree = { split: 'h', ratio: 0.5, a: ws.tree, b: { win: w } };
      const at = k => (k != null && made[k]?.alive && made[k].ws === i ? made[k].id : null);
      ws.fullscreen = at(s.fullscreen);
      const f = at(s.focused);
      if (f != null) ws.focused = f;
      for (const w of wins.values()) if (w.ws === i) w.el.classList.toggle('focused', w.id === ws.focused);
      layout(i, true);
    });
    if (snap.current !== current) switchWorkspace(snap.current); else { const f = focused(); if (f) focusWin(f); else refreshBar(); }
    return made.some(Boolean);
  }

  function shortPath(p) { const parts = p.split(/[\\/]/).filter(Boolean); return parts.slice(-2).join('\\'); }

  function closeWin(w) {
    if (!w.alive) return;
    w.alive = false;
    if (w.planQueue?.length) { w.planQueue.forEach(r => r({ approved: false, note: '(closed without an answer)' })); w.planQueue = []; }
    const wsIndex = w.ws;
    const wasFocused = workspaces[wsIndex].focused === w.id;
    const neighbour = wasFocused ? nearestAfterClose(w) : null;
    detach(w);
    if (w.ptyId) { operant.killPty(w.ptyId); ptyWins.delete(w.ptyId); }
    if (w.sessionId) sessionWin.delete(w.sessionId);
    if (w.agentId) {
      agentWin.delete(w.agentId);
      closedAgentInfo.delete(w.agentId); // re-insert at the end, so eviction below drops the oldest
      closedAgentInfo.set(w.agentId, w.info);
      if (closedAgentInfo.size > 200) closedAgentInfo.delete(closedAgentInfo.keys().next().value);
    }
    if (w.kind === 'view') operant.watchFile(w.id, null);
    backlog.delete(w);
    w.el.classList.add('closing');
    const closeMs = parseFloat(getComputedStyle(document.body).getPropertyValue('--anim-pop')) || 0;
    setTimeout(() => { w.term?.dispose(); w.el.remove(); }, closeMs);
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
    w.focusedAt = Date.now();
    for (const o of wins.values()) if (o.ws === w.ws) o.el.classList.toggle('focused', o === w);
    if (w.ws !== current) return refreshBar();
    flushBacklog(w);
    if (grabKeyboard) focusKeys(w);
    refreshBar();
  }

  const focused = () => wins.get(workspaces[current].focused);
  // The keyboard goes to a tile's terminal, or to a viewer's page so the arrow keys scroll it.
  const focusKeys = w => { if (!w) return; if (w.term) w.term.focus(); else if (w.kind === 'browser') w.webview?.focus(); else w.page?.focus({ preventScroll: true }); };

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
    if (w.kind === 'ai' && now - (w.lastPromptScan || 0) > 250) { w.lastPromptScan = now; checkClaudeWaiting(w); }
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

  // action (optional): { label, ... } shown as an extra link in the bell panel row; showAlwaysAllowCard
  // reads the rest of it (see the permission-prompt section below).
  async function notify(w, title, body, action) {
    if (!w.alive) return;
    if (w.lastNotified && Date.now() - w.lastNotified < 5000) return;
    logNotification(w, title, body, action); // kept for the bell panel even when the Windows toast below is off
    if (!cfg.notifications) return;
    if (cfg.notifyOnlyUnfocused && w.ws === current && workspaces[w.ws].focused === w.id && await operant.windowFocused()) return;
    w.lastNotified = Date.now();
    operant.notify({ title, body, tileId: w.id });
  }

  // The bell panel's log: newest first, capped at 100, kept only in memory.
  const notifLog = [];
  let notifId = 0;
  function logNotification(w, title, body, action) {
    const icon = w.el?.querySelector('.ico')?.textContent || '🔔';
    notifLog.unshift({ id: ++notifId, tileId: w.id, ws: w.ws, icon, tileTitle: w.title, title, body, at: Date.now(), read: false, action: action || null });
    notifLog.length = Math.min(notifLog.length, 100);
    updateNotifBadge();
    if (openPanel() === 'notifications') renderNotifications();
  }
  function updateNotifBadge() {
    const n = notifLog.filter(x => !x.read).length;
    $('#notif-badge').textContent = n > 99 ? '99+' : n || '';
    $('#notif-badge').classList.toggle('hidden', !n);
  }
  function markAllNotifsRead() {
    if (!notifLog.some(n => !n.read)) return;
    notifLog.forEach(n => n.read = true);
    updateNotifBadge();
    renderNotifications();
  }
  function relTime(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  function renderNotifications() {
    const body = $('#notif-body');
    body.innerHTML = notifLog.length ? notifLog.map(n => `<button class="notif-row${n.read ? '' : ' unread'}" data-id="${n.id}">
      <span class="notif-ico">${esc(n.icon)}</span>
      <span class="notif-txt"><span class="notif-title">${esc(n.title)}</span>${n.tileTitle ? `<span class="notif-tile">${esc(n.tileTitle)}</span>` : ''}${n.body ? `<span class="notif-body">${esc(n.body)}</span>` : ''}${n.action ? `<span class="notif-action" data-action="${n.id}">${esc(n.action.label)}</span>` : ''}</span>
      <span class="notif-time">${relTime(n.at)}</span></button>`).join('')
      : '<div class="side-empty">No notifications yet</div>';
    body.querySelectorAll('[data-id]').forEach(b => b.onclick = () => focusNotification(+b.dataset.id));
    body.querySelectorAll('[data-action]').forEach(b => b.onclick = e => { e.stopPropagation(); showAlwaysAllowCard(+b.dataset.action); });
  }
  function focusNotification(id) {
    const n = notifLog.find(x => x.id === id);
    const w = n && wins.get(n.tileId);
    closePanels();
    if (!w || !w.alive) return toast('That tile is closed.');
    if (w.ws !== current) switchWorkspace(w.ws);
    focusWin(w);
  }
  $('#notif-clear').onclick = () => { notifLog.length = 0; renderNotifications(); updateNotifBadge(); };
  // Keep the relative times fresh while the panel is open, without a full re-render loop elsewhere.
  setInterval(() => { if (openPanel() === 'notifications') renderNotifications(); }, 30000);

  setInterval(() => {
    const now = Date.now();
    for (const w of wins.values()) {
      if (w.ocBusy) w.lastOut = now;
      if (!w.busySince || now - w.lastOut < cfg.notifyWhenIdleSeconds * 1000) continue;
      const worked = w.lastOut - w.busySince;
      w.busySince = null;
      if (w.runaway) { w.runaway = null; setRunawayBadge(w); }
      if (worked >= 2500) { w.unchecked = true; gitChanged(); }
      if (worked >= 2500 && cfg.notifyWhenIdleSeconds > 0) notify(w, `${w.agentName} is waiting for you`, `${w.title !== w.agentName ? w.title + ' · ' : ''}${shortPath(w.cwd || '')}`);
    }
  }, 1000);

  operant.on('focus-tile', id => {
    const w = wins.get(Number(id));
    if (!w || !w.alive) return;
    if (w.ws !== current) switchWorkspace(w.ws);
    focusWin(w);
  });
  operant.on('pty:exit', ({ id }) => { const w = ptyWins.get(id); if (w) { closeWin(w); gitChanged(); } });
  // An OpenCode tile's main session started or stopped working.
  operant.on('opencode:busy', ({ ptyId, busy }) => {
    const w = ptyWins.get(ptyId);
    if (!w) return;
    if (busy) { w.typed = true; w.ocBusy = true; w.busySince ??= Date.now(); w.lastOut = Date.now(); }
    else w.ocBusy = false;
  });

  // ------------------------------------------------------------- subagents

  // Places and mounts a tile for a subagent, fresh or reopened after it closed. Returns null if
  // it's an external agent (no parent tile still open) and those are switched off.
  function openAgentTile(info, { resumed = false } = {}) {
    const parent = sessionWin.get(info.sessionId);
    if (!parent && !cfg.showExternalAgents) return null;

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
    if (resumed) w.term.write('\x1b[38;2;156;151;139m↻ resumed\x1b[0m\r\n\r\n');
    updateBadge(w);
    if (wsIndex !== current) toast(`<b>◆ ${esc(info.agentType)}</b> ${esc(info.description)} → ${esc(wsName(wsIndex) || `workspace ${wsIndex + 1}`)}`, () => { switchWorkspace(wsIndex); focusWin(w); });
    refreshBar();
    return w;
  }

  operant.on('agent:new', info => {
    if (agentWin.has(info.agentId)) return;
    openAgentTile(info);
  });

  operant.on('agent:entries', ({ agentId, entries }) => {
    let w = agentWin.get(agentId);
    if (!w || !w.alive) {
      // The tile closed (idle, done, or by hand) but this same agent got more entries: reopen it,
      // unless there's nothing to show yet (just a done-marker with no actual content).
      const info = closedAgentInfo.get(agentId);
      if (!info || !entries.some(e => e.blocks.length > 0)) return;
      w = openAgentTile(info, { resumed: true });
      if (!w) return;
      closedAgentInfo.delete(agentId);
    }
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
    if (w.kind === 'ai') {
      // The folder moved to the info bar below; the title bar badge is just the closing/unread marker.
      setBadge(w, closing.replace(/^ · /, ''));
      renderIbar(w);
      return;
    }
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

  // The info bar under an agent tile's title (item 42): model, how full its context is, tokens
  // used since the tile opened, and its folder and git branch. Only for kind 'ai' tiles (Claude
  // Code, OpenCode, other agent CLIs), gated by Settings > "Tile info bar" (cfg.tileTokens).
  // A raw model id -> a short display name. Claude ids look like claude-opus-4-5-20250929;
  // OpenCode ids look like opencode/big-pickle (or just the model half once the provider is known).
  function modelName(sessionId, raw, free) {
    if (!raw) return '';
    if (sessionId.startsWith('oc:')) {
      const short = raw.includes('/') ? raw.split('/').pop() : raw;
      const name = short.split('-').map(s => s ? s[0].toUpperCase() + s.slice(1) : s).join(' ');
      return name + (free ? ' · free' : '');
    }
    const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(raw);
    if (!m) return raw;
    const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return m[3] != null ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
  }
  function renderIbar(w) {
    if (w.kind !== 'ai') return;
    const on = !!cfg.tileTokens;
    w.el.classList.toggle('ibar-on', on);
    if (!on) return;
    const bar = w.el.querySelector('.ibar');
    if (!bar) return;
    bar.querySelector('.ib-model').textContent = w.model || '';
    const ctx = cfg.contextBadge ? w.ctx : null, ctxEl = bar.querySelector('.ib-ctx');
    if (ctx && ctx.max) {
      const pct = ctx.tokens / ctx.max;
      ctxEl.className = 'ib-ctx' + (pct >= 0.85 ? ' over' : pct >= 0.6 ? ' warn' : '');
      ctxEl.querySelector('b').style.width = `${Math.min(100, Math.round(pct * 100))}%`;
      ctxEl.querySelector('.ib-ctxtxt').textContent = `${fmtTok(ctx.tokens)} / ${fmtTok(ctx.max)} (${Math.round(pct * 100)}%)`;
      ctxEl.title = `${ctx.tokens.toLocaleString()} of ${ctx.max.toLocaleString()} tokens in context · /compact or start a fresh session when it gets high`;
      ctxEl.style.display = '';
    } else ctxEl.style.display = 'none';
    const t = w.tok, tokEl = bar.querySelector('.ib-tok');
    if (t) {
      tokEl.textContent = `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · cache ${fmtTok(t.cacheRead + t.cacheWrite)}`;
      tokEl.title = `${t.input.toLocaleString()} in · ${t.output.toLocaleString()} out · ${t.cacheRead.toLocaleString()} cache read · ${t.cacheWrite.toLocaleString()} cache write`
        + (t.free ? ' · free' : '') + ' · since this tile opened';
      tokEl.style.display = '';
    } else tokEl.style.display = 'none';
    const folder = w.cwd ? shortPath(w.cwd) : '', folderEl = bar.querySelector('.ib-folder');
    folderEl.textContent = folder;
    folderEl.style.display = folder ? '' : 'none';
    const project = w.cwd ? projectDir(w.cwd) : null;
    const branch = project ? gitState.get(project)?.status?.branch : null, branchEl = bar.querySelector('.ib-branch');
    branchEl.textContent = branch || '';
    branchEl.style.display = branch ? '' : 'none';
    layoutIbar(w, bar);
  }
  // Least important (rightmost) first: the branch, then the folder. Everything else always fits.
  function layoutIbar(w, bar) {
    bar = bar || w.el.querySelector('.ibar');
    if (!bar || !w.el.classList.contains('ibar-on')) return;
    const branch = bar.querySelector('.ib-branch'), folder = bar.querySelector('.ib-folder');
    if (bar.scrollWidth > bar.clientWidth && branch.textContent) branch.style.display = 'none';
    if (bar.scrollWidth > bar.clientWidth && folder.textContent) folder.style.display = 'none';
  }
  operant.on('context', ({ sessionId, tokens, max, model, free }) => {
    const w = sessionWin.get(sessionId);
    if (!w || !w.alive) return;
    w.ctx = { tokens, max };
    if (model !== undefined) w.model = modelName(sessionId, model, free);
    renderIbar(w);
  });
  operant.on('tokens', ({ sessionId, input, output, cacheWrite, cacheRead, free }) => {
    const w = sessionWin.get(sessionId);
    if (!w || !w.alive) return;
    w.tok = { input, output, cacheWrite, cacheRead, free };
    renderIbar(w);
  });

  // ------------------------------------------------------------ idle reaper
  // A tile closes once nothing has happened in it for its limit: no output, no typing,
  // no transcript lines, and not being looked at. The master and focused tiles are exempt.
  // Nothing that is still working closes, and nothing that finished closes before you've seen
  // it: a finished tile counts as checked once it's on screen while Operant has focus, and its
  // countdown starts from then.

  const touch = w => { w.lastActivity = Date.now(); };

  function idleLimit(w) {
    if (w.kind === 'agent') return w.status === 'done' ? cfg.autoCloseDoneAgentsSeconds * 1000 : 0;
    // Viewers, diffs, browsers and the task board are read, not run; an editor with unsaved changes would lose them.
    if (w.kind === 'view' || w.kind === 'diff' || w.kind === 'browser' || w.kind === 'board' || (w.edit && (w.tracksDirty ? w.dirty : w.typed))) return 0;
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

  // ------------------------------------------------------------ runaway guard
  // Main watches Claude/OpenCode transcripts for a tile looping, burning tokens or piling up
  // subagents and sends 'runaway'; 'time' (busy too long with no break) is checked here.

  const RUNAWAY_TEXT = { loop: '⚠ looping', tokens: '⚠ tokens', subagents: '⚠ subagents' };
  function setRunawayBadge(w) {
    const el = w.el.querySelector('.runaway');
    if (!el) return;
    if (!w.runaway) { el.textContent = ''; el.title = ''; el.className = 'runaway'; return; }
    const { reason, detail } = w.runaway;
    el.textContent = reason === 'time' ? `⚠ ${cfg.runawayMinutes} min` : (RUNAWAY_TEXT[reason] || '⚠');
    el.className = 'runaway' + (reason === 'time' ? ' time' : '');
    el.title = `${detail} · click to stop`;
  }

  function isClaudeTile(w) {
    if (!/^[0-9a-f-]{36}$/i.test(w.sessionId || '')) return false;
    const agent = cfg.agents.find(a => a.id === w.agentConf);
    return !!agent && /claude/i.test(agent.command || '');
  }

  // Stops whatever the tile is doing without ending its session. Returns how it was stopped.
  function stopTile(w) {
    if (w.runaway) { w.runaway = null; setRunawayBadge(w); }
    if (w.kind === 'agent') { const parent = sessionWin.get(w.sessionId); if (parent) return stopTile(parent); return null; }
    if (isClaudeTile(w)) { operant.writePty(w.ptyId, '\x1b'); return 'esc'; }
    if (String(w.sessionId || '').startsWith('oc:')) { operant.abortOpenCode(w.ptyId); return 'abort'; }
    if (w.ptyId) { operant.writePty(w.ptyId, '\x03'); return 'ctrl-c'; }
    return null;
  }

  function flagRunaway(w, reason, detail) {
    w.runaway = { reason, detail };
    setRunawayBadge(w);
    if (cfg.runawayGuard === 'stop') {
      const how = stopTile(w);
      notify(w, `${w.agentName} may be running away`, `${detail}${how ? ' · stopped it' : ''}`);
      if (how) toast(`Stopped <b>${esc(w.title)}</b> · ${esc(detail)}`);
    } else {
      notify(w, `${w.agentName} may be running away`, detail);
    }
  }

  operant.on('runaway', ({ sessionId, reason, detail }) => {
    if (cfg.runawayGuard === 'off') return;
    const w = sessionWin.get(sessionId);
    if (!w || !w.alive) return;
    flagRunaway(w, reason, detail);
  });

  // 'time': a tile busy without a break, checked here (main only sees the loop/tokens/subagents reasons).
  setInterval(() => {
    if (cfg.runawayGuard === 'off' || !cfg.runawayMinutes) return;
    const now = Date.now();
    for (const w of wins.values()) {
      if (w.kind !== 'ai' || !w.busySince || w.runaway) continue;
      if (now - w.busySince >= cfg.runawayMinutes * 60000) flagRunaway(w, 'time', `Working without a break for ${cfg.runawayMinutes} min`);
    }
  }, 60000);

  // ------------------------------------------------------------ permission prompts (plan item 44)
  // Claude Code's confirm box ("Do you want to proceed?" / "...make this edit" / "...create", with
  // numbered 1. Yes / 2. Yes and don't ask again / 3. No) is spotted in the tile's own screen, not
  // scrollback. OpenCode tiles get a real event instead (permission.asked/replied, forwarded from
  // opencode.js). Either way the tile is marked "waiting for you" and notified once per prompt; if
  // the same kind of thing keeps asking, the notification offers to show the rule to add.

  const waitingCounts = new Map(); // key (cwd+kind+detail) -> how many times this session
  const CLAUDE_QUESTION_RE = /Do you want to (?:proceed|make this edit|create)\b[^\n?]*\?/i;

  function setWinWaiting(w, has) {
    if (has === !!w.waitingEl) return;
    w.waitingEl = has;
    w.el.classList.toggle('waiting', has);
    const el = w.el.querySelector('.waiting');
    if (el) { el.textContent = has ? 'waiting for you' : ''; el.title = has ? 'This tile is waiting on a permission prompt' : ''; }
    refreshStats();
  }
  function clearWaiting(w) {
    if (!w.waitingPrompt) return;
    w.waitingPrompt = null;
    setWinWaiting(w, false);
  }
  // Fires once per distinct prompt (a new key), never on every scan tick while the same one sits there.
  function setWaiting(w, kind, label, detail, key, extra) {
    if (w.waitingPrompt && w.waitingPrompt.key === key) { if (extra?.id) w.waitingPrompt.id = extra.id; return; }
    w.waitingPrompt = { kind, label, detail, key, id: extra?.id || null };
    setWinWaiting(w, true);
    const count = (waitingCounts.get(key) || 0) + 1;
    waitingCounts.set(key, count);
    const action = count >= 3 ? buildAlwaysAllowAction(w, kind, label, detail, key, count, extra) : null;
    notify(w, `${w.agentName} is waiting for you`, `${label}${detail ? ': ' + detail : ''}`, action);
  }

  // Best-effort rule text; the user reviews and saves it themselves, Operant never writes it.
  function claudeRuleFor(label, detail) {
    if (/^bash/i.test(label)) {
      const prefix = String(detail || '').trim().split(/\s+/)[0];
      return prefix ? `Bash(${prefix} *)` : null;
    }
    if (/^edit/i.test(label)) return 'Edit';
    if (/^(write|create)/i.test(label)) return 'Write';
    return null;
  }
  function buildAlwaysAllowAction(w, kind, label, detail, key, count, extra) {
    if (kind === 'opencode') {
      if (!extra?.rule) return null;
      const filePath = resolvePath(extra.dir || w.cwd || lastCwd, 'opencode.json');
      return { label: 'Always allow…', filePath,
        rule: `"permission": { "${label}": { "${extra.rule}": "allow" } }`,
        note: `${w.agentName} has asked for "${label}" ${count}+ times. Merge this into opencode.json's "permission" block, then save.` };
    }
    const rule = claudeRuleFor(label, detail);
    if (!rule) return null;
    const filePath = resolvePath(w.cwd || lastCwd, '.claude', 'settings.local.json');
    return { label: 'Always allow…', filePath,
      rule: `"permissions": { "allow": ["${rule}"] }`,
      note: `Claude has asked to ${label.toLowerCase()} ${count}+ times. Merge this into .claude/settings.local.json, then save.` };
  }
  async function showAlwaysAllowCard(id) {
    const n = notifLog.find(x => x.id === id);
    if (!n?.action) return;
    const { rule, filePath, note } = n.action;
    const r = await operant.ask({ message: 'Always allow this?', detail: `${note}\n\n${rule}`, buttons: ['Open settings file', 'Not now'], cancelId: 1 });
    if (r !== 0) return;
    closePanels();
    await openEditor(filePath, { ws: current });
    toast("Add the rule and save it yourself — Operant never writes permission rules.");
  }

  // Last N raw lines without walking the whole scrollback (rawLines() does, fine for on-demand reads
  // but too much for a scan running several times a second on every busy Claude tile).
  function lastScreenLines(w, n) {
    if (!w.term) return [];
    const buf = w.term.buffer.active, len = buf.length, start = Math.max(0, len - n);
    const rows = [];
    for (let i = start; i < len; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? '');
    return rows;
  }
  // Claude: scan the tile's own screen (not scrollback) for the confirm box, throttled per tile.
  function claudePromptInLast(w) {
    const lines = lastScreenLines(w, 24);
    const qi = lines.findIndex(l => CLAUDE_QUESTION_RE.test(l));
    if (qi === -1) return null;
    const after = lines.slice(qi, Math.min(lines.length, qi + 6)).join('\n');
    if (!/\b1\.\s*Yes\b/i.test(after) || !/\bNo\b/i.test(after)) return null;
    const box = [];
    for (let i = qi - 1; i >= Math.max(0, qi - 14); i--) {
      if (/^[╭╮╰╯─═]+$/.test(lines[i].trim())) break;
      const t = lines[i].replace(/^[│┃|]\s?|\s?[│┃|]$/g, '').trim();
      if (t) box.unshift(t);
    }
    return { label: box[0] || 'permission', detail: box.slice(1).find(Boolean) || '' };
  }
  function checkClaudeWaiting(w) {
    if (!isClaudeTile(w)) return;
    const found = claudePromptInLast(w);
    if (found) setWaiting(w, 'claude', found.label, found.detail, `${w.cwd}::${found.label}::${found.detail.split(/\s+/)[0] || ''}`);
    else if (w.waitingPrompt?.kind === 'claude') clearWaiting(w);
  }

  // OpenCode: a real event (from opencode.js's SSE listener), so no scanning needed.
  operant.on('oc-permission', ({ ptyId, id, permission, patterns, always, metadata }) => {
    const w = ptyWins.get(ptyId);
    if (!w || !w.alive) return;
    const label = permission || 'permission';
    const detail = String((metadata && (metadata.command || metadata.description)) || (patterns && patterns[0]) || '');
    const key = `${w.cwd}::oc::${label}::${(always && always[0]) || detail}`;
    setWaiting(w, 'opencode', label, detail, key, { id, rule: always && always[0], dir: w.cwd });
  });
  operant.on('oc-permission-cleared', ({ ptyId, id }) => {
    const w = ptyWins.get(ptyId);
    if (w?.waitingPrompt?.id === id) clearWaiting(w);
  });

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
    if (cfg.moveFollowsTile) {
      switchWorkspace(i);
      focusWin(f);
    } else {
      const n = wins.get(wsWins(from).at(-1)?.id);
      if (n) focusWin(n);
    }
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
    openBrowser: () => openBrowser(),
    close: () => requestClose(focused()),
    fullscreen: toggleFullscreen,
    toggleSplit,
    closeDoneAgents,
    stopAgent: () => { const w = focused(); if (w) stopTile(w); },
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
    openConfig: () => openConfig(),
    focusSidebar: () => focusSidebar(),
    devtools: () => operant.devtools(),
    mediaPlayPause: () => operant.media('toggle'),
    mediaNext: () => operant.media('next'),
    mediaPrev: () => operant.media('prev'),
    mediaShuffle: () => operant.media('shuffle'),
    tokenUsage: () => togglePanel('usage'),
    quickOpen: () => openPicker('files'),
    commandPalette: () => openPicker('commands'),
    findInView: () => openFind(focused()),
    showChanges: () => showChanges(),
    saveQuit: () => saveAndQuit(),
    notifications: () => togglePanel('notifications'),
  };
  // Only for viewer and diff tiles: anywhere else the key goes on to the terminal as usual.
  const VIEW_ONLY = new Set(['findInView']);
  const forView = () => ['view', 'diff'].includes(focused()?.kind);
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
    const bound = bindMap.get(eventCombo(e));
    if (bound && !VIEW_ONLY.has(bound)) return false;
    // Windows-style clipboard: Ctrl+C copies when there's a selection, Ctrl+V pastes.
    if (e.ctrlKey && !e.altKey && e.code === 'KeyC' && w.term.hasSelection()) {
      navigator.clipboard.writeText(w.term.getSelection()); w.term.clearSelection(); return false;
    }
    if (e.ctrlKey && !e.altKey && e.code === 'KeyV' && w.ptyId) {
      pasteClipboard(w); e.preventDefault(); return false;
    }
    // Alt+V (Claude Code's image-paste key on Windows) isn't bound to anything, so it already
    // falls through to the terminal as a normal key.
    return true;
  }
  // An image on the clipboard (and no text) is sent through as Ctrl+V so the agent CLI reads it
  // itself, the way it would in Windows Terminal, instead of us typing clipboard text.
  async function pasteClipboard(w) {
    let img = false;
    try { img = await operant.clipboardHasImage(); } catch {}
    if (img) { operant.writePty(w.ptyId, '\x16'); return; }
    const t = await navigator.clipboard.readText();
    if (t) w.term.paste(t);
  }

  // A file dropped anywhere outside a tile's own drop handler would otherwise navigate the window to it.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  window.addEventListener('keydown', e => {
    if (recording) { e.preventDefault(); e.stopPropagation(); return recordKey(e); }
    const panel = openPanel();
    if (e.key === 'Escape' && panel) { closePanels(); e.preventDefault(); return; }
    if (panel === 'launcher' && !e.ctrlKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
      e.preventDefault(); return launch(+e.code.at(-1) - 1, e.shiftKey);
    }
    // Typing in a text box (a workspace or group name, a search) never sets off a shortcut.
    const t = e.target;
    if (t?.matches?.('input, textarea, select, [contenteditable="true"]') && !t.classList.contains('xterm-helper-textarea')) return;
    const action = bindMap.get(eventCombo(e));
    if (!action) return;
    if (VIEW_ONLY.has(action) && !forView()) return;
    // With a panel open only the panel keys work, so nothing happens to the tiles behind it.
    if (panel && !['help', 'settings', 'pickAgent', 'tokenUsage', 'quickOpen', 'commandPalette'].includes(action)) return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat || action.startsWith('resize')) actions[action]();
  }, true);
  // Stop a lone Alt press from doing anything odd in the frameless window.
  window.addEventListener('keyup', e => { if (e.key === 'Alt') e.preventDefault(); }, true);

  // ------------------------------------------------------------ panels

  const PANELS = ['keys', 'settings', 'launcher', 'usage', 'picker', 'quickmenu', 'notifications'];
  const openPanel = () => PANELS.find(p => !$('#' + p).classList.contains('hidden'));
  function togglePanel(name) {
    if (name === 'picker') return openPicker(pick.mode || 'commands');
    const was = openPanel();
    closePanels(was === name);
    if (was === name) return;
    if (name === 'keys') { keysTarget = $('#keys-body'); renderKeys(); }
    else if (name === 'launcher') renderLauncher();
    else if (name === 'usage') { usageHover = -1; renderUsage(); }
    else if (name === 'quickmenu') { drawGitButton(); drawTeamSliders(); }
    else if (name === 'notifications') { renderNotifications(); markAllNotifsRead(); }
    else renderSettings();
    $('#' + name).classList.remove('hidden');
    $('#' + name + ' .card-body').scrollTop = 0;
    document.activeElement?.blur();
  }
  function closePanels(refocus = true) {
    recording = null;
    welcome = null; // dismissed without choosing: ask again next start
    PANELS.forEach(p => $('#' + p).classList.add('hidden'));
    if (refocus) focusKeys(focused());
  }
  for (const p of PANELS) {
    $('#' + p).addEventListener('mousedown', e => { if (e.target.id === p) closePanels(); });
    const closeBtn = $('#' + p).querySelector('[data-close]');
    if (closeBtn) closeBtn.onclick = () => closePanels();
  }
  $('#btn-keys').onclick = () => togglePanel('keys');
  $('#btn-new').onclick = () => togglePanel('launcher');
  $('#btn-gear').onclick = () => togglePanel('quickmenu');
  $('#btn-notifs').onclick = () => togglePanel('notifications');
  $('#qm-settings').onclick = () => togglePanel('settings');
  $('#btn-save-quit').onclick = () => { closePanels(); saveAndQuit(); };
  // Quick menu sliders for team mode: how many workers may run at once, and the highest tier they may use.
  const tierNames = () => Object.keys(cfg.team?.tiers || {});
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  function drawTeamSliders() {
    const names = tierNames(), team = cfg.team || {};
    const ti = names.includes(team.maxTier) ? names.indexOf(team.maxTier) : names.length - 1;
    $('#qm-workers').value = team.maxWorkers || 4;
    $('#qm-workers-val').textContent = team.maxWorkers || 4;
    $('#qm-tier').max = Math.max(0, names.length - 1);
    $('#qm-tier').value = ti;
    $('#qm-tier-val').textContent = names[ti] ? cap(names[ti]) : '-';
  }
  $('#qm-workers').oninput = e => { setSetting('team', { ...(cfg.team || {}), maxWorkers: +e.target.value }); drawTeamSliders(); };
  $('#qm-tier').oninput = e => { const n = tierNames()[+e.target.value]; if (n) setSetting('team', { ...(cfg.team || {}), maxTier: n }); drawTeamSliders(); };

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
    if (key === 'mediaControls' || key === 'mediaSize') renderMedia();
    if (key === 'tokenUsage' || key === 'usageSeries' || key === 'tokenBudget') { renderUsagePill(); drawUsage(); }
    if (key.startsWith('clock')) tick();
    if (key === 'barTitle' || key === 'workspaceNames') { refreshBar(); renderHints(); }
    if (key === 'gitButton') drawGitButton();
    if (key === 'sidebarHiddenFiles') dirCache.clear();
    if (key === 'gpuTerminals') for (const w of wins.values()) gpu(w);
    if (key === 'hardwareAcceleration') toast('Hardware acceleration changes when Operant restarts');
    if (key === 'sidebarGit') { if (cfg.sidebarGit) loadGit(true); else decorateGit(); }
    if (key === 'planLimits' || key === 'planLimitAlerts') renderUsagePill();
    if (key === 'editor' || key === 'editorCommand') refreshEditorName();
    if (key === 'tileTokens' || key === 'contextBadge') for (const w of wins.values()) if (w.alive) { renderIbar(w); scheduleFit(w, 0); }
    if (key === 'defaultAgent' && !cfg.agentChosen) { cfg.agentChosen = true; save({ agentChosen: true }); }
    applyAppearance();
  }
  let updateStatus = null;
  const renderSettings = () => Panels.renderSettings($('#settings-body'), cfg, setSetting, operant.pickFolder, {
    renderKeys: el => { keysTarget = el; renderKeys(); },
    renderCodegraph,
    renderMemory,
    update: () => ({ version, status: updateStatus }),
    checkUpdate: () => operant.checkUpdate(),
    installUpdate: () => operant.installUpdate(),
    openReleases: () => operant.openReleases(),
    openLogFolder: () => operant.openLogFolder(),
    openLink: (url, second) => operant.openLink(url, second),
    renderTokenBreakdown,
  });
  // Settings › Usage › "Where tokens go" (item 39): per project/tile totals, the biggest single
  // turns, files read more than 3 times in a session, and each session's fixed first-turn overhead.
  // Computed fresh from ~/.claude/projects on demand (tab open or range switch), not kept running.
  let tbDays = 1, tbData = null, tbLoading = false;
  async function renderTokenBreakdown(el) {
    const cause = c => c ? `<span class="tok-cause">${esc(c)}</span>` : '';
    const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    function draw() {
      if (!tbData) { el.innerHTML = `<div class="usage-empty">${tbLoading ? 'Adding it up…' : 'Loading…'}</div>`; return; }
      const d = tbData;
      const bars = (list, key) => {
        const max = Math.max(1, ...list.map(x => x[key]));
        return list.slice(0, 12).map(x => `<div class="up-row"><span class="up-nm" title="${esc(x.label || x.name || x.key)}">${esc(x.label || x.name || x.key)}</span>`
          + `<span class="up-bar"><i style="width:${(x[key] / max * 100).toFixed(1)}%"></i></span><span class="up-val">${fmtTok(x[key])}</span></div>`).join('');
      };
      el.innerHTML = `<div class="tok-seg seg">${[[1, 'Today'], [7, '7 days']].map(([n, l]) =>
        `<button class="${n === tbDays ? 'on' : ''}" data-tbdays="${n}">${l}</button>`).join('')}</div>`
        + `<div class="tok-section"><h4>By project</h4>${d.projects.length ? bars(d.projects, 'paid') : '<div class="hint">Nothing yet.</div>'}</div>`
        + `<div class="tok-section"><h4>By tile</h4>${d.tiles.length ? bars(d.tiles, 'paid') : '<div class="hint">Nothing yet.</div>'}</div>`
        + `<div class="tok-section"><h4>Biggest single turns</h4>${d.biggestTurns.length ? d.biggestTurns.map(t =>
          `<div class="tok-row"><span class="tok-tok">${fmtTok(t.tokens)}</span><span class="tok-nm">${esc(t.tile)}</span>${cause(t.cause)}<span class="tok-when">${when(t.time)}</span></div>`).join('')
          : '<div class="hint">Nothing yet.</div>'}</div>`
        + `<div class="tok-section"><h4>Files read more than 3 times in a session</h4>${d.repeatedReads.length ? d.repeatedReads.map(r =>
          `<div class="tok-row"><span class="tok-tok">${r.count}×</span><span class="tok-nm">${esc(r.file)}</span><span class="tok-cause">${esc(r.label)}</span></div>`).join('')
          : '<div class="hint">No repeated reads.</div>'}</div>`
        + `<div class="tok-section"><h4>Fixed overhead per session</h4><span class="hint">First turn's input + cache write — system prompt, CLAUDE.md, memory, skills, MCP tools · flagged past 20k</span>${d.overhead.length ? d.overhead.map(o =>
          `<div class="tok-row${o.big ? ' tok-flag' : ''}"><span class="tok-tok">${fmtTok(o.tokens)}</span><span class="tok-nm">${esc(o.label)}</span>${o.big ? '<span class="tok-cause">large — check Settings for unused skills/MCP servers</span>' : ''}</div>`).join('')
          : '<div class="hint">Nothing yet.</div>'}</div>`;
      el.querySelectorAll('[data-tbdays]').forEach(b => b.onclick = () => { tbDays = +b.dataset.tbdays; load(); });
    }
    async function load() {
      tbLoading = true; tbData = null; draw();
      const d = await operant.usageBreakdown({ days: tbDays });
      tbLoading = false;
      if (el.isConnected) { tbData = d; draw(); }
    }
    draw();
    if (!tbData) load();
  }
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
  // Settings › Memory: every remembered fact (this project's, then global), edit opens it in the
  // editor tile, ✕ deletes it.
  async function renderMemory(el) {
    const cwd = barProject();
    const r = await operant.memory('list', { cwd });
    const facts = r.ok ? r.result : [];
    const row = f => `<div class="update-card" data-mem="${esc(f.path)}"><span class="uc-logo">${f.scope === 'global' ? '◇' : '✎'}</span>`
      + `<div class="uc-main"><div class="uc-name">${esc(f.name)} <span class="uc-status">[${esc(f.type)}]</span></div>`
      + `<div class="uc-status">${esc(f.description)}</div></div>`
      + `<button class="btn" data-mem-edit>Edit</button><button class="btn" data-mem-del>Delete</button></div>`;
    el.innerHTML = facts.length ? facts.map(row).join('') : '<div class="cg-note">No facts remembered yet. Agents save them with <code>operant remember</code>.</div>';
    el.querySelectorAll('[data-mem]').forEach(card => {
      const f = facts.find(x => x.path === card.dataset.mem);
      card.querySelector('[data-mem-edit]').onclick = () => { closePanels(false); openEditor(f.path); };
      card.querySelector('[data-mem-del]').onclick = async () => {
        await operant.memory('delete', { dir: f.dir, file: f.file });
        renderMemory(el);
      };
    });
  }
  // config.json opens with Windows, or in the editor tile (Settings › Files).
  async function openConfig() {
    if (cfg.configOpensIn !== 'editor') return operant.openConfig();
    closePanels(false);
    openEditor(await operant.configPath());
  }
  $('#set-json').onclick = () => openConfig();
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

  // ------------------------------------------------------------ pickers
  // Quick open (a file from the projects, by part of its name) and the command palette (every action
  // and setting), in one box: type to filter, ↑↓ or Ctrl+J/K to move, Enter to run.

  const pickInput = $('#picker-input'), pickBody = $('#picker-body');
  let pick = { mode: null, items: [], shown: [], k: 0 };

  // How well a query matches a text: its letters in order, more for runs and word starts; -1 if not all there.
  function fuzzy(q, t) {
    t = t.toLowerCase();
    let ti = 0, s = 0, last = -2;
    for (const ch of q) {
      const i = t.indexOf(ch, ti);
      if (i < 0) return -1;
      s += i === last + 1 ? 3 : 1;
      if (i === 0 || /[\\/ ._\-·]/.test(t[i - 1])) s += 2;
      last = i; ti = i + 1;
    }
    return s - t.length * 0.01;
  }

  async function openPicker(mode) {
    if (openPanel() === 'picker' && pick.mode === mode) return closePanels();
    if (openPanel()) closePanels(false);
    pick = { mode, items: [], shown: [], k: 0 };
    pickInput.value = '';
    pickInput.placeholder = mode === 'files' ? 'Open a file by name…' : 'Run an action or change a setting…';
    $('#picker-foot').textContent = mode === 'files' ? 'Enter views it · Shift+Enter edits it · Esc closes' : 'Enter runs it · Esc closes';
    $('#picker').classList.remove('hidden');
    pickInput.focus();
    if (mode === 'commands') pick.items = commandItems();
    else { pickBody.innerHTML = '<div class="side-empty">Listing files…</div>'; pick.items = await fileItems(); }
    if (openPanel() === 'picker' && pick.mode === mode) filterPicker();
  }

  async function fileItems() {
    const f = focused(), here = f?.cwd ? projectDir(f.cwd) : null;
    const rootsList = [...new Set([here, ...allProjects(), ...tileDirs().map(projectDir)].filter(Boolean).map(p => p.replace(/[\\/]+$/, '')))];
    const lists = await Promise.all(rootsList.map(r => operant.listFiles(r).catch(() => [])));
    const items = [];
    rootsList.forEach((root, i) => {
      for (const rel of lists[i]) {
        const name = rel.split('/').pop(), full = root + '\\' + rel.replace(/\//g, '\\');
        items.push({ label: name, sub: `${baseName(root)} · ${rel.slice(0, -name.length - 1) || '.'}`, text: rel, bonus: i === 0 && here ? 1 : 0,
          run: () => openViewer(full), alt: () => openEditor(full) });
      }
    });
    return items;
  }

  function commandItems() {
    const items = [];
    for (const [group, acts] of Panels.GROUPS) for (const [a, name] of Object.entries(acts)) {
      if (a === 'commandPalette' || !actions[a]) continue;
      items.push({ label: name, sub: group, text: `${name} ${group}`, key: bindLabel(a), run: actions[a] });
    }
    for (let i = 1; i <= WS_COUNT; i++) items.push({ label: `Go to ${wsName(i - 1) || `workspace ${i}`}`, sub: 'Workspaces', text: `go to workspace ${i} ${wsName(i - 1)}`, key: `Alt+${i}`, run: () => switchWorkspace(i - 1) });
    for (const it of Panels.settingsIndex()) {
      const toggle = it.type === 'toggle';
      items.push({ label: toggle ? `${cfg[it.key] ? 'Turn off' : 'Turn on'}: ${it.label}` : it.label, sub: `Setting · ${it.tab}`, text: `${it.label} ${it.tab} setting`,
        run: toggle ? () => setSetting(it.key, !cfg[it.key]) : () => { togglePanel('settings'); Panels.showSetting(it.label); renderSettings(); } });
    }
    return items;
  }

  function filterPicker() {
    const q = pickInput.value.trim().toLowerCase().replace(/\s+/g, ' ');
    let shown;
    if (!q) shown = pick.items.slice(0, 60);
    else {
      const scored = [];
      for (const it of pick.items) {
        const s = Math.max(fuzzy(q, it.label) * 2, fuzzy(q, it.text));
        if (s >= 0) scored.push([s + (it.bonus || 0) * 5, it]);
      }
      shown = scored.sort((a, b) => b[0] - a[0]).slice(0, 60).map(x => x[1]);
    }
    pick.shown = shown; pick.k = 0;
    pickBody.innerHTML = shown.length ? shown.map((it, i) => `<button class="pick-row" data-i="${i}"><span class="nm">${esc(it.label)}<small>${esc(it.sub)}</small></span>`
      + (it.key ? `<kbd>${esc(Panels.pretty(it.key))}</kbd>` : '') + '</button>').join('')
      : `<div class="side-empty">${pick.items.length ? 'Nothing matches' : pick.mode === 'files' ? 'No files. Pin a project in the sidebar first.' : ''}</div>`;
    markPick();
  }
  function markPick() {
    pickBody.querySelectorAll('.pick-row').forEach((r, i) => r.classList.toggle('on', i === pick.k));
    pickBody.querySelector('.pick-row.on')?.scrollIntoView({ block: 'nearest' });
  }
  function runPick(i, alt) {
    const it = pick.shown[i];
    if (!it) return;
    closePanels(false);
    (alt && it.alt ? it.alt : it.run)();
  }
  pickInput.addEventListener('input', filterPicker);
  pickInput.addEventListener('keydown', e => {
    const move = e.key === 'ArrowDown' || (e.ctrlKey && e.code === 'KeyJ') ? 1 : e.key === 'ArrowUp' || (e.ctrlKey && e.code === 'KeyK') ? -1 : 0;
    if (move) { e.preventDefault(); if (pick.shown.length) { pick.k = (pick.k + move + pick.shown.length) % pick.shown.length; markPick(); } }
    else if (e.key === 'Enter') { e.preventDefault(); runPick(pick.k, e.shiftKey || e.ctrlKey); }
  });
  pickBody.addEventListener('click', e => { const r = e.target.closest('.pick-row'); if (r) runPick(+r.dataset.i, e.shiftKey || e.ctrlKey); });

  // ------------------------------------------------------------ bar

  const wsBar = $('#workspaces');
  let wsEditing = null; // the workspace whose name is being typed in the bar
  function refreshBar() {
    if (wsEditing == null) drawWorkspaces();
    drawBarTitle();
    drawGitButton();
    refreshStats();
    sidebarChanged();
    saveSession();
  }
  function drawBarTitle() {
    const f = focused(), el = $('#bar-title'), t = f ? f.title : '';
    if (el.textContent !== t) el.textContent = t;
    el.classList.toggle('hidden', !cfg.barTitle || !f);
  }

  // Git button: the focused tile's project (or the first pinned project), redrawn only when its
  // project or status actually changes. Reuses the sidebar's git cache, fetching it here if the
  // project isn't pinned/visible there.
  let barGitSig = '';
  const barGitPending = new Set();
  function barProject() {
    const f = focused();
    return (f?.cwd ? projectDir(f.cwd) : null) || allProjects()[0] || null;
  }
  async function fetchBarGit(p) {
    if (barGitPending.has(p)) return;
    barGitPending.add(p);
    gitState.set(p, { at: Date.now(), status: await operant.gitStatus(p) });
    barGitPending.delete(p);
    drawGitButton();
  }
  function drawGitButton() {
    const btn = $('#git-pill');
    const p = cfg.gitButton ? barProject() : null;
    if (p && !gitState.has(p)) fetchBarGit(p);
    const st = p && gitState.get(p)?.status;
    const sig = JSON.stringify([p, st]);
    if (sig === barGitSig) return;
    barGitSig = sig;
    btn.classList.toggle('hidden', !cfg.gitButton);
    if (!st) {
      btn.disabled = true;
      btn.innerHTML = `<span class="qm-ico">⎇</span><span class="qm-lbl">No repo</span>`;
      btn.title = 'Focus a tile inside a git repo to see its changes';
      delete btn.dataset.dir;
      return;
    }
    btn.disabled = false;
    const n = gitChanges(p);
    const sync = [st.ahead ? `↑${st.ahead}` : '', st.behind ? `↓${st.behind}` : ''].filter(Boolean).join(' ');
    btn.innerHTML = `<span class="qm-ico">⎇</span><span class="qm-lbl">${esc(st.branch)}${n ? ` · ${n}` : ''}</span>`;
    btn.title = `${baseName(p)} · ⎇ ${st.branch} · ${n} changed${sync ? ' · ' + sync : ''} · click to see and commit`;
    btn.dataset.dir = p;
  }
  $('#git-pill').onclick = () => { const dir = $('#git-pill').dataset.dir; closePanels(); showChanges(dir); };

  // The workspace buttons are rebuilt only when something they show has changed.
  let wsSig = '';
  function drawWorkspaces(force = false) {
    const sig = JSON.stringify([current, cfg.workspaceNames, workspaces.map((_, i) => { const l = wsWins(i); return [l.length, l.some(isWorking)]; })]);
    if (sig === wsSig && !force) return;
    wsSig = sig;
    wsBar.innerHTML = '';
    for (let i = 0; i < WS_COUNT; i++) {
      const list = wsWins(i), name = wsName(i);
      if (i > 4 && !list.length && i !== current) continue;
      const b = document.createElement('button');
      b.className = 'ws-btn' + (i === current ? ' active' : '') + (list.length ? ' occupied' : '')
        + (list.some(isWorking) ? ' busy' : '') + (name && i === current ? ' named' : '');
      b.textContent = name && i === current ? `${i + 1} · ${name}` : i + 1;
      b.title = `${name || `Workspace ${i + 1}`}${list.length ? ` · ${list.length} tile${list.length === 1 ? '' : 's'}` : ''}
Double-click to ${name ? 'rename' : 'name'} it`;
      b.dataset.ws = i;
      b.onclick = () => { wsClicked = i; switchWorkspace(i); };
      wsBar.appendChild(b);
    }
  }
  // The first click of a double-click switches workspace and resizes the buttons, so the second
  // can land on a neighbour: the one named is the one first clicked.
  let wsClicked = null;
  wsBar.addEventListener('dblclick', e => { if (e.target.closest('.ws-btn') && wsClicked != null) editWsName(wsClicked); });

  // Workspace names: double-click a workspace in the bar, Enter keeps it, Esc cancels, empty clears it.
  const wsName = i => String(cfg.workspaceNames?.[i] || '').trim();
  function editWsName(i) {
    wsEditing = i;
    drawWorkspaces(true);
    const input = document.createElement('input');
    input.className = 'ws-name'; input.value = wsName(i); input.placeholder = `Workspace ${i + 1}`; input.spellcheck = false; input.maxLength = 40;
    const btn = wsBar.querySelector(`[data-ws="${i}"]`);
    if (btn) wsBar.replaceChild(input, btn); else wsBar.appendChild(input);
    input.focus(); input.select();
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true; wsEditing = null; wsSig = '';
      if (keep) {
        const names = Array.from({ length: WS_COUNT }, (_, j) => wsName(j));
        names[i] = input.value.trim();
        while (names.length && !names.at(-1)) names.pop();
        setSetting('workspaceNames', names);
        renderHints();
      }
      refreshBar();
      focusKeys(focused());
    };
    input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(e.key === 'Enter'); } };
    input.onblur = () => finish(true);
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
    const waiting = all.filter(w => w.waitingPrompt).length;
    const html = `◆ <span class="run">${agRun + aiRun} running</span> · <span class="idle">${ai.length - aiRun} idle</span> · <span class="ok">${ag.length - agRun} done</span>${waiting ? ` · <span class="warn">${waiting} waiting</span>` : ''}`;
    if (html !== lastStats) $('#stat-agents').innerHTML = lastStats = html;
  }
  // Working state changes without any other event, so redraw the bar when a workspace's busy dot would.
  setInterval(() => {
    const busy = workspaces.map((_, i) => wsWins(i).some(isWorking) ? 1 : 0).join('');
    if (busy !== lastBusy) { lastBusy = busy; refreshBar(); } else refreshStats();
  }, 1000);

  function toast(html, onClick, duration = 5000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    t.onclick = () => { onClick?.(); t.remove(); };
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, duration);
  }
  // Copy-on-select's toast: quick, and at most once a second (a drag can fire several mouseups).
  let lastCopyToast = 0;
  // Copy on select in the viewer and diff tiles: a text selection wholly inside the tile, not an
  // image drag (which makes no text selection) or one that spills into another tile.
  function copySelection(w) {
    if (!cfg.copyOnSelect) return;
    const sel = window.getSelection(), text = sel.toString();
    if (!text || !sel.rangeCount) return;
    if (!w.page.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    navigator.clipboard.writeText(text);
    toastCopied();
  }
  function toastCopied() {
    const now = Date.now();
    if (now - lastCopyToast < 1000) return;
    lastCopyToast = now;
    toast('Copied', null, 1200);
  }
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // ------------------------------------------------------------ clock
  // Time and date in the middle of the bar, formatted as Settings › Top bar says. Hover it for
  // this month's calendar, click it to copy the time and date.

  const clockEl = $('#clock'), calEl = $('#cal');
  function clockText(d = new Date()) {
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(cfg.clockSeconds ? { second: '2-digit' } : {}),
      ...(cfg.clockFormat === '24' ? { hourCycle: 'h23' } : cfg.clockFormat === '12' ? { hourCycle: 'h12' } : {}) });
    return cfg.clockDate ? `${t}  ·  ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : t;
  }
  // The date is its own span so a narrow window can drop it.
  const tick = () => {
    const [t, d] = clockText().split('  ·  ');
    const html = esc(t) + (d ? `<span class="dt">  ·  ${esc(d)}</span>` : '');
    if (clockEl.innerHTML !== html) clockEl.innerHTML = html;
  };
  tick(); setInterval(tick, 1000);
  clockEl.onclick = () => {
    const d = new Date();
    navigator.clipboard.writeText(`${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} ${clockText(d).split('  ·  ')[0]}`);
    toast('Copied the time and date');
  };

  let calMonth = null, calShowT = null, calHideT = null; // calMonth: first of the month shown
  const isoWeek = d => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 3 - (t.getUTCDay() + 6) % 7);
    return 1 + Math.floor((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 / 7);
  };
  function drawCal() {
    const today = new Date(), m = calMonth;
    const lead = (m.getDay() + 6) % 7; // weeks start on Monday
    const dows = Array.from({ length: 7 }, (_, k) => new Date(2024, 0, 1 + k).toLocaleDateString([], { weekday: 'narrow' }));
    let cells = dows.map(d => `<span class="dow">${esc(d)}</span>`).join('');
    for (let k = 0; k < 42; k++) {
      const d = new Date(m.getFullYear(), m.getMonth(), 1 - lead + k);
      const cls = ['d', d.getMonth() !== m.getMonth() ? 'out' : '', d.toDateString() === today.toDateString() ? 'today' : ''].filter(Boolean).join(' ');
      cells += `<span class="${cls}">${d.getDate()}</span>`;
    }
    calEl.innerHTML = `<div class="cal-head"><button data-cal="-1" title="Previous month">‹</button><b>${esc(m.toLocaleDateString([], { month: 'long', year: 'numeric' }))}</b>`
      + `<button data-cal="1" title="Next month">›</button></div><div class="cal-grid">${cells}</div>`
      + `<div class="cal-foot">${esc(today.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))} · week ${isoWeek(today)}</div>`;
    calEl.querySelectorAll('[data-cal]').forEach(b => b.onclick = () => { calMonth = new Date(m.getFullYear(), m.getMonth() + +b.dataset.cal, 1); drawCal(); });
  }
  function showCal() {
    clearTimeout(calHideT);
    if (!calEl.classList.contains('hidden')) return;
    const t = new Date(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    drawCal();
    calEl.classList.remove('hidden');
    const r = clockEl.getBoundingClientRect();
    calEl.style.left = Math.max(6, Math.min(innerWidth - calEl.offsetWidth - 6, r.left + r.width / 2 - calEl.offsetWidth / 2)) + 'px';
    calEl.style.top = r.bottom + 6 + 'px';
  }
  const hideCal = (delay = 200) => { clearTimeout(calShowT); clearTimeout(calHideT); calHideT = setTimeout(() => calEl.classList.add('hidden'), delay); };
  clockEl.onmouseenter = () => { clearTimeout(calHideT); calShowT = setTimeout(showCal, 350); };
  clockEl.onmouseleave = () => hideCal();
  calEl.onmouseenter = () => clearTimeout(calHideT);
  calEl.onmouseleave = () => hideCal();
  window.addEventListener('blur', () => hideCal(0));
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
    const count = project ? tileDirs().filter(d => isUnder(d, p)).length : 0;
    const cls = ['node-row', entry.dir ? 'dir' : 'file', open ? 'open' : '', project ? 'project' : '',
      project && isActive(p) ? 'active' : '', selected && normPath(selected) === normPath(p) ? 'sel' : '', gitClass(p, entry.dir)].filter(Boolean).join(' ');
    const agent = defaultAgent();
    let html = `<div class="${cls}" draggable="true" data-path="${esc(p)}" data-dir="${entry.dir ? 1 : ''}" data-project="${project ? 1 : ''}" data-depth="${depth}" title="${esc(p)}" style="padding-left:${4 + depth * 12}px">`
      + `<span class="tw">${entry.dir ? '▶' : ''}</span>`
      + (project ? `<span class="fi" data-jump title="${count ? 'Go to its master terminal' : 'No tiles open here'}">◈</span>` : entry.dir ? '' : '<span class="fi">·</span>')
      + `<span class="nm">${esc(entry.name)}</span>`
      + (project ? `<span class="git-info">${gitInfoHtml(p)}</span>` : '')
      + (count ? `<span class="count" title="${count} open tile${count === 1 ? '' : 's'}">${count}</span>` : '')
      + (entry.dir ? `<span class="acts">${project && cfg.codegraphButtons ? '<button data-act="cg" title="Index with CodeGraph">◇</button>' : ''}${project ? `<button data-act="ide" title="Open in ${esc(ideName())}">⌨</button>` : ''}<button data-act="agent" title="New ${esc(agent?.name || 'agent')} here">${esc(agent?.icon || '✻')}</button><button data-act="shell" title="New shell here">❯</button></span>` : '')
      + '</div>';
    if (open) html += kidsHtml(p, depth);
    return html;
  }
  // An open folder's contents, in their own box so opening, closing or reloading one folder only redraws that box.
  function kidsHtml(p, depth) {
    const kids = dirCache.get(p), pad = `style="padding-left:${16 + depth * 12}px"`;
    let html = `<div class="kids" data-kids="${esc(p)}">`;
    if (kids === undefined) html += `<div class="side-empty" ${pad}>…</div>`;
    else if (kids === null) html += `<div class="side-empty" ${pad}>Can't read this folder</div>`;
    else if (!kids.length) html += `<div class="side-empty" ${pad}>Empty</div>`;
    else for (const k of kids) html += nodeHtml(k, depth + 1);
    return html + '</div>';
  }
  const rowOf = p => sideBody.querySelectorAll(`.node-row[data-path="${CSS.escape(p)}"]`);
  // Redraws one open folder's box in every place it shows (a project can also show under OPEN IN TILES).
  function redrawKids(p) {
    for (const row of rowOf(p)) {
      const box = row.nextElementSibling;
      if (!box?.classList.contains('kids')) continue;
      box.outerHTML = kidsHtml(p, +row.dataset.depth);
    }
  }
  // Loads the open folders that aren't cached yet, drawing each as it arrives.
  async function loadMissing() {
    for (let missing = [...new Set([...sideBody.querySelectorAll('.node-row.open')].map(r => r.dataset.path).filter(p => !dirCache.has(p)))];
      missing.length; missing = [...new Set([...sideBody.querySelectorAll('.node-row.open')].map(r => r.dataset.path).filter(p => !dirCache.has(p)))]) {
      await Promise.all(missing.map(async p => { await loadDir(p); redrawKids(p); }));
    }
  }

  // Loads every expanded folder that isn't cached yet, then draws. force re-reads them all.
  async function renderSidebar(force = false) {
    if (!cfg.sidebar) return;
    const { projects, others } = roots();
    let html = '';
    html += projects.map(p => nodeHtml({ name: baseName(p), path: p, dir: true }, 0, true)).join('');
    if (!allProjects().length) html += `<div class="side-empty">Pin folders here with ＋, or right-click a folder below and choose <i>Pin as project</i>.</div>`
      + nodeHtml({ name: baseName(cfg.defaultCwd), path: cfg.defaultCwd, dir: true }, 0, true);
    html += groups().map(groupHtml).join('');
    if (others.length) html += `<div class="side-group">OPEN IN TILES</div>` + others.map(p => nodeHtml({ name: baseName(p), path: p, dir: true }, 0, true)).join('');
    const top = sideBody.scrollTop, old = sideBody.querySelector('.group-name'), sel = old && [old.selectionStart, old.selectionEnd];
    if (force) dirCache.clear();
    redrawing = true; sideBody.innerHTML = html; redrawing = false;
    sideBody.scrollTop = top;
    const input = editing && sideBody.querySelector('.group-name');
    if (input) { input.focus(); if (sel) input.setSelectionRange(...sel); else input.select(); }
    if (force) for (const row of sideBody.querySelectorAll('.node-row.open')) redrawKids(row.dataset.path);
    loadGit(force);
    await loadMissing();
  }

  // Redraw when the projects or the open tiles' folders change; the focused tile only moves the highlight.
  function sidebarChanged() {
    const sig = JSON.stringify([cfg.projects, cfg.projectGroups, tileDirs(), cfg.defaultAgent]);
    if (sig !== sideSig) { sideSig = sig; renderSidebar(); }
    else markActive();
  }
  const isActive = p => { const f = focused(); return !!(f?.cwd && isUnder(f.cwd, p)); };
  function markActive() {
    for (const row of sideBody.querySelectorAll('.node-row.project')) row.classList.toggle('active', isActive(row.dataset.path));
  }
  function setSelected(p) {
    selected = p;
    sideBody.querySelectorAll('.node-row.sel').forEach(r => r.classList.remove('sel'));
    rowOf(p).forEach(r => r.classList.add('sel'));
  }
  function toggleRow(row) {
    const p = row.dataset.path, project = !!row.dataset.project, open = !isOpen(p, project);
    const set = project ? collapsed : expanded;
    if (open === project) set.delete(p); else set.add(p);
    saveExpanded();
    for (const r of rowOf(p)) {
      r.classList.toggle('open', open);
      if (r.nextElementSibling?.classList.contains('kids')) r.nextElementSibling.remove();
      if (open) r.insertAdjacentHTML('afterend', kidsHtml(p, +r.dataset.depth));
    }
    if (open) loadMissing();
  }

  // Coming back to Operant re-reads the open folders and redraws only the ones whose contents changed.
  async function refreshDirs() {
    const open = [...new Set([...sideBody.querySelectorAll('.node-row.open')].map(r => r.dataset.path))];
    for (const p of [...dirCache.keys()]) if (!open.includes(p)) dirCache.delete(p);
    await Promise.all(open.map(async p => {
      const before = JSON.stringify(dirCache.get(p));
      await loadDir(p, true);
      if (JSON.stringify(dirCache.get(p)) !== before) redrawKids(p);
    }));
    await loadMissing();
  }

  // ------------------------------------------------------------ git in the sidebar
  // Each project's branch and number of changed files; changed files are tinted, and so are the
  // folders they're in. Read when the sidebar draws, when Operant comes back to the front, and when
  // an agent finishes working.

  const gitState = new Map(); // project -> { at, status } (status null: not a repository)
  const gitFiles = new Map(); // lower-case path -> class, for every changed file and every folder above one
  function indexGit() {
    gitFiles.clear();
    for (const { status } of gitState.values()) {
      if (!status) continue;
      for (const f of status.files) {
        const [, cls] = gitKind(f.code);
        let p = (status.root + '\\' + f.path.replace(/\//g, '\\')).toLowerCase();
        gitFiles.set(p, cls);
        while ((p = p.replace(/\\[^\\]*$/, '')) && p.length > status.root.length) if (!gitFiles.has(p)) gitFiles.set(p, 'dir');
      }
    }
  }
  const gitClass = (p, dir) => {
    if (!cfg.sidebarGit) return '';
    const c = gitFiles.get(normPath(p));
    return !c ? '' : dir ? (c === 'dir' ? 'git-dir' : '') : `git-${c}`;
  };
  function gitChanges(p) {
    const st = gitState.get(p)?.status;
    return st ? st.files.filter(f => isUnder(st.root + '\\' + f.path.replace(/\//g, '\\'), p)).length : 0;
  }
  function gitInfoHtml(p) {
    const st = cfg.sidebarGit && gitState.get(p)?.status;
    if (!st) return '';
    const n = gitChanges(p), sync = (st.ahead ? ` ↑${st.ahead}` : '') + (st.behind ? ` ↓${st.behind}` : '');
    return `<span class="git-br" title="Branch ${esc(st.branch)}${st.ahead ? ` · ${st.ahead} commit${st.ahead === 1 ? '' : 's'} to push` : ''}${st.behind ? ` · ${st.behind} to pull` : ''}">⎇ ${esc(st.branch)}${sync}</span>`
      + (n ? `<span class="git-n" data-changes title="${n} changed file${n === 1 ? '' : 's'} · click to see what changed">${n}</span>` : '');
  }
  let gitLoading = false;
  async function loadGit(force = false) {
    if (!cfg.sidebarGit || gitLoading) return;
    gitLoading = true;
    const dirs = [...new Set([...sideBody.querySelectorAll('.node-row.project')].map(r => r.dataset.path))];
    const stale = dirs.filter(p => force || !gitState.has(p) || Date.now() - gitState.get(p).at > 15000);
    await Promise.all(stale.map(async p => { gitState.set(p, { at: Date.now(), status: await operant.gitStatus(p) }); }));
    gitLoading = false;
    if (!stale.length) return;
    indexGit();
    decorateGit();
    drawGitButton();
  }
  // Puts the git tints and project info on the rows already drawn.
  function decorateGit() {
    for (const row of sideBody.querySelectorAll('.node-row')) {
      const want = gitClass(row.dataset.path, !!row.dataset.dir);
      for (const c of [...row.classList]) if (c.startsWith('git-') && c !== want) row.classList.remove(c);
      if (want) row.classList.add(want);
      const info = row.querySelector('.git-info');
      if (info) { const h = gitInfoHtml(row.dataset.path); if (info.innerHTML !== h) info.innerHTML = h; }
    }
  }
  // Files changed (an agent finished, Operant came back to the front): the sidebar and the diff tiles catch up.
  let gitT = null;
  function gitChanged() {
    clearTimeout(gitT);
    gitT = setTimeout(() => {
      if (cfg.sidebar) loadGit(true);
      if (cfg.gitButton) { const p = barProject(); if (p) fetchBarGit(p); }
      for (const w of wins.values()) if (w.kind === 'diff' && w.alive) loadDiff(w);
    }, 400);
  }

  function toggleSidebar() { setSetting('sidebar', !cfg.sidebar); }
  $('#btn-sidebar').onclick = toggleSidebar;
  $('#side-hide').onclick = toggleSidebar;
  $('#side-refresh').onclick = () => renderSidebar(true);
  $('#side-add').onclick = async () => { const d = await operant.pickFolder(); if (d) pinProject(d); };
  $('#side-cg').onclick = () => runCodegraph(allProjects(), 'all projects');
  $('#side-group').onclick = () => newGroup();
  window.addEventListener('focus', () => { if (cfg.sidebar) refreshDirs(); gitChanged(); });

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

  // The project's ◈: its most recently used master tile, else its most recently used tile of any kind.
  function jumpToProject(dir) {
    const here = [...wins.values()].filter(w => w.alive && w.kind !== 'agent' && w.cwd && isUnder(w.cwd, dir));
    const recent = list => list.sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0))[0];
    const w = recent(here.filter(x => x.master)) || recent(here.filter(x => x.kind === 'ai')) || recent(here);
    if (!w) return false;
    if (w.ws !== current) switchWorkspace(w.ws);
    focusWin(w);
    return true;
  }

  function openFile(p, how) {
    if (how === 'edit' && !isImageFile(p)) return openEditor(p);
    if (how === 'view' || isImageFile(p)) return openViewer(p);
    operant.openPath(p);
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
  function runCodegraph(dirs, label, { focus = true } = {}) {
    dirs = (dirs || []).filter(Boolean);
    if (!dirs.length) return toast('No projects to index. Pin a folder first.');
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const steps = dirs.map(d => `Write-Host ''; Write-Host ${q('== ' + d)} -ForegroundColor Cyan; `
      + `if (Test-Path -LiteralPath (Join-Path ${q(d)} '.codegraph')) { codegraph sync ${q(d)} } else { codegraph init -y ${q(d)} }`);
    const run = `if (-not (Get-Command codegraph -ErrorAction SilentlyContinue)) { Write-Host 'CodeGraph is not installed. Install it from Settings > CodeGraph.' -ForegroundColor Yellow } else { `
      + steps.join('; ') + `; Write-Host ''; Write-Host 'CodeGraph done for ${dirs.length} project(s)' -ForegroundColor Green }`;
    newTerminal('shell', dirs[0], { run, title: `CodeGraph · ${label || baseName(dirs[0])}`, focus });
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
    if (e.target.closest('[data-jump]') && jumpToProject(p)) return;
    if (e.target.closest('[data-changes]')) return showChanges(p);
    setSelected(p);
    if (row.dataset.dir) { lastCwd = p; toggleRow(row); }
  });
  sideBody.addEventListener('dblclick', e => {
    const grow = e.target.closest('.group-row');
    if (grow && !e.target.closest('.group-name, [data-gact]')) return groupAct(+grow.dataset.group, 'rename');
    const row = e.target.closest('.node-row');
    if (row && !row.dataset.dir && !e.target.closest('[data-act]')) openFile(row.dataset.path, cfg.fileOpens);
  });
  // Dragging a row out: a terminal tile types the path, a viewer tile opens it, empty desktop opens a viewer.
  sideBody.addEventListener('dragstart', e => {
    const row = e.target.closest('.node-row');
    if (!row) return;
    e.dataTransfer.setData('text/plain', row.dataset.path);
    e.dataTransfer.setData('application/x-operant-path', row.dataset.path);
  });
  sideBody.addEventListener('input', e => { if (editing && e.target.matches('.group-name')) editing.value = e.target.value; });
  sideBody.addEventListener('keydown', e => {
    if (!e.target.matches('.group-name')) return;
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); commitGroupName(e.key === 'Enter'); }
  });
  sideBody.addEventListener('focusout', e => { if (!redrawing && e.target.matches('.group-name')) commitGroupName(true); });

  // ------------------------------------------------------------ vim keys
  // Settings › Keybinds › Vim keys: j/k, h/l, gg/G, Ctrl+D/U and / in viewer and diff tiles and in
  // the sidebar (focusSidebar puts the keyboard there; Esc gives it back to the tile).

  let vimG = 0; // when g was pressed, for gg
  const isGG = e => { if (e.key !== 'g' || e.ctrlKey || e.altKey) return false; const again = Date.now() - vimG < 600; vimG = again ? 0 : Date.now(); return again; };

  function vimView(e, w) {
    if (!cfg.vimKeys || e.altKey || e.target.closest('.find-bar')) return;
    const page = w.page, line = 40, half = page.clientHeight / 2;
    const k = e.ctrlKey ? 'C-' + e.key.toLowerCase() : e.key;
    const go = {
      j: () => page.scrollBy(0, line), k: () => page.scrollBy(0, -line), l: () => page.scrollBy(line, 0), h: () => page.scrollBy(-line, 0),
      'C-d': () => page.scrollBy(0, half), 'C-u': () => page.scrollBy(0, -half),
      G: () => { page.scrollTop = page.scrollHeight; }, '/': () => openFind(w),
      n: () => w.find?.n && stepFind(w, 1), N: () => w.find?.n && stepFind(w, -1),
      ']': () => w.kind === 'diff' && stepDiffFile(w, 1), '[': () => w.kind === 'diff' && stepDiffFile(w, -1),
    }[k];
    if (isGG(e)) { page.scrollTop = 0; e.preventDefault(); return; }
    if (!go) return;
    e.preventDefault();
    go();
  }
  function stepDiffFile(w, d) {
    const i = w.files.findIndex(f => f.path === w.sel), f = w.files[i + d];
    if (!f) return;
    w.sel = f.path;
    w.el.querySelectorAll('.df-row').forEach(r => r.classList.toggle('on', r.dataset.file === f.path));
    w.el.querySelector('.df-row.on')?.scrollIntoView({ block: 'nearest' });
    showDiffFile(w);
  }
  desktop.addEventListener('keydown', e => {
    const el = e.target.closest?.('.win');
    const w = el && [...wins.values()].find(x => x.el === el);
    if (w && (w.kind === 'view' || w.kind === 'diff') && e.target === w.page) vimView(e, w);
  });

  // The sidebar's keyboard cursor.
  sideBody.tabIndex = -1;
  let sideCur = null; // path of the row with the cursor
  const sideRows = () => [...sideBody.querySelectorAll('.node-row')].filter(r => r.offsetParent);
  function markCursor(row) {
    sideBody.querySelectorAll('.node-row.cur').forEach(r => r.classList.remove('cur'));
    if (!row) return;
    row.classList.add('cur');
    sideCur = row.dataset.path;
    row.scrollIntoView({ block: 'nearest' });
  }
  function focusSidebar() {
    if (!cfg.sidebar) setSetting('sidebar', true);
    sideBody.focus({ preventScroll: true });
    const rows = sideRows();
    markCursor(rows.find(r => r.dataset.path === sideCur) || rows.find(r => r.classList.contains('sel')) || rows[0]);
  }
  sideBody.addEventListener('blur', () => sideBody.querySelectorAll('.node-row.cur').forEach(r => r.classList.remove('cur')));
  sideBody.addEventListener('keydown', e => {
    if (e.target !== sideBody) return;
    const rows = sideRows(), row = rows.find(r => r.classList.contains('cur')), i = rows.indexOf(row);
    const vim = cfg.vimKeys, k = e.ctrlKey ? 'C-' + e.key.toLowerCase() : e.key;
    const move = to => { e.preventDefault(); markCursor(rows[Math.max(0, Math.min(rows.length - 1, to))]); };
    if (e.key === 'Escape') { e.preventDefault(); sideBody.blur(); return focusKeys(focused()); }
    if (vim && isGG(e)) return move(0);
    if (k === 'ArrowDown' || (vim && k === 'j')) return move(i + 1);
    if (k === 'ArrowUp' || (vim && k === 'k')) return move(i - 1);
    if (vim && k === 'G') return move(rows.length - 1);
    if (vim && k === 'C-d') return move(i + 10);
    if (vim && k === 'C-u') return move(i - 10);
    if (vim && k === '/') { e.preventDefault(); return openPicker('files'); }
    if (!row) return;
    const p = row.dataset.path, dir = !!row.dataset.dir, open = row.classList.contains('open');
    if (k === 'Enter' || k === 'ArrowRight' || (vim && (k === 'l' || k === 'o'))) {
      e.preventDefault();
      setSelected(p);
      if (!dir) return openFile(p, k === 'Enter' ? cfg.fileOpens : 'view');
      if (open && k !== 'Enter') return move(i + 1);
      toggleRow(row);
      return markCursor(rowOf(p)[0]);
    }
    if (k === 'ArrowLeft' || (vim && k === 'h')) {
      e.preventDefault();
      if (dir && open) { toggleRow(row); return markCursor(rowOf(p)[0]); }
      // Up to the folder it's in.
      const box = row.closest('.kids');
      if (box) markCursor(box.previousElementSibling);
      return;
    }
    if (vim && k === 'e' && !dir) { e.preventDefault(); return openFile(p, 'edit'); }
    if (vim && k === 'a' && dir) { e.preventDefault(); return openHere(p, 'agent'); }
    if (vim && k === 's' && dir) { e.preventDefault(); return openHere(p, 'shell'); }
  });

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
    if (!row.dataset.dir) return showMenu(e.clientX, e.clientY, [
      ['▤', 'View in Operant', () => openFile(p, 'view')], ['✎', `Edit in ${editorName || 'editor'}`, () => openFile(p, 'edit')], '-',
      ['↗', 'Open with Windows', () => operant.openPath(p)], ['▤', 'Show in Explorer', () => operant.reveal(p)], copy]);
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
      ['±', 'Show changes', () => showChanges(p)],
      copy,
      '-',
      ...grouping,
      ...(pinned ? [['⚙', 'Project defaults…', () => { togglePanel('settings'); Panels.showTab('Projects'); renderSettings(); }]] : []),
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
    mediaEl.classList.toggle('full', cfg.mediaSize === 'full');
    if (!show) return;
    const art = $('#media-art');
    if (s.art) { if (art.getAttribute('src') !== s.art) art.src = s.art; art.classList.remove('none'); }
    else { art.removeAttribute('src'); art.classList.add('none'); }
    const titleEl = $('#media-title'), titleText = titleEl.firstChild;
    if (titleText.textContent !== (s.title || '') || titleEl.dataset.size !== cfg.mediaSize) {
      titleText.textContent = s.title || '';
      titleEl.dataset.size = cfg.mediaSize;
      // Titles too long for the box scroll back and forth instead of being cut off.
      titleEl.classList.remove('scroll');
      const over = titleText.scrollWidth - titleEl.clientWidth;
      if (over > 2) {
        titleEl.style.setProperty('--over', -over + 'px');
        titleEl.style.setProperty('--dur', (4 + over / 25).toFixed(1) + 's');
        titleEl.classList.add('scroll');
      }
    }
    $('#media-artist').textContent = s.artist || '';
    const app = s.appName || String(s.app || '').replace(/\.exe$/i, '').split('!').pop();
    mediaEl.title = [s.title, s.artist, s.album].filter(Boolean).join(' · ') + (app ? `\n${app}` : '');
    $('.media-text').title = `${mediaEl.title}${app ? `\nClick to open ${app}` : ''}`;
    mediaEl.classList.toggle('playing', !!s.playing);
    $('#media-play').title = s.playing ? 'Pause' : 'Play';
    $('#media-play').disabled = !s.canPlayPause;
    $('#media-prev').disabled = !s.canPrev;
    $('#media-next').disabled = !s.canNext;
    drawProgress();
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

  // The track's progress, counted on from the player's last report while it plays.
  const progEl = $('#media-progress');
  const fmtTime = sec => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };
  function drawProgress() {
    const tl = mediaState.timeline, show = !!(tl && tl.dur > 0 && !mediaEl.classList.contains('hidden'));
    progEl.classList.toggle('hidden', !show);
    if (!show) return;
    const pos = Math.min(tl.dur, tl.pos + (mediaState.playing && tl.at > 0 ? Math.max(0, Date.now() - tl.at) / 1000 : 0));
    progEl.firstChild.style.width = (pos / tl.dur * 100).toFixed(2) + '%';
    const t = `${fmtTime(pos)} / ${fmtTime(tl.dur)} · ${fmtTime(tl.dur - pos)} left`;
    if (progEl.title !== t) progEl.title = t;
  }
  setInterval(() => { if (mediaState.playing) drawProgress(); }, 500);
  operant.on('media:timeline', tl => { mediaState = { ...mediaState, timeline: tl }; drawProgress(); });
  operant.on('media:art', art => renderMedia({ ...mediaState, art }));
  $('.media-text').onclick = () => operant.media('focus');

  const mediaCmd = cmd => { operant.media(cmd); if (cmd === 'toggle') mediaEl.classList.toggle('playing'); };
  $('#media-play').onclick = () => mediaCmd('toggle');
  $('#media-prev').onclick = () => mediaCmd('prev');
  $('#media-next').onclick = () => mediaCmd('next');
  $('#media-shuffle').onclick = () => { $('#media-shuffle').classList.toggle('on'); mediaCmd('shuffle'); };
  $('#media-mute').onclick = () => setVolume(+volEl.value > 0.001 ? 0 : volBeforeMute || 0.5);
  volEl.oninput = () => setVolume(+volEl.value);
  volEl.addEventListener('pointerdown', () => mediaEl.classList.add('vol-drag'));
  document.addEventListener('pointerup', () => mediaEl.classList.remove('vol-drag'));
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
    const used = countOf(s.today), budget = +cfg.tokenBudget || 0, share = budget ? used / budget : 0;
    usagePill.classList.toggle('warn', budget > 0 && share >= 0.8 && share < 1);
    usagePill.classList.toggle('over', budget > 0 && share >= 1);
    // The ring: how much of the 5-hour Claude session is used.
    const sess = cfg.planLimits && cfg.planLimitAlerts && limits?.session, C = 2 * Math.PI * 5.5;
    const ring = sess ? `<svg class="ring${pctClass(sess.used)}" viewBox="0 0 16 16"><circle class="ring-bg" cx="8" cy="8" r="5.5"/>`
      + `<circle class="ring-fg" cx="8" cy="8" r="5.5" stroke-dasharray="${(Math.min(100, sess.used) / 100 * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>` : '';
    usagePill.innerHTML = `<svg viewBox="0 0 16 16"><path d="M2 13.5h12v1.3H2zM3 8h2.3v4.5H3zm3.8-5h2.3v9.5H6.8zm3.9 3h2.3v6.5h-2.3z"/></svg>${fmtTok(used)} <span class="dim">${budget ? `/ ${fmtTok(budget)}` : 'today'}</span>${ring}`;
    usagePill.title = sess ? `Claude session ${Math.round(sess.used)}% used` : '';
    if (!usageCard.classList.contains('hidden')) drawUsageCard();
  }

  // Hovering the pill shows a card: today's tokens, the budget, and the Claude plan limits as bars,
  // like Claude Code's /usage. Main asks Anthropic for the limits every 10 minutes, or on a click.
  const usageCard = $('#usage-card');
  let limits = null, cardShowT = null, cardHideT = null;
  const pctClass = p => p >= 100 ? ' over' : p >= 80 ? ' warn' : '';
  const bar = p => `<div class="uc-bar${pctClass(p)}"><i style="width:${Math.min(100, Math.max(0, p)).toFixed(1)}%"></i></div>`;
  function resetsAt(t) {
    const d = new Date(t), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const mins = Math.round((d - Date.now()) / 60000);
    const left = mins < 60 ? `in ${Math.max(0, mins)} min` : mins < 1440 ? `in ${Math.floor(mins / 60)} h ${mins % 60} min` : '';
    const day = d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' ';
    return `Resets ${day}${hm}${left ? ` · ${left}` : ''}`;
  }
  const limitRow = (name, l) => !l ? '' : `<div class="uc-limit"><div class="uc-row"><span>${name}</span><b>${Math.round(l.used)}% used</b></div>`
    + bar(l.used) + (l.resets ? `<div class="uc-sub">${esc(resetsAt(l.resets))}</div>` : '') + '</div>';
  function drawUsageCard() {
    const s = usageSum;
    if (!s?.ready) return;
    const used = countOf(s.today), budget = +cfg.tokenBudget || 0;
    let html = `<div class="uc-head"><span>Tokens today</span><b>${fmtTok(used)}</b></div>`
      + (budget ? `<div class="uc-limit">${bar(used / budget * 100)}<div class="uc-sub">${Math.round(used / budget * 100)}% of your ${fmtTok(budget)} daily budget</div></div>` : '')
      + `<div class="uc-series">${USAGE_SERIES.map(([k, n]) => {
        const on = counted().some(c => c[0] === k);
        return `<div class="uc-row${on ? '' : ' off'}"><span><i class="sw s-${k}"></i>${n}</span><b>${fmtTok(s.today[k] || 0)}</b></div>`;
      }).join('')}<div class="uc-row"><span>Last hour</span><b>${fmtTok(countOf(s.hour))}</b></div></div>`;
    if (cfg.planLimits) {
      html += '<div class="uc-title">Plan limits</div>';
      if (!limits) html += '<div class="uc-sub">Checking…</div>';
      else if (limits.error) html += `<div class="uc-sub">${esc(limits.error)}</div>`;
      else html += limitRow('Current session', limits.session) + limitRow('Current week', limits.week)
        + limitRow('Current week (Opus)', limits.weekOpus) + limitRow('Current week (Sonnet)', limits.weekSonnet);
    }
    html += '<div class="uc-foot">Click for the graph</div>';
    usageCard.innerHTML = html;
  }
  function showUsageCard() {
    clearTimeout(cardHideT);
    if (!usageCard.classList.contains('hidden')) return;
    drawUsageCard();
    usageCard.classList.remove('hidden');
    const r = usagePill.getBoundingClientRect();
    usageCard.style.left = Math.max(6, Math.min(innerWidth - usageCard.offsetWidth - 6, r.left + r.width / 2 - usageCard.offsetWidth / 2)) + 'px';
    usageCard.style.top = r.bottom + 6 + 'px';
    if (cfg.planLimits) operant.usageLimits().then(l => { limits = l; if (!usageCard.classList.contains('hidden')) drawUsageCard(); });
  }
  const hideUsageCard = (delay = 200) => { clearTimeout(cardShowT); clearTimeout(cardHideT); cardHideT = setTimeout(() => usageCard.classList.add('hidden'), delay); };
  usagePill.addEventListener('mouseenter', () => { clearTimeout(cardHideT); cardShowT = setTimeout(showUsageCard, 250); });
  usagePill.addEventListener('mouseleave', () => hideUsageCard());
  usagePill.addEventListener('mousedown', () => hideUsageCard(0));
  usageCard.onmouseenter = () => clearTimeout(cardHideT);
  usageCard.onmouseleave = () => hideUsageCard();
  window.addEventListener('blur', () => hideUsageCard(0));
  usagePill.onclick = () => { togglePanel('usage'); if (cfg.planLimits) operant.usageLimits(true); };
  operant.on('usage:limits', l => { limits = l; renderUsagePill(); });
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
      if (updateWaiting) showWaiting();
    }
  });
  // With an agent mid-task, Update waits until every tile has been quiet for a few seconds.
  // Clicking again updates at once; right-clicking stops waiting.
  let updateWaiting = false, quietSince = 0;
  const anyWorking = () => [...wins.values()].some(w => w.alive && isWorking(w));
  function showWaiting() {
    pill.textContent = '↑ Updating when agents finish…';
    pill.title = 'Click to update now · right-click to cancel';
  }
  pill.onclick = () => {
    if (!pill.classList.contains('ready')) return;
    if (updateWaiting || !cfg.updateWhenIdle || !anyWorking()) { updateWaiting = false; return operant.installUpdate(); }
    updateWaiting = true; quietSince = 0;
    showWaiting();
    toast('Updating once your agents finish. Click the pill to update now.');
  };
  pill.oncontextmenu = e => {
    if (!updateWaiting) return;
    e.preventDefault();
    updateWaiting = false;
    pill.textContent = `↑ Update to v${updateStatus?.version || ''}`;
    pill.title = 'Click to install and restart';
  };
  setInterval(() => {
    if (!updateWaiting) return;
    if (anyWorking()) { quietSince = 0; return; }
    quietSince ||= Date.now();
    if (Date.now() - quietSince >= 5000) { updateWaiting = false; operant.installUpdate(); }
  }, 1000);

  applyAppearance();
  renderHints();
  refreshBar();
  // Opened from Explorer's "Open in Operant": the master starts in that folder,
  // and later right-clicks (while running) each add a tile of the default agent there.
  const startDir = await operant.startupFolder();
  if (startDir) lastCwd = startDir;
  // After an update (or on every start, in Settings) the tiles you had come back.
  const snap = await operant.takeSession();
  if (snap && await restore(snap)) { if (startDir) newTerminal('ai', startDir); }
  else if (!cfg.agentChosen && cfg.agents.length > 1) {
    togglePanel('launcher');
    welcome = { dir: startDir || cfg.defaultCwd };
    renderLauncher();
  } else if (cfg.masterOnStartup || startDir) newTerminal('ai', startDir || cfg.defaultCwd, { master: true });
  operant.on('open-folder', dir => { lastCwd = dir; newTerminal('ai', dir); });
  // linkBrowser: 'tile' sends links here instead of opening them outside Operant.
  operant.on('browse', url => openBrowser(url, { near: focused() }));
  // Settings › CodeGraph: pinned projects with lots of new code (or all of them) are indexed in one tile at startup.
  operant.codegraphStartup().then(dirs => {
    if (!dirs.length) return;
    runCodegraph(dirs, `${dirs.length} project${dirs.length === 1 ? '' : 's'} on startup`, { focus: false });
    toast(`<b>◇ CodeGraph</b> indexing ${dirs.map(d => esc(baseName(d))).join(', ')}`);
  });
  // A setting changed in another Operant window.
  operant.on('config:changed', c => {
    Object.assign(cfg, c);
    applyAppearance(); rebuildBinds(); renderHints(); renderMedia(); renderUsagePill(); drawUsage(); tick(); refreshBar();
    for (const w of wins.values()) if (w.alive) { renderIbar(w); scheduleFit(w, 0); }
    if (openPanel() === 'settings') renderSettings();
    if (openPanel() === 'keys') renderKeys();
    if (openPanel() === 'quickmenu') drawTeamSliders();
  });

  // ------------------------------------------------------------- control API
  // An agent CLI running in a tile drives Operant through `operant <cmd>` (see skill/operant).
  // Main forwards each request here; we reply on the same channel. Nothing thrown here reaches main unanswered.
  function rawLines(w, n) {
    if (w.kind === 'view') return (w.text || '').split('\n').slice(0, n);
    if (!w.term) return [];
    const buf = w.term.buffer.active, rows = [];
    for (let i = 0; i < buf.length; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (rows.length && !rows.at(-1).trim()) rows.pop();
    return rows.slice(-n);
  }
  function tileText(w, lines) { return rawLines(w, lines).join('\n'); }

  // Clean noisy terminal output: strip stray escapes, collapse repeated/progress-y lines and long blank runs.
  const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-';
  const spinnerRe = new RegExp(`[${SPINNER.replace(/[\\/-]/g, '\\$&')}]`, 'g');
  const stripAnsi = s => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\x1b./g, '');
  const stripVolatile = s => s.replace(/[0-9]/g, '').replace(/%/g, '').replace(spinnerRe, '');
  function cleanLines(raw) {
    const lines = stripAnsi(raw).split('\n').map(l => l.replace(/[ \t]+$/, ''));
    const merged = [];
    for (const line of lines) {
      const last = merged.at(-1);
      if (last && line !== '' && last.text === line) { last.count++; continue; }
      if (last && line !== '' && last.text !== '' && stripVolatile(line) === stripVolatile(last.text)) { last.text = line; continue; }
      merged.push({ text: line, count: 1 });
    }
    const out = [];
    let blanks = 0;
    const flush = () => { if (blanks) out.push(...(blanks >= 3 ? [''] : Array(blanks).fill(''))); blanks = 0; };
    for (const m of merged) {
      if (m.text === '') { blanks++; continue; }
      flush();
      out.push(m.count > 1 ? `${m.text}  (×${m.count})` : m.text);
    }
    flush();
    return out;
  }
  // Lines around each match (context lines included even if they don't match); separate groups joined by "…".
  function withContext(lines, isMatch, before, after) {
    const idxs = [];
    lines.forEach((l, i) => { if (isMatch(l)) idxs.push(i); });
    if (!idxs.length) return null;
    const ranges = [];
    for (const i of idxs) {
      const s = Math.max(0, i - before), e = Math.min(lines.length - 1, i + after);
      const r = ranges.at(-1);
      if (r && s <= r[1] + 1) r[1] = Math.max(r[1], e);
      else ranges.push([s, e]);
    }
    return ranges.map(([s, e]) => lines.slice(s, e + 1).join('\n')).join('\n…\n');
  }
  const ERROR_RE = /\b(error|failed|failure|fatal|exception|traceback|panic|warn(ing)?|FAIL)\b|[✗✖]/i;

  // ------------------------------------------------------------ ports & watch
  // `operant ports`: scan each tile's terminal for local dev-server URLs a build tool printed
  // (Vite/Next "Local:"/"ready on", "listening on port N", etc). A tile whose process has exited
  // is already gone from `wins` (pty:exit closes it), so nothing extra to filter there.
  const PORT_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>]*)?/gi;
  const PORT_ONLY_RE = /\b(?:listening|ready|running|serving)\b[^\n]{0,30}?\bport\s+(\d{2,5})\b/i;
  function scanPorts() {
    const out = [];
    for (const w of wins.values()) {
      if (!w.alive || !w.term) continue;
      const found = new Map(); // port -> url; later lines win (a restarted server can pick a new port)
      for (const line of cleanLines(rawLines(w, 4000).join('\n'))) {
        for (const m of line.matchAll(PORT_URL_RE)) {
          const url = m[0].replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::1?\])/i, '$1localhost');
          let port;
          try { port = new URL(url).port || (url.startsWith('https') ? '443' : '80'); } catch { continue; }
          found.set(port, url);
        }
        const pm = line.match(PORT_ONLY_RE);
        if (pm) found.set(pm[1], `http://localhost:${pm[1]}`);
      }
      for (const [port, url] of found) out.push({ id: w.id, title: w.title, port: Number(port), url });
    }
    return out;
  }

  // `operant watch <id> --errors|--grep p`: notify (Windows toast, via the same `notify()` as
  // everything else) and flag the watcher's next `operant` call when the target tile prints a new
  // line matching ERROR_RE or the grep. One notification per burst (debounced ~5s). Ends on its
  // own once the target tile closes (checked each tick, same pattern as auto-compact above).
  const watches = new Map(); // target tile id -> { callerId, errors, grep, pos, debounceUntil }
  const watchPrefix = new Map(); // caller tile id -> pending "[watch] ..." line for its next operant call
  function tickWatches() {
    const now = Date.now();
    for (const [id, st] of [...watches]) {
      const w = wins.get(id);
      if (!w || !w.alive) { watches.delete(id); continue; }
      if (!w.term) continue;
      const buf = w.term.buffer.active, line = i => buf.getLine(i)?.translateToString(true) ?? '';
      // Once scrollback is full the buffer stops growing and old lines shift up, so find
      // where the last line we saw has moved to rather than trusting the stored index.
      if (st.anchor != null && st.pos > 0 && line(st.pos - 1) !== st.anchor) {
        let i = st.pos - 2;
        while (i >= 0 && line(i) !== st.anchor) i--;
        st.pos = i + 1;
      }
      const pos = absPos(w);
      if (pos <= st.pos) { st.pos = Math.min(st.pos, pos); continue; }
      const rows = [];
      for (let i = st.pos; i < pos; i++) rows.push(line(i));
      st.pos = pos;
      st.anchor = line(pos - 1);
      if (now < st.debounceUntil) continue;
      const cleaned = cleanLines(rows.join('\n'));
      let re = null;
      if (st.grep) { try { re = new RegExp(st.grep, 'i'); } catch { re = null; } }
      const isMatch = l => st.grep ? (re ? re.test(l) : l.toLowerCase().includes(String(st.grep).toLowerCase())) : ERROR_RE.test(l);
      const hit = cleaned.find(isMatch);
      if (!hit) continue;
      st.debounceUntil = now + 5000;
      notify(w, w.title, hit);
      watchPrefix.set(st.callerId, `[watch] tile ${id} (${w.title}): ${hit}`);
    }
  }
  setInterval(tickWatches, 1000);

  // Per (caller tile, target tile) read cursor, updated on every read/wait of a tile
  // (so `--new` returns only what's happened since the caller's last look, `--new` or not).
  const readCursors = new Map();
  function cursorKey(self, w) { return `${self && self.id != null ? self.id : 'ext'}:${w.id}`; }
  // Absolute end of a tile's output, on the same basis rawLines() uses (trailing blanks
  // trimmed), not the on-screen cursor row — those two can disagree by a whole viewport's
  // worth of blank lines below the cursor, which was making `--new` reread stale content.
  function absPos(w) {
    if (w.kind === 'view') return (w.text || '').split('\n').length;
    if (!w.term) return 0;
    const buf = w.term.buffer.active;
    let n = buf.length;
    while (n > 0 && !(buf.getLine(n - 1)?.translateToString(true) ?? '').trim()) n--;
    return n;
  }
  function recordCursor(self, w) {
    const pos = absPos(w);
    readCursors.set(cursorKey(self, w), pos);
    return pos;
  }
  function newSince(self, w) {
    const key = cursorKey(self, w);
    const last = readCursors.get(key);
    const pos = recordCursor(self, w);
    if (last == null) return { lines: rawLines(w, 60), dropped: false };
    if (w.kind === 'view') {
      const all = (w.text || '').split('\n');
      const start = Math.max(0, Math.min(last, all.length));
      return { lines: all.slice(start), dropped: last > all.length };
    }
    if (!w.term) return { lines: [], dropped: false };
    const buf = w.term.buffer.active;
    const dropped = last > pos;
    const start = dropped ? 0 : Math.min(last, pos);
    const rows = [];
    for (let i = start; i < pos; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? '');
    return { lines: rows, dropped };
  }
  // Cleaned + filtered output for `read`/`wait`. Returns { text, total, shown }.
  function readOutput(self, w, { lines, isNew, errors, grep } = {}) {
    const cap = lines || (errors || grep ? 400 : 60);
    let raw, dropped = false;
    if (isNew) { const r = newSince(self, w); raw = r.lines.join('\n'); dropped = r.dropped; }
    else { raw = rawLines(w, cap).join('\n'); recordCursor(self, w); }
    let cleaned = cleanLines(raw);
    if (cap && cleaned.length > cap) cleaned = cleaned.slice(-cap);
    const total = cleaned.length;
    let text;
    if (errors) {
      const grouped = withContext(cleaned, l => ERROR_RE.test(l), 1, 2);
      text = grouped == null ? `no errors or warnings in the last ${total} lines` : grouped;
    } else if (grep) {
      let re;
      try { re = new RegExp(grep, 'i'); } catch { re = null; }
      const isMatch = re ? l => re.test(l) : l => l.toLowerCase().includes(String(grep).toLowerCase());
      const grouped = withContext(cleaned, isMatch, 1, 1);
      text = grouped == null ? `no matches in the last ${total} lines` : grouped;
    } else {
      text = cleaned.join('\n');
      if (isNew && !text) text = '(no new output)';
    }
    if (dropped) text = `… (older output dropped)\n${text}`;
    return { text, total, shown: text ? text.split('\n').length : 0 };
  }
  function needTile(id) {
    const w = wins.get(Number(id));
    if (!w || !w.alive) throw new Error(`no tile ${id}`);
    return w;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Block until a tile goes quiet (idle ms with no activity, or an agent tile reports done) or
  // exits; throws on timeout. Returns true if the tile exited, false if it just went quiet.
  // Shared by `wait`, `test` and `build`.
  async function waitQuiet(w, idle, timeout) {
    const started = Date.now();
    for (;;) {
      if (!w.alive) return true;
      const quiet = Date.now() - (w.lastActivity || 0) >= idle;
      if (quiet || (w.kind === 'agent' && w.status === 'done')) return false;
      if (Date.now() - started >= timeout) throw new Error('timed out');
      await sleep(250);
    }
  }

  // Run text/build digests (plan item 34): window.OperantDigest(text) -> {runner, summary,
  // failures, more, ok} | null. Loaded as renderer/digest.js in index.html, so it's a plain global.
  function digestOf(self, w) {
    const { text } = readOutput(self, w, { lines: 2000 });
    return typeof window.OperantDigest === 'function' ? window.OperantDigest(text) : null;
  }

  // Small, deliberately un-clever runner detection for `test`/`build` with no explicit command:
  // package.json scripts first, then each ecosystem's own project file.
  async function detectProjectCommand(cwd, kind) {
    const has = async rel => !(await operant.readFile(resolvePath(cwd, rel))).error;
    const read = async rel => { const r = await operant.readFile(resolvePath(cwd, rel)); return r.error ? '' : (r.text || ''); };
    const pkg = await read('package.json');
    if (pkg) { try { if (JSON.parse(pkg).scripts?.[kind]) return `npm run ${kind}`; } catch {} }
    if (kind === 'test' && (await has('pytest.ini') || (await read('pyproject.toml')).includes('pytest') || (await read('setup.cfg')).includes('pytest'))) return 'pytest';
    if (await has('Cargo.toml')) return kind === 'test' ? 'cargo test' : 'cargo build';
    if (await has('go.mod')) return kind === 'test' ? 'go test ./...' : 'go build ./...';
    if (await has('gradlew.bat')) return `gradlew.bat ${kind}`;
    if (await has('gradlew')) return `./gradlew ${kind}`;
    if (await has('pom.xml')) return kind === 'test' ? 'mvn test' : 'mvn package';
    const list = await operant.listDir(cwd).catch(() => []);
    if (Array.isArray(list) && list.some(f => /\.(csproj|sln)$/i.test(f.name || ''))) return kind === 'test' ? 'dotnet test' : 'dotnet build';
    return null;
  }

  async function runControl(cmd, args, self) {
    switch (cmd) {
      case 'tiles':
        return [...wins.values()].filter(w => w.alive).map(w => ({
          id: w.id, kind: w.kind, title: w.title, cwd: w.cwd, file: w.file, busy: isWorking(w),
          ws: w.ws + 1, focused: focused() === w, self: !!self && w.id === self.id, agent: w.agentConf,
          ...(w.tok ? { tokens: fmtTok(w.tok.input + w.tok.output + w.tok.cacheWrite) } : {}),
          ...(w.runaway ? { runaway: w.runaway.reason } : {}),
          ...(w.waitingPrompt ? { waiting: true } : {}),
        }));
      case 'stop': {
        const w = needTile(args.id);
        const how = stopTile(w);
        if (!how) throw new Error('nothing to stop');
        return { id: w.id, stopped: true, how };
      }
      case 'status': {
        if (!self) throw new Error('unknown tile');
        const project = projectDir(self.cwd || lastCwd);
        return { id: self.id, kind: self.kind, title: self.title, cwd: self.cwd, ws: self.ws + 1,
          project, branch: gitState.get(project)?.status?.branch,
          ...(self.tok ? { tokens: fmtTok(self.tok.input + self.tok.output + self.tok.cacheWrite) } : {}) };
      }
      case 'view': {
        if (!args.path) throw new Error('path required');
        const w = openViewer(resolvePath(self?.cwd || lastCwd, args.path), { ws: self?.ws ?? current, near: self, focus: !!args.focus });
        return { id: w.id };
      }
      case 'edit': {
        if (!args.path) throw new Error('path required');
        const w = await openEditor(resolvePath(self?.cwd || lastCwd, args.path), { ws: self?.ws ?? current, near: self, focus: !!args.focus });
        return { id: w.id };
      }
      case 'diff': {
        const dir = projectDir(args.dir ? resolvePath(self?.cwd || lastCwd, args.dir) : (self?.cwd || lastCwd));
        const w = openDiff(dir, { ws: self?.ws ?? current, near: self, focus: !!args.focus });
        return { id: w.id };
      }
      case 'browse': {
        if (!args.url) throw new Error('url required');
        if (args.id != null) {
          const w = needTile(args.id);
          if (w.kind !== 'browser') throw new Error('tile is not a browser');
          browserNavigate(w, args.url);
          if (args.focus) { if (w.ws !== current) switchWorkspace(w.ws); focusWin(w); }
          return { id: w.id };
        }
        const w = openBrowser(args.url, { ws: self?.ws ?? current, near: self, focus: !!args.focus });
        return { id: w.id };
      }
      case 'shot': {
        const w = needTile(args.id);
        if (w.kind !== 'browser') throw new Error('tile is not a browser');
        let rect = null;
        if (args.selector) {
          const sel = JSON.stringify(args.selector);
          rect = await w.webview.executeJavaScript(`(() => { const e = document.querySelector(${sel}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
          if (!rect) throw new Error(`no match for ${args.selector}`);
        } else if (args.region) {
          const p = String(args.region).split(',').map(n => parseInt(n.trim(), 10));
          if (p.length !== 4 || p.some(Number.isNaN)) throw new Error('--region must be x,y,w,h');
          rect = { x: p[0], y: p[1], width: p[2], height: p[3] };
        }
        const img = rect ? await w.webview.capturePage(rect) : await w.webview.capturePage();
        const size = img.getSize();
        if (args.full) return { id: w.id, png: img.toDataURL().replace(/^data:image\/png;base64,/, ''), width: size.width, height: size.height };
        // NativeImage.resize()/toJPEG() cross the native binding and crash this sandboxed renderer -
        // downscale and re-encode through a plain <canvas> instead (DOM-only, no native image calls).
        const MAX_W = 1280;
        const width = Math.min(size.width, MAX_W) || 1, height = Math.round(size.height * (width / size.width)) || 1;
        const jpegUrl = await new Promise((resolve, reject) => {
          const el = new (window.Image)();
          el.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(el, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.75));
          };
          el.onerror = () => reject(new Error('could not decode the capture'));
          el.src = img.toDataURL();
        });
        return { id: w.id, jpeg: jpegUrl.replace(/^data:image\/jpeg;base64,/, ''), width, height };
      }
      case 'console': {
        const w = needTile(args.id);
        if (w.kind !== 'browser') throw new Error('tile is not a browser');
        let entries = w.console;
        if (args.new) { const last = browserConsoleCursors.get(cursorKey(self, w)) || 0; entries = entries.slice(last); }
        browserConsoleCursors.set(cursorKey(self, w), w.console.length);
        if (args.errors) entries = entries.filter(e => e.level >= 2);
        const cap = Math.min(Math.max(1, +args.lines || 60), 2000);
        const total = entries.length, shown = entries.slice(-cap);
        const text = shown.map(e => `[${LEVEL_NAME[e.level] || e.level}] ${e.message}${e.source ? ` (${e.source}:${e.line})` : ''}`).join('\n');
        return { id: w.id, text, total, shown: shown.length };
      }
      case 'text': {
        const w = needTile(args.id);
        if (w.kind !== 'browser') throw new Error('tile is not a browser');
        const sel = JSON.stringify(args.selector || 'body');
        const raw = await w.webview.executeJavaScript(`(() => { const e = document.querySelector(${sel}); return e ? e.innerText : ''; })()`).catch(e => { throw new Error(e.message || String(e)); });
        const lines = String(raw || '').replace(/[ \t]+/g, ' ').split('\n').map(l => l.trim()).filter((l, i, a) => l || a[i - 1]);
        const cleaned = lines.slice(0, 400);
        const text = cleaned.join('\n');
        return { id: w.id, text, total: cleaned.length, shown: cleaned.length };
      }
      case 'click': {
        const w = needTile(args.id);
        if (w.kind !== 'browser') throw new Error('tile is not a browser');
        if (!args.selector) throw new Error('selector required');
        const sel = JSON.stringify(args.selector);
        const ok = await w.webview.executeJavaScript(`(() => { const e = document.querySelector(${sel}); if (!e) return false; e.click(); return true; })()`);
        if (!ok) throw new Error(`no match for ${args.selector}`);
        return { id: w.id, ok: true };
      }
      case 'type': {
        const w = needTile(args.id);
        if (w.kind !== 'browser') throw new Error('tile is not a browser');
        if (!args.selector) throw new Error('selector required');
        const sel = JSON.stringify(args.selector), text = JSON.stringify(String(args.text ?? ''));
        const ok = await w.webview.executeJavaScript(`(() => {
          const e = document.querySelector(${sel}); if (!e) return false;
          e.focus(); e.value = ${text};
          e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        if (!ok) throw new Error(`no match for ${args.selector}`);
        if (args.enter) { w.webview.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); w.webview.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); }
        return { id: w.id, ok: true };
      }
      case 'url': {
        const w = needTile(args.id);
        if (w.kind !== 'browser') throw new Error('tile is not a browser');
        return { id: w.id, url: w.url, title: w.title, loading: w.loading };
      }
      case 'run': {
        if (!args.command) throw new Error('command required');
        const w = await newTerminal('shell', args.cwd || self?.cwd, {
          run: args.command, title: args.title || args.command.slice(0, 40), ws: self?.ws ?? current, near: self, focus: !!args.focus,
        });
        return { id: w.id };
      }
      case 'test': case 'build': {
        const cwd = args.cwd || self?.cwd || lastCwd;
        const command = args.command || await detectProjectCommand(cwd, cmd);
        if (!command) throw new Error(`couldn't spot a ${cmd} command in ${cwd} — pass one, e.g. operant ${cmd} "npm run ${cmd}"`);
        const w = await newTerminal('shell', cwd, {
          run: command, title: args.title || command.slice(0, 40), ws: self?.ws ?? current, near: self, focus: !!args.focus,
        });
        await waitQuiet(w, (args.idle ?? 3) * 1000, (args.timeout ?? 600) * 1000);
        const digest = digestOf(self, w);
        if (digest) return { id: w.id, command, digest };
        return { id: w.id, command, digest: null, text: readOutput(self, w, { lines: 400, errors: true }).text };
      }
      case 'agent': {
        if (!args.prompt) throw new Error('prompt required');
        let agentId = args.agent, model = args.model, effort = null, tier = null;
        if (args.tier) {
          tier = String(args.tier);
          const t = cfg.team?.tiers?.[tier];
          if (!t) throw new Error(`unknown tier "${tier}" - set it up in Settings › Agents › Team`);
          const names = Object.keys(cfg.team.tiers), top = names.indexOf(cfg.team.maxTier);
          if (top >= 0 && names.indexOf(tier) > top) throw new Error(`tier "${tier}" is above the top tier allowed (${cfg.team.maxTier}) - use --tier ${names.slice(0, top + 1).join(' or ')}`);
          const maxWorkers = cfg.team?.maxWorkers || 4;
          const workers = [...wins.values()].filter(x => x.alive && x.tier).length;
          if (workers >= maxWorkers) throw new Error(`max workers already running (${maxWorkers}) - wait for one to finish`);
          agentId = t.agent;
          model = model || t.model;
          if (!args.model) effort = t.effort || null;
        }
        if (agentId && !cfg.agents.some(a => a.id === agentId)) throw new Error(`unknown agent "${agentId}" - configured: ${cfg.agents.map(a => a.id).join(', ')}`);
        // Item 33: with --tier, a board task is added automatically, owned by the new worker tile,
        // with a final line telling it how to hand the result back.
        let taskId = null, prompt = args.prompt;
        let board = null;
        if (tier) {
          board = getBoard() || openBoard({ ws: self?.ws ?? current, near: self, focus: false });
          taskId = board.nextTaskId++;
          board.tasks.push({ id: taskId, text: String(args.prompt), status: 'todo', owner: null, note: null });
          renderBoard(board); saveSession();
          // No embedded newline/double-quotes here - the whole prompt is one quoted shell argument
          // (see pty:create in main.js), and those have caused it to be mis-split on Windows.
          prompt = `${args.prompt} — when done, run: operant task done ${taskId} --note '<what changed, files>'`;
        }
        const w = await newTerminal('ai', args.cwd || self?.cwd, {
          agentId, prompt, title: args.title, model, effort, worker: !!tier, ws: self?.ws ?? current, near: self, focus: !!args.focus,
        });
        if (tier) { w.tier = tier; const t = board.tasks.find(x => x.id === taskId); if (t) { t.owner = w.id; renderBoard(board); saveSession(); } }
        return { id: w.id, ...(tier ? { tier, taskId } : {}) };
      }
      case 'team': {
        const team = cfg.team || {};
        if (!team.enabled) return { enabled: false };
        const workers = [...wins.values()].filter(x => x.alive && x.tier).length;
        const names = Object.keys(team.tiers || {}), top = names.indexOf(team.maxTier);
        const tiers = top < 0 ? team.tiers || {} : Object.fromEntries(names.slice(0, top + 1).map(n => [n, team.tiers[n]]));
        return { enabled: true, tiers, maxWorkers: team.maxWorkers || 4, workers };
      }
      case 'read': {
        const w = needTile(args.id);
        if (args.digest) return { id: w.id, title: w.title, busy: isWorking(w), digest: digestOf(self, w) };
        const def = (args.errors || args.grep) ? 400 : 60;
        const lines = Math.min(Math.max(1, +args.lines || def), 2000);
        const { text, total, shown } = readOutput(self, w, { lines, isNew: !!args.new, errors: !!args.errors, grep: args.grep });
        return { id: w.id, title: w.title, busy: isWorking(w), text, total, shown };
      }
      case 'send': {
        const w = needTile(args.id);
        if (!w.ptyId) throw new Error('tile has no terminal to type into');
        operant.writePty(w.ptyId, String(args.text ?? '') + (args.enter ? '\r' : ''));
        return { id: w.id };
      }
      case 'wait': {
        const w = needTile(args.id);
        const exited = await waitQuiet(w, (args.idle ?? 3) * 1000, (args.timeout ?? 600) * 1000);
        if (args.digest) return { id: w.id, exited, digest: digestOf(self, w) };
        const def = args.errors ? 400 : 30;
        const lines = Math.min(Math.max(1, +args.lines || def), 2000);
        const r = readOutput(self, w, { lines, isNew: !!args.new, errors: !!args.errors, grep: args.grep });
        return { id: w.id, exited, text: r.text, total: r.total, shown: r.shown };
      }
      case 'usage': {
        if (!self) throw new Error('unknown tile');
        const ctx = self.ctx || null;
        return { id: self.id, tokens: ctx?.tokens ?? null, max: ctx?.max ?? null,
          pct: ctx && ctx.max ? Math.round((ctx.tokens / ctx.max) * 100) : null,
          project: self.cwd ? baseName(self.cwd) : null };
      }
      case 'compact': {
        if (!self) throw new Error('unknown tile');
        if (!self.ptyId) throw new Error('tile has no terminal to compact');
        queueCompact(self);
        return {};
      }
      case 'ports':
        return { ports: scanPorts() };
      case 'watch': {
        if (args.id == null) return { watches: [...watches].map(([id, st]) => ({ id, errors: !!st.errors, grep: st.grep || null })) };
        const w = needTile(args.id);
        if (args.off) { watches.delete(w.id); return { id: w.id, off: true }; }
        if (!args.errors && !args.grep) throw new Error('--errors or --grep required');
        if (!self) throw new Error('unknown tile');
        const pos = absPos(w), anchor = pos && w.term ? (w.term.buffer.active.getLine(pos - 1)?.translateToString(true) ?? '') : null;
        watches.set(w.id, { callerId: self.id, errors: !!args.errors, grep: args.grep || null, pos, anchor, debounceUntil: 0 });
        return { id: w.id, watching: true };
      }
      case 'notify': {
        if (!self) throw new Error('unknown tile');
        if (!args.text) throw new Error('text required');
        notify(self, args.title || self.title, args.text);
        return {};
      }
      case 'title':
        if (!self) throw new Error('unknown tile');
        setTitle(self, args.text || self.agentName || self.title);
        return {};
      case 'focus': {
        const w = needTile(args.id);
        if (w.ws !== current) switchWorkspace(w.ws);
        focusWin(w);
        return {};
      }
      case 'close': {
        const w = needTile(args.id);
        if (self && w.id === self.id && !args.force) throw new Error("pass force to close the tile you're running in");
        closeWin(w);
        return {};
      }
      case 'ws': {
        if (args.index != null) {
          const i = Number(args.index) - 1;
          if (!(i >= 0 && i < WS_COUNT)) throw new Error(`workspace ${args.index} out of range`);
          switchWorkspace(i);
        }
        if (args.name != null) {
          const names = Array.from({ length: WS_COUNT }, (_, j) => wsName(j));
          names[current] = String(args.name).trim();
          while (names.length && !names.at(-1)) names.pop();
          setSetting('workspaceNames', names);
          renderHints(); refreshBar();
        }
        return { current: current + 1 };
      }
      case 'plan': {
        if (!args.path) throw new Error('path required');
        const file = resolvePath(self?.cwd || lastCwd, args.path);
        let w = [...wins.values()].find(x => x.kind === 'view' && x.alive && normPath(x.file) === normPath(file));
        if (w) { if (normPath(w.file) !== normPath(file)) showFile(w, file); } else w = openViewer(file, { ws: self?.ws ?? current, near: self, focus: false });
        if (w.ws !== current) switchWorkspace(w.ws);
        focusWin(w);
        return new Promise(resolve => { w.planQueue.push(resolve); showPlanBar(w); });
      }
      case 'task': {
        const w = getBoard() || openBoard({ ws: self?.ws ?? current, near: self, focus: false });
        if (args.sub === 'add') {
          if (!args.text) throw new Error('text required');
          const id = w.nextTaskId++;
          w.tasks.push({ id, text: String(args.text), status: 'todo', owner: args.for != null ? Number(args.for) : null, note: null });
          renderBoard(w); saveSession();
          return { id, sub: 'add' };
        }
        const id = Number(args.id);
        const t = w.tasks.find(x => x.id === id);
        if (!t) throw new Error(`no task ${id}`);
        if (args.sub === 'claim') { if (!self) throw new Error('unknown tile'); t.owner = self.id; t.status = 'doing'; }
        else if (args.sub === 'done') { t.status = 'done'; if (args.note != null) t.note = String(args.note); }
        else if (args.sub === 'note') { if (!args.text) throw new Error('text required'); t.note = String(args.text); }
        else throw new Error(`unknown task command "${args.sub}"`);
        renderBoard(w); saveSession();
        return { id: t.id, status: t.status, note: t.note, sub: args.sub };
      }
      case 'board': {
        const w = getBoard();
        return { tasks: w ? w.tasks.map(t => ({ id: t.id, status: t.status, text: t.text, note: t.note, owner: fmtOwner(t.owner) })) : [] };
      }
      case 'remember': {
        if (!args.text) throw new Error('text required');
        const r = await operant.memory('remember', { cwd: projectDir(self?.cwd || lastCwd), text: args.text, type: args.type, global: !!args.global, about: args.about ? String(args.about).split(',').map(s => s.trim()).filter(Boolean) : [] });
        if (!r.ok) throw new Error(r.error);
        return r.result;
      }
      case 'recall': {
        const r = await operant.memory('recall', { cwd: projectDir(self?.cwd || lastCwd), query: args.query, about: args.about });
        if (!r.ok) throw new Error(r.error);
        return r.result;
      }
      default:
        throw new Error(`unknown command "${cmd}"`);
    }
  }

  operant.onControl(async ({ reqId, cmd, args, tile }) => {
    const self = wins.get(Number(tile));
    // A watch hit on a tile this caller is watching for shows once on its very next call, of any kind.
    const warn = self && watchPrefix.get(self.id);
    if (warn) watchPrefix.delete(self.id);
    try {
      const result = await runControl(cmd, args || {}, self);
      operant.controlReply({ reqId, ok: true, result, warn });
    } catch (e) {
      operant.controlReply({ reqId, ok: false, error: e.message || String(e), warn });
    }
  });
})();
