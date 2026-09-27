// The Settings and Keybinds panels. They only draw and report changes;
// renderer.js owns the config, applies it and saves it.

// The sidebar's "Open in IDE": [command, name]. The folder is passed as the command's argument.
const IDES = [['code', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'],
  ['idea', 'IntelliJ IDEA'], ['rider', 'Rider'], ['subl', 'Sublime Text'], ['custom', 'Custom command']];

const Panels = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const pct = v => Math.round(v * 100) + '%';
  const px = v => v + 'px';
  const KEY_NAMES = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\',Semicolon: ';', Quote: "'", Backquote: '`',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']' };
  const pretty = combo => combo.replace(/[A-Za-z]+$/, k => KEY_NAMES[k] || k);

  const RESTART = 'Applies after a restart';
  const NEW_TILES = 'Applies to new tiles';

  const SECTIONS = [
    ['Appearance', [
      { key: 'theme', type: 'theme' },
      { key: 'accent', label: 'Accent color', type: 'accent' },
      { key: 'wallpaper', label: 'Wallpaper', type: 'select', options: [['glow-dots', 'Glow + dots'], ['glow', 'Glow'], ['plain', 'Plain']] },
      { key: 'borderAnimation', label: 'Animated border', hint: 'Only the border moves, never the tile behind it', type: 'select',
        options: [['active', 'Focused + running agents'], ['focused', 'Focused tile only'], ['off', 'Off']] },
      { key: 'borderAnimationSeconds', label: 'Border animation cycle', hint: 'Lower is faster', type: 'range', min: 2, max: 20, step: 1, fmt: v => v + 's' },
      { key: 'opacity', label: 'Tile opacity', type: 'range', min: 0.4, max: 1, step: 0.01, fmt: pct },
      { key: 'blur', label: 'Tile blur', type: 'range', min: 0, max: 40, step: 1, fmt: px },
      { key: 'rounding', label: 'Corner rounding', type: 'range', min: 0, max: 24, step: 1, fmt: px },
      { key: 'borderSize', label: 'Border width', type: 'range', min: 1, max: 6, step: 1, fmt: px },
      { key: 'gapsIn', label: 'Gap between tiles', type: 'range', min: 0, max: 24, step: 1, fmt: px },
      { key: 'gapsOut', label: 'Gap at screen edges', type: 'range', min: 0, max: 48, step: 1, fmt: px },
    ]],
    ['Terminal', [
      { key: 'fontFamily', label: 'Font', type: 'text' },
      { key: 'fontSize', label: 'Font size', type: 'range', min: 9, max: 24, step: 1, fmt: px },
      { key: 'lineHeight', label: 'Line height', type: 'range', min: 1, max: 1.6, step: 0.05, fmt: v => (+v).toFixed(2) },
      { key: 'cursorStyle', label: 'Cursor', type: 'select', options: [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']] },
      { key: 'cursorBlink', label: 'Blinking cursor', type: 'toggle' },
      { key: 'scrollback', label: 'Scrollback lines', type: 'number', min: 1000, max: 200000, step: 1000 },
    ]],
    ['Layout', [
      { key: 'defaultLayout', label: 'Default layout', hint: 'For empty workspaces; Alt+M switches the current one',
        type: 'select', options: [['master', 'Master + stack'], ['dwindle', 'Dwindle']] },
      { key: 'masterRatio', label: 'Master width', hint: 'For empty workspaces', type: 'range', min: 0.2, max: 0.85, step: 0.01, fmt: pct },
      { key: 'maxTilesPerWorkspace', label: 'Tiles per workspace', hint: 'New agents spill onto the next workspace past this', type: 'number', min: 1, max: 16 },
    ]],
    ['Agents', [
      { key: 'agents', type: 'agents' },
      { key: 'defaultAgent', label: 'Default agent', hint: 'Alt+Enter, the master tile and Explorer\'s entry open this', type: 'select',
        options: cfg => cfg.agents.map(a => [a.id, a.name]) },
    ]],
    ['Notifications', [
      { key: 'notifications', label: 'Windows notifications', type: 'toggle' },
      { key: 'notifyWhenIdleSeconds', label: 'Agent is waiting for you', hint: 'Notify when a working agent goes quiet for this many seconds · 0 = off', type: 'number', min: 0, max: 600 },
      { key: 'notifySubagents', label: 'Claude subagent finished', type: 'toggle' },
      { key: 'notifyOnlyUnfocused', label: 'Only when I\'m not looking at it', hint: 'Skip it for the focused tile while Operant is in front', type: 'toggle' },
    ]],
    ['Tiles & subagents', [
      { key: 'showExternalAgents', label: 'Show subagents from other Claude sessions', hint: 'Your IDE, other terminals', type: 'toggle' },
      { key: 'autoCloseDoneAgentsSeconds', label: 'Close finished agents after', hint: 'Seconds after you first see them · running agents never close · 0 = never', type: 'number', min: 0, max: 86400 },
      { key: 'idleCloseTerminalMinutes', label: 'Close idle terminals after', hint: 'Minutes · 0 = never · the master and focused tile stay', type: 'number', min: 0, max: 1440 },
      { key: 'agentLookbackSeconds', label: 'Pick up agents started before launch', hint: 'Seconds · ' + RESTART, type: 'number', min: 0, max: 3600 },
    ]],
    ['Sidebar', [
      { key: 'sidebar', label: 'Projects sidebar', hint: 'Pinned projects and a folder tree on the left · the ▭ in the bar or Alt+B toggles it', type: 'toggle' },
      { key: 'sidebarWidth', label: 'Sidebar width', hint: 'Or drag its right edge', type: 'range', min: 160, max: 600, step: 10, fmt: px },
      { key: 'sidebarHiddenFiles', label: 'Show hidden files', hint: 'Dotfiles like .git and .claude', type: 'toggle' },
      { key: 'ide', label: 'IDE', hint: 'What a folder\'s "Open in IDE" button opens it in', type: 'select', options: IDES },
      { key: 'ideCommand', label: 'Custom IDE command', hint: 'When IDE is Custom command · the folder is added at the end, e.g. "C:\\Tools\\IDE\\bin\\ide64.exe"', type: 'text' },
    ]],
    ['Media', [
      { key: 'mediaControls', label: 'Media controls in the top bar', hint: 'What Windows is playing (Spotify, a browser tab…): cover, track, buttons and that app’s volume', type: 'toggle' },
    ]],
    ['Startup', [
      { key: 'masterOnStartup', label: 'Open a master agent on startup', type: 'toggle' },
      { key: 'defaultCwd', label: 'Default folder', type: 'folder' },
      { key: 'shell', label: 'Shell', hint: 'PowerShell runs the agents · ' + NEW_TILES, type: 'text' },
      { key: 'explorerContextMenu', label: 'Explorer right-click entry', hint: '"Open in Operant" on folders (installed app)', type: 'toggle' },
      { key: 'explorerOpensIn', label: '"Open in Operant" opens', hint: 'Starting Operant again always opens another window', type: 'select',
        options: [['tile', 'A tile in the window I used last'], ['window', 'A new Operant window']] },
    ]],
    ['Keybinds', [
      { type: 'keys', label: 'Keybinds shortcuts keys' },
    ]],
    ['CodeGraph', [
      { type: 'codegraph', label: 'CodeGraph install index init version' },
      { key: 'codegraphButtons', label: 'CodeGraph buttons in the sidebar', hint: '◇ on each project, in the header for all of them and in the folder right-click menu', type: 'toggle' },
    ]],
    ['Updates', [
      { type: 'updates', label: 'Check for updates version release' },
      { key: 'autoUpdate', label: 'Update automatically', hint: 'Checks at startup and every 3 hours, downloads in the background, installs when you click the pill or quit · ' + RESTART, type: 'toggle' },
    ]],
  ];
  const TAB_ICONS = { Appearance: '◐', Terminal: '❯', Layout: '▦', Agents: '✻', Notifications: '◔', 'Tiles & subagents': '◆',
    Sidebar: '▌', Media: '♫', Startup: '⏻', Keybinds: '⌨', CodeGraph: '◇', Updates: '↻' };

  function control(it, v, cfg) {
    switch (it.type) {
      case 'range': return `<input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}"><span class="val">${esc(it.fmt(v))}</span>`;
      case 'number': return `<input type="number" data-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step || 1}" value="${v}">`;
      case 'toggle': return `<button class="toggle${v ? ' on' : ''}" data-key="${it.key}"></button>`;
      case 'select': return `<select data-key="${it.key}">${(typeof it.options === 'function' ? it.options(cfg) : it.options).map(([o, n]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
      case 'list': return `<input type="text" data-key="${it.key}" value="${esc([].concat(v).join(' '))}">`;
      case 'folder': return `<input type="text" data-key="${it.key}" value="${esc(v)}"><button class="btn" data-browse="${it.key}">Browse…</button>`;
      case 'accent': {
        const auto = !v;
        return `<div class="accents"><button class="accent-dot auto${auto ? ' on' : ''}" data-accent="" title="Theme default"></button>`
          + ACCENTS.map(([c, n]) => `<button class="accent-dot${v === c ? ' on' : ''}" data-accent="${c}" title="${n}" style="background:${c}"></button>`).join('')
          + `<input type="color" data-key="accent" value="${v || THEMES[currentTheme]?.accent || '#d97757'}" title="Custom color"></div>`;
      }
      default: return `<input type="text" data-key="${it.key}" value="${esc(v)}">`;
    }
  }

  function themeCards(v) {
    return `<div class="themes">${Object.entries(THEMES).map(([id, t]) => `
      <button class="theme-card${id === v ? ' on' : ''}" data-theme="${id}">
        <div class="sw" style="background: radial-gradient(ellipse at 50% 130%, ${t.glow}, ${t.bg} 70%)">
          <div class="t" style="background: rgb(${t.glass}); color: ${t.accent}; --tx: ${t.text}; box-shadow: 0 0 0 1px ${t.inactive}"></div>
        </div>
        <div class="nm">${t.name}<small>${t.note}</small></div>
      </button>`).join('')}</div>`;
  }

  let currentTheme = 'obsidian';

  // The agent CLIs: icon, name, command and arguments, one row each.
  function agentsEditor(list) {
    return `<div class="agent-list"><div class="agent-row agent-head"><span></span><span>Name</span><span>Command</span><span>Arguments</span><span></span></div>`
      + list.map((a, i) => `<div class="agent-row" data-agent="${i}">
        <input class="icon" data-f="icon" value="${esc(a.icon || '')}" maxlength="2" title="Icon">
        <input data-f="name" value="${esc(a.name)}" placeholder="Name">
        <input data-f="command" value="${esc(a.command)}" placeholder="command" spellcheck="false">
        <input data-f="args" value="${esc([].concat(a.args || []).join(' '))}" placeholder="--flags" spellcheck="false">
        <button class="rm" data-agent-rm="${i}" title="Remove">✕</button></div>`).join('')
      + `</div><div class="set-row"><div class="lbl"><span class="hint">Any command that runs in a terminal works. Claude Code tiles also get their subagents as tiles. ${NEW_TILES}.</span></div>
        <div class="ctl"><button class="btn" data-agent-add>+ Add agent</button></div></div>`;
  }

  // The Updates tab: this version, the last check and what to do next.
  function updatesCard(u) {
    const s = u.status || {};
    const at = s.at ? new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const line = {
      checking: 'Checking for updates…',
      current: `You're on the latest version${at ? ` · checked at ${at}` : ''}`,
      downloading: `Downloading ${s.version}…`,
      ready: `${s.version} is downloaded and ready to install`,
      error: `Couldn't check: ${s.message || 'unknown error'}`,
    }[s.state] || 'Not checked yet this session';
    const busy = s.state === 'checking' || s.state === 'downloading';
    const btn = s.state === 'ready'
      ? '<button class="btn primary" data-update="install">Restart and install</button>'
      : `<button class="btn" data-update="check"${busy ? ' disabled' : ''}>${busy ? 'Checking…' : 'Check for updates'}</button>`;
    return `<div class="update-card"><span class="uc-logo">◈</span><div class="uc-main"><div class="uc-name">Operant ${esc(u.version)}</div>`
      + `<div class="uc-status ${esc(s.state || '')}">${esc(line)}</div></div>${btn}</div>`
      + (s.notes && (s.state === 'ready' || s.state === 'downloading')
        ? `<details class="uc-notes" open><summary>What's new in ${esc(s.version)}</summary><div class="md">${md(s.notes)}</div></details>`
        : s.notes && s.state === 'current' ? `<details class="uc-notes"><summary>What's new in this version</summary><div class="md">${md(s.notes)}</div></details>` : '')
      + '<div class="uc-links"><button class="link" data-update="releases">All releases on GitHub ↗</button></div>';
  }

  // Release notes are Markdown: headings, lists, bold/italic, `code`, links and --- rules. HTML is escaped first.
  function md(src) {
    const inline = t => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="#" data-link="$2">$1</a>');
    let html = '', list = null, para = [];
    const flush = () => {
      if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; }
      if (list) { html += `</${list}>`; list = null; }
    };
    for (const raw of String(src).replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) flush();
      else if (/^\s*(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); html += '<hr>'; }
      else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(m[1].length + 2, 6); html += `<h${n}>${inline(m[2])}</h${n}>`; }
      else if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
        const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (para.length || list !== tag) flush();
        if (!list) { html += `<${tag}>`; list = tag; }
        html += `<li>${inline(m[2])}</li>`;
      } else if (list && /^\s+\S/.test(raw)) html = html.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
      else { if (list) flush(); para.push(line.trim()); }
    }
    flush();
    return html;
  }

  // The last tab you had open comes back next time.
  let tab = 'Appearance', query = '';
  try { tab = localStorage.getItem('operant.settings.tab') || tab; } catch {}
  const settingsTab = () => (query ? '' : tab);

  function rowHtml(it, cfg, ext) {
    if (it.type === 'theme') return themeCards(cfg.theme);
    if (it.type === 'agents') return agentsEditor(cfg.agents);
    if (it.type === 'keys') return '<div class="set-keys"></div>';
    if (it.type === 'codegraph') return '<div class="cg-card"></div>';
    if (it.type === 'updates') return updatesCard(ext.update());
    return `<div class="set-row"><div class="lbl">${it.label}${it.hint ? `<span class="hint">${it.hint}</span>` : ''}</div><div class="ctl">${control(it, cfg[it.key], cfg)}</div></div>`;
  }

  // Tabs down the left, one section at a time; typing in the search box shows matches from all of them.
  // set(key, value) applies and saves one setting. ext: { renderKeys(el), renderCodegraph(el), update(), checkUpdate(), installUpdate(), openReleases() }
  function renderSettings(body, cfg, set, pickFolder, ext) {
    currentTheme = cfg.theme;
    if (!SECTIONS.some(s => s[0] === tab)) tab = SECTIONS[0][0];
    body.innerHTML = `<div class="set-layout"><nav class="set-nav">
        <input class="set-search" type="search" placeholder="Search settings" value="${esc(query)}" spellcheck="false">
        ${SECTIONS.map(([t]) => `<button class="set-tab" data-tab="${esc(t)}"><span class="ti">${TAB_ICONS[t] || '•'}</span>${esc(t)}</button>`).join('')}
      </nav><div class="set-pane"></div></div>`;
    const pane = body.querySelector('.set-pane');
    const search = body.querySelector('.set-search');
    const markTabs = () => body.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', !query && b.dataset.tab === tab));

    function draw() {
      const top = pane.scrollTop;
      const q = query.trim().toLowerCase();
      let html;
      if (!q) {
        const items = SECTIONS.find(s => s[0] === tab)[1];
        html = `<div class="pane-title">${esc(tab)}</div>` + items.map(it => rowHtml(it, cfg, ext)).join('');
      } else {
        const hits = SECTIONS.map(([t, items]) => [t, items.filter(it => `${t} ${it.label || it.key || ''} ${it.hint || ''} ${it.type === 'theme' ? 'theme colors' : ''} ${it.type === 'agents' ? 'agents commands' : ''}`.toLowerCase().includes(q))])
          .filter(([, items]) => items.length);
        html = hits.length ? hits.map(([t, items]) => `<div class="set-section"><h3>${esc(t)}</h3>${items.map(it => rowHtml(it, cfg, ext)).join('')}</div>`).join('')
          : `<div class="set-none">Nothing matches “${esc(query)}”.</div>`;
      }
      pane.innerHTML = html;
      pane.scrollTop = top;
      bind();
    }

    function bind() {
      const item = key => SECTIONS.flatMap(s => s[1]).find(i => i.key === key);
      const keysEl = pane.querySelector('.set-keys');
      if (keysEl) ext.renderKeys(keysEl);
      const cgEl = pane.querySelector('.cg-card');
      if (cgEl) ext.renderCodegraph(cgEl);
      pane.querySelectorAll('[data-update]').forEach(b => b.onclick = () => {
        const a = b.dataset.update;
        if (a === 'check') { ext.checkUpdate(); b.disabled = true; b.textContent = 'Checking…'; }
        else if (a === 'install') ext.installUpdate();
        else ext.openReleases();
      });
      pane.querySelectorAll('[data-link]').forEach(a => a.onclick = e => { e.preventDefault(); ext.openLink(a.dataset.link); });
      pane.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { set('theme', b.dataset.theme); currentTheme = cfg.theme; draw(); });
      pane.querySelectorAll('[data-accent]').forEach(b => b.onclick = () => { set('accent', b.dataset.accent); draw(); });
      pane.querySelectorAll('[data-browse]').forEach(b => b.onclick = async () => {
        const d = await pickFolder();
        if (d) { set(b.dataset.browse, d); draw(); }
      });
      const setAgents = list => { set('agents', list); if (!list.some(a => a.id === cfg.defaultAgent) && list[0]) set('defaultAgent', list[0].id); };
      pane.querySelectorAll('[data-agent] input').forEach(el => el.onchange = () => {
        const i = +el.closest('[data-agent]').dataset.agent, f = el.dataset.f;
        const list = cfg.agents.map(a => ({ ...a }));
        list[i][f] = f === 'args' ? el.value.split(/\s+/).filter(Boolean) : el.value.trim();
        if (f === 'name' && !list[i].name) list[i].name = list[i].command || 'Agent';
        setAgents(list);
        if (f === 'name') draw();
      });
      pane.querySelectorAll('[data-agent-rm]').forEach(b => b.onclick = () => { setAgents(cfg.agents.filter((_, j) => j !== +b.dataset.agentRm)); draw(); });
      const add = pane.querySelector('[data-agent-add]');
      if (add) add.onclick = () => {
        setAgents([...cfg.agents, { id: 'agent-' + Date.now().toString(36), name: 'New agent', command: '', args: [], icon: '●' }]);
        draw();
        pane.querySelector('.agent-row:last-of-type [data-f="command"]')?.focus();
      };
      pane.querySelectorAll('[data-key]').forEach(el => {
        const it = item(el.dataset.key) || { type: 'text' };
        if (it.type === 'toggle') return el.onclick = () => { set(it.key, !cfg[it.key]); el.classList.toggle('on', cfg[it.key]); };
        if (el.type === 'color') return el.oninput = () => { set('accent', el.value); pane.querySelectorAll('.accent-dot').forEach(d => d.classList.remove('on')); };
        if (it.type === 'range') return el.oninput = () => { set(it.key, +el.value); el.nextElementSibling.textContent = it.fmt(+el.value); };
        el.onchange = () => {
          if (it.type === 'number') {
            const n = Math.min(it.max, Math.max(it.min, Math.round(+el.value || 0)));
            el.value = n; set(it.key, n);
          } else if (it.type === 'list') set(it.key, el.value.split(/\s+/).filter(Boolean));
          else set(it.key, el.type === 'text' ? el.value.trim() : el.value);
        };
      });
    }

    body.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
      tab = b.dataset.tab; query = ''; search.value = '';
      try { localStorage.setItem('operant.settings.tab', tab); } catch {}
      markTabs(); pane.scrollTop = 0; draw();
    });
    search.oninput = () => { query = search.value; markTabs(); pane.scrollTop = 0; draw(); };
    markTabs();
    draw();
  }

  // ------------------------------------------------------------ keybinds

  const GROUPS = [
    ['Tiles', { newAgent: 'New default agent', pickAgent: 'Pick an agent…', newAgentIn: 'New agent in folder…', newShell: 'New shell', close: 'Close tile',
      fullscreen: 'Fullscreen tile', promoteMaster: 'Make focused tile the master', closeDoneAgents: 'Close finished subagents', toggleSidebar: 'Show / hide the sidebar' }],
    ['Focus & swap', { focusLeft: 'Focus ←', focusRight: 'Focus →', focusUp: 'Focus ↑', focusDown: 'Focus ↓',
      swapLeft: 'Swap ←', swapRight: 'Swap →', swapUp: 'Swap ↑', swapDown: 'Swap ↓' }],
    ['Layout', { toggleLayout: 'Master ⇄ dwindle layout', toggleSplit: 'Flip split direction',
      resizeLeft: 'Resize ←', resizeRight: 'Resize →', resizeUp: 'Resize ↑', resizeDown: 'Resize ↓' }],
    ['Media', { mediaPlayPause: 'Play / pause', mediaNext: 'Next track', mediaPrev: 'Previous track', mediaShuffle: 'Shuffle' }],
    ['Workspaces', { prevWorkspace: 'Previous workspace', nextWorkspace: 'Next workspace' }],
    ['App', { help: 'Keybinds (this popup)', settings: 'Settings', newWindow: 'New Operant window', openConfig: 'Edit config.json', devtools: 'DevTools' }],
  ];
  const actionName = a => GROUPS.map(g => g[1][a]).find(Boolean) || a;

  // recording: the action currently waiting for a key, or null.
  function renderKeys(body, keybinds, recording, { onAdd, onRemove }) {
    const chips = a => [].concat(keybinds[a] || []).map((k, i) => `<span class="chip">${esc(pretty(k))}<button class="rm" data-rm="${a}" data-i="${i}" title="Remove">✕</button></span>`).join('')
      + `<button class="chip add${recording === a ? ' recording' : ''}" data-add="${a}">${recording === a ? 'press keys… (Esc cancels)' : '+'}</button>`;
    body.innerHTML = GROUPS.map(([title, acts]) => `<div class="kb-group"><h3>${title}</h3><div class="kb-grid">${
      Object.entries(acts).map(([a, n]) => `<div class="kb-row"><span class="name">${n}</span><span class="kb-keys">${chips(a)}</span></div>`).join('')
      + (title === 'Workspaces' ? `<div class="kb-row"><span class="name">Go to workspace</span><span class="kb-keys"><span class="chip fixed">Alt+1…9</span></span></div>
        <div class="kb-row"><span class="name">Move tile to workspace</span><span class="kb-keys"><span class="chip fixed">Alt+Shift+1…9</span></span></div>` : '')
    }</div></div>`).join('')
      + `<div class="kb-mouse"><h3>Mouse</h3>
        Click a tile to focus · <kbd>Alt</kbd>+drag onto another tile to swap · <kbd>Alt</kbd>+right-drag to resize · <kbd>Alt</kbd>+wheel switches workspace ·
        <kbd>Ctrl+C</kbd> copies a selection, <kbd>Ctrl+V</kbd> pastes</div>`;
    body.querySelectorAll('[data-add]').forEach(b => b.onclick = () => onAdd(b.dataset.add));
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => onRemove(b.dataset.rm, +b.dataset.i));
  }

  return { renderSettings, renderKeys, actionName, pretty, settingsTab };
})();
