// The Settings and Keybinds panels. They only draw and report changes;
// renderer.js owns the config, applies it and saves it.

// The sidebar's "Open in IDE": [command, name]. The folder is passed as the command's argument.
const IDES = [['code', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'],
  ['idea', 'IntelliJ IDEA'], ['rider', 'Rider'], ['subl', 'Sublime Text'], ['custom', 'Custom command']];

// Token usage series: [config key, name]. Their colors are .s-<key> in style.css.
const USAGE_SERIES = [['input', 'Input'], ['output', 'Output'], ['cacheWrite', 'Cache write'], ['cacheRead', 'Cache read']];

const Panels = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const pct = v => Math.round(v * 100) + '%';
  const px = v => v + 'px';
  const KEY_NAMES = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\',Semicolon: ';', Quote: "'", Backquote: '`',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']' };
  const pretty = combo => combo.replace(/[A-Za-z]+$/, k => KEY_NAMES[k] || k);

  const RESTART = 'Applies after a restart';
  // Token counts as typed and shown in Settings: 2M, 1.5m, 500k, 1200000.
  const fmtTokens = n => n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n);
  const parseTokens = t => {
    const m = String(t).trim().replace(/[,_\s]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/i);
    return m ? Math.round(+m[1] * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1)) : null;
  };
  const NEW_TILES = 'Applies to new tiles';

  const SECTIONS = [
    ['Appearance', [
      { key: 'theme', type: 'theme' },
      { key: 'accent', label: 'Accent color', type: 'accent' },
      { key: 'wallpaper', label: 'Wallpaper', type: 'select', options: [['glow-dots', 'Glow + dots'], ['glow', 'Glow'], ['plain', 'Plain']] },
      { key: 'borderAnimation', label: 'Animated border', hint: 'Only the border moves, never the tile behind it', type: 'select',
        options: [['active', 'Focused + running agents'], ['focused', 'Focused tile only'], ['off', 'Off']] },
      { key: 'borderAnimationSeconds', label: 'Border animation cycle', hint: 'Lower is faster', type: 'range', min: 2, max: 20, step: 1, fmt: v => v + 's' },
      { key: 'animations', label: 'Animations', hint: 'Tile, workspace and border animations · Off is the lightest', type: 'select',
        options: [['normal', 'Normal'], ['fast', 'Fast'], ['off', 'Off']] },
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
      { key: 'gpuTerminals', label: 'GPU-accelerated terminals', hint: 'Draws terminal text with WebGL, much faster for busy tiles · needs hardware acceleration · turn off if text looks wrong', type: 'toggle' },
      { key: 'hardwareAcceleration', label: 'Hardware acceleration', hint: 'Use the graphics card for the whole window · turn off if Operant flickers or draws wrongly · ' + RESTART, type: 'toggle' },
      { key: 'copyOnSelect', label: 'Copy text when you select it', hint: 'In terminals, viewers and diffs · a small Copied note shows', type: 'toggle' },
    ]],
    ['Layout', [
      { key: 'defaultLayout', label: 'Default layout', hint: 'For empty workspaces; Alt+M switches the current one',
        type: 'select', options: [['master', 'Master + stack'], ['dwindle', 'Dwindle']] },
      { key: 'masterRatio', label: 'Master width', hint: 'For empty workspaces', type: 'range', min: 0.2, max: 0.85, step: 0.01, fmt: pct },
      { key: 'maxTilesPerWorkspace', label: 'Tiles per workspace', hint: 'New agents spill onto the next workspace past this', type: 'number', min: 1, max: 16 },
      { key: 'moveFollowsTile', label: 'Go with a moved tile', hint: 'Alt+Shift+1–9 moves the focused tile to that workspace and takes you there', type: 'toggle' },
    ]],
    ['Agents', [
      { key: 'agents', type: 'agents' },
      { key: 'defaultAgent', label: 'Default agent', hint: 'Alt+Enter, the master tile and Explorer\'s entry open this', type: 'select',
        options: cfg => cfg.agents.map(a => [a.id, a.name]) },
      { key: 'opencodeTheme', label: 'OpenCode uses Operant’s theme', hint: 'OpenCode tiles get the current theme and accent, with a see-through background · your own OpenCode settings stay as they are · applies to new OpenCode tiles', type: 'toggle' },
      { key: 'installSkill', label: 'Operant skill for agents',
        hint: 'Installs a skill that lets Claude Code and OpenCode use Operant: show you files, run commands in their own tiles, start other agents, ask you questions · the operant command works in every tile',
        type: 'toggle' },
      { key: 'briefAgents', label: 'Brief agents at launch', hint: 'A short brief in every agent tile\'s first message (master, workers, reopened) so the rules apply from the start, not only once it loads the skill', type: 'toggle' },
      { key: 'longCommandHook', label: 'Reroute long commands', hint: 'Claude Code only: a hook rewrites test/build/install commands to operant run/wait automatically, so the savings don\'t depend on the agent remembering', type: 'toggle' },
      { key: 'autoCompact', label: 'Auto compact at', hint: 'When a tile\'s context passes this percent: waits for it to go idle, asks it to save a progress note, then compacts it (Claude Code: /compact · OpenCode: its own summarize, falling back to /compact) · 0 = off',
        type: 'number', min: 0, max: 100 },
      { key: 'cacheTtlMinutes', label: 'Prompt cache lifetime', hint: 'Minutes an idle tile\'s cache stays warm before its next message pays full price · 60 if your setup uses the 1-hour cache', type: 'number', min: 1, max: 120 },
      { key: 'compactBeforeCold', label: 'Compact before the cache goes cold', hint: 'Compact big idle agents just before their prompt cache expires, instead of paying to rebuild it', type: 'toggle' },
      { key: 'team', type: 'team' },
      { key: 'shareSetup', label: 'Share your main agent\'s setup',
        hint: 'Rules, MCP servers and skills from your default agent (above) reach every agent you launch, for that process only · never edits your agents\' own config files',
        type: 'toggle' },
    ]],
    ['Notifications', [
      { key: 'notifications', label: 'Windows notifications', type: 'toggle' },
      { key: 'notifyWhenIdleSeconds', label: 'Agent is waiting for you', hint: 'Notify when a working agent goes quiet for this many seconds · 0 = off', type: 'number', min: 0, max: 600 },
      { key: 'notifySubagents', label: 'Claude subagent finished', type: 'toggle' },
      { key: 'notifyOnlyUnfocused', label: 'Only when I\'m not looking at it', hint: 'Skip it for the focused tile while Operant is in front', type: 'toggle' },
    ]],
    ['Tiles & subagents', [
      { key: 'confirmClose', label: 'Ask before closing with terminals running', hint: 'Closing a window ends its terminals', type: 'toggle' },
      { key: 'restoreSession', label: 'Reopen my tiles', hint: 'Same tiles, folders and layout · Claude Code conversations pick up where they left off',
        type: 'select', options: [['update', 'After an update'], ['always', 'Every time Operant starts'], ['never', 'Never']] },
      { key: 'updateWhenIdle', label: 'Wait for agents before updating', hint: 'Clicking Update while an agent is working installs once it finishes', type: 'toggle' },
      { key: 'saveQuitWaits', label: 'Let agents finish before Save and quit', hint: 'Asks working agents to save a progress note and stop at a safe point · Force quit skips it', type: 'toggle' },
      { key: 'showExternalAgents', label: 'Show subagents from other Claude Code and OpenCode sessions', hint: 'Your IDE, other terminals', type: 'toggle' },
      { key: 'autoCloseDoneAgentsSeconds', label: 'Close finished agents after', hint: 'Seconds after you first see them · running agents never close · 0 = never', type: 'number', min: 0, max: 86400 },
      { key: 'idleCloseTerminalMinutes', label: 'Close idle terminals after', hint: 'Minutes · 0 = never · the master and focused tile stay', type: 'number', min: 0, max: 1440 },
      { key: 'agentLookbackSeconds', label: 'Pick up agents started before launch', hint: 'Seconds · ' + RESTART, type: 'number', min: 0, max: 3600 },
      { key: 'runawayGuard', label: 'Runaway guard', hint: 'A tile stuck in a loop, burning tokens or piling up subagents', type: 'select',
        options: [['warn', 'Warn me'], ['stop', 'Stop it'], ['off', 'Off']] },
      { key: 'runawayLoopRepeats', label: 'Same tool call repeated', hint: 'Times, within its last 20 tool calls', type: 'number', min: 3, max: 50 },
      { key: 'runawayTokens', label: 'Tokens in 10 minutes', hint: '0 = off', type: 'tokens' },
      { key: 'runawayMinutes', label: 'Working without a break, minutes', hint: '0 = off', type: 'number', min: 0, max: 600 },
      { key: 'runawaySubagents', label: 'Subagents at once', hint: '0 = off', type: 'number', min: 0, max: 100 },
    ]],
    ['Sidebar', [
      { key: 'sidebar', label: 'Projects sidebar', hint: 'Pinned projects and a folder tree on the left · the ▭ in the bar or Alt+B toggles it', type: 'toggle' },
      { key: 'sidebarWidth', label: 'Sidebar width', hint: 'Or drag its right edge', type: 'range', min: 160, max: 600, step: 10, fmt: px },
      { key: 'sidebarHiddenFiles', label: 'Show hidden files', hint: 'Dotfiles like .git and .claude', type: 'toggle' },
      { key: 'sidebarGit', label: 'Git in the sidebar', hint: 'Each project’s branch and number of changed files (click it to see the changes) · changed files tinted', type: 'toggle' },
      { key: 'ide', label: 'IDE', hint: 'What a folder\'s "Open in IDE" button opens it in', type: 'select', options: IDES },
      { key: 'ideCommand', label: 'Custom IDE command', hint: 'When IDE is Custom command · the folder is added at the end, e.g. "C:\\Tools\\IDE\\bin\\ide64.exe"', type: 'text' },
    ]],
    ['Projects', [
      { type: 'projects', label: 'Project defaults agent arguments startup command per project' },
    ]],
    ['Files', [
      { key: 'fileOpens', label: 'Double-clicking a file in the sidebar', hint: 'Right-click a file for the others', type: 'select',
        options: [['view', 'Views it in Operant'], ['edit', 'Edits it in a terminal'], ['system', 'Opens it with Windows']] },
      { key: 'editor', label: 'Editor', hint: 'The terminal editor for “Edit” · Auto takes the first found: Neovim, Vim, micro, Edit, nano', type: 'select',
        options: [['auto', 'Auto'], ['vim', 'Vim'], ['nvim', 'Neovim'], ['micro', 'micro'], ['nano', 'nano'], ['edit', 'Edit (Windows)'], ['custom', 'Custom command']] },
      { key: 'configOpensIn', label: 'Edit config.json in', hint: 'The settings file, from Settings’ Open config.json button', type: 'select',
        options: [['system', 'Windows’ app for .json'], ['editor', 'The editor tile (vim…)']] },
      { key: 'editorCommand', label: 'Custom editor command', hint: 'When Editor is Custom command · the file is added at the end, e.g. "C:\\Tools\\hx.exe"', type: 'text' },
    ]],
    ['Top bar', [
      { key: 'clockFormat', label: 'Clock', hint: 'Hover it for a calendar · click it to copy the time and date', type: 'select',
        options: [['auto', 'Like Windows'], ['24', '24-hour'], ['12', '12-hour']] },
      { key: 'clockSeconds', label: 'Show seconds', type: 'toggle' },
      { key: 'clockDate', label: 'Show the date', type: 'toggle' },
      { key: 'barTitle', label: 'Focused tile’s title beside the clock', type: 'toggle' },
      { key: 'gitButton', label: 'Git tile', hint: 'In the gear’s quick menu: the focused project’s branch and changes · click to see and commit them', type: 'toggle' },
    ]],
    ['Media', [
      { key: 'mediaControls', label: 'Media controls in the top bar', hint: 'What Windows is playing (Spotify, a browser tab…): cover, track, buttons and that app’s volume', type: 'toggle' },
      { key: 'mediaSize', label: 'Size', type: 'select',
        options: [['compact', 'Compact: cover, title and play; the rest on hover'], ['full', 'Full: everything always shown']] },
    ]],
    ['Usage', [
      { key: 'tokenUsage', label: 'Token usage in the top bar', hint: 'Claude Code tokens used today, from its transcripts · click it (or Alt+U) for a graph over time', type: 'toggle' },
      { key: 'usageSeries', label: 'Count these tokens', hint: 'In the bar and the graph · cache reads are usually most of the total', type: 'series' },
      { key: 'planLimits', label: 'Plan limits when hovering the pill', hint: 'Your Claude 5-hour session and weekly limits, as Claude Code’s /usage shows them · asked of Anthropic with your Claude Code login', type: 'toggle' },
      { key: 'planLimitAlerts', label: 'Session limit alerts', hint: 'A notification at 80% and 95% of your 5-hour session, and a ring on the pill showing how much is used', type: 'toggle' },
      { key: 'tokenBudget', label: 'Daily token budget', hint: 'Counted tokens a day, like 2M or 500k · the pill turns orange at 80% and red past it · 0 = off', type: 'tokens' },
      { key: 'contextBadge', label: 'Context size in the info bar', hint: 'How full each Claude Code and OpenCode tile’s context is · orange at 60%, red at 85% · big contexts cost more tokens per message · needs Token usage in the top bar for Claude Code', type: 'toggle' },
      { key: 'tileTokens', label: 'Tile info bar', hint: 'A thin bar under each agent tile’s title: model, context, tokens used since it opened, folder and branch', type: 'toggle' },
      { type: 'tokenBreakdown', label: 'Where tokens go' },
    ]],
    ['Startup', [
      { key: 'masterOnStartup', label: 'Ask where to work on startup', type: 'toggle' },
      { key: 'defaultCwd', label: 'Default folder', type: 'folder' },
      { key: 'shell', label: 'Shell', hint: 'PowerShell runs the agents · ' + NEW_TILES, type: 'text' },
      { key: 'explorerContextMenu', label: 'Explorer right-click entry', hint: '"Open in Operant" on folders (installed app)', type: 'toggle' },
      { key: 'explorerOpensIn', label: '"Open in Operant" opens', hint: 'Starting Operant again always opens another window', type: 'select',
        options: [['tile', 'A tile in the window I used last'], ['window', 'A new Operant window']] },
      { key: 'linkBrowser', label: 'Open links in', hint: 'Links from agents, viewers and release notes', type: 'select',
        options: cfg => [['default', "Windows' default browser"],
          ...cfg.__browsers.map(b => [b.id, b.name]), ['custom', 'Custom']] },
      { key: 'linkBrowserCommand', label: 'Custom browser', hint: 'When Open links in is Custom · path to the browser\'s exe', type: 'text' },
      { key: 'secondBrowser', label: 'Second browser', hint: 'Shift+click a link', type: 'select',
        options: cfg => [['auto', 'Zen if installed, else Windows\' default'], ['default', "Windows' default browser"],
          ...cfg.__browsers.map(b => [b.id, b.name]), ['custom', 'Custom']] },
      { key: 'secondBrowserCommand', label: 'Custom second browser', hint: 'When Second browser is Custom · path to the browser\'s exe', type: 'text' },
    ]],
    ['Keybinds', [
      { key: 'vimKeys', label: 'Vim keys', hint: 'j/k and h/l scroll, gg/G top and end, Ctrl+D/U half a page, / finds, n/N next and previous in viewer and diff tiles ([ and ] change file); in the sidebar (Alt+Shift+B) j/k move, l opens, h closes, e edits, a and s open an agent or shell · Ctrl+J/K move in the pickers', type: 'toggle' },
      { type: 'keys', label: 'Keybinds shortcuts keys' },
    ]],
    ['Memory', [
      { type: 'memory', label: 'Memory facts remember recall project global' },
    ]],
    ['CodeGraph', [
      { type: 'codegraph', label: 'CodeGraph install index init version' },
      { key: 'codegraphOnStartup', label: 'Index projects when Operant starts', hint: 'Every pinned project, in one CodeGraph tile · “All projects” also sets up ones not indexed yet', type: 'select',
        options: [['changed', 'Projects with lots of changes'], ['all', 'All projects'], ['off', 'Off']] },
      { key: 'codegraphChangedFiles', label: 'Lots of changes means', hint: 'Files added, changed or removed since the project was last indexed', type: 'number', min: 1, max: 100000 },
      { key: 'codegraphButtons', label: 'CodeGraph buttons in the sidebar', hint: '◇ on each project, in the header for all of them and in the folder right-click menu', type: 'toggle' },
    ]],
    ['Skills backup', [
      { type: 'skillsBackup', label: 'Skills backup private git repos rules push commit' },
    ]],
    ['Updates', [
      { type: 'updates', label: 'Check for updates version release' },
      { key: 'autoUpdate', label: 'Update automatically', hint: 'Checks at startup and every 3 hours, downloads in the background, installs when you click the pill or quit · ' + RESTART, type: 'toggle' },
    ]],
  ];
  const TAB_ICONS = { Appearance: '◐', Terminal: '❯', Layout: '▦', Agents: '✻', Notifications: '◔', 'Tiles & subagents': '◆',
    Sidebar: '▌', 'Top bar': '▔', Files: '▤', Projects: '◈', Media: '♫', Usage: '▥', Startup: '⏻', Keybinds: '⌨', Memory: '✎', CodeGraph: '◇', 'Skills backup': '⤒', Updates: '↻' };

  function control(it, v, cfg) {
    switch (it.type) {
      case 'range': return `<input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}"><span class="val">${esc(it.fmt(v))}</span>`;
      case 'number': return `<input type="number" data-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step || 1}" value="${v}">`;
      case 'toggle': return `<button class="toggle${v ? ' on' : ''}" data-key="${it.key}"></button>`;
      case 'select': return `<select data-key="${it.key}">${(typeof it.options === 'function' ? it.options(cfg) : it.options).map(([o, n]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
      case 'tokens': return `<input type="text" data-key="${it.key}" value="${v ? esc(fmtTokens(v)) : '0'}" spellcheck="false">`;
      case 'list': return `<input type="text" data-key="${it.key}" value="${esc([].concat(v).join(' '))}">`;
      case 'series': return `<div class="series-picks">${USAGE_SERIES.map(([k, n]) => `<button class="chip-toggle${[].concat(v).includes(k) ? ' on' : ''}" data-series="${k}"><i class="sw s-${k}"></i>${n}</button>`).join('')}</div>`;
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
      + `</div><div class="set-row"><div class="lbl"><span class="hint">Any command that runs in a terminal works. Claude Code and OpenCode tiles also get their subagents as tiles. ${NEW_TILES}.</span></div>
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
      + '<div class="uc-links"><button class="link" data-update="releases">All releases on GitHub ↗</button>'
      + '<button class="link" data-update="log">Open log folder</button></div>';
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

  // Settings › Projects: per pinned project, the agent its tiles open with, extra arguments for it and a
  // command run first in every tile opened there.
  const pinned = cfg => [...new Set([...(cfg.projects || []), ...(cfg.projectGroups || []).flatMap(g => g.projects || [])].filter(Boolean))];
  function projectsEditor(cfg) {
    const list = pinned(cfg), d = cfg.projectDefaults || {};
    if (!list.length) return '<div class="set-none">Pin a project in the sidebar first (＋ at its top).</div>';
    return `<div class="proj-list"><div class="proj-row proj-head"><span>Project</span><span>Agent</span><span>Extra arguments</span><span>Startup command</span></div>`
      + list.map(p => { const v = d[p] || {}; return `<div class="proj-row" data-proj="${esc(p)}"><span class="proj-nm" title="${esc(p)}">${esc(p.split(/[\\/]/).filter(Boolean).pop() || p)}</span>`
        + `<select data-pf="agent"><option value="">Default (${esc(cfg.agents.find(a => a.id === cfg.defaultAgent)?.name || '')})</option>${cfg.agents.map(a => `<option value="${esc(a.id)}"${a.id === v.agent ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`
        + `<input data-pf="args" value="${esc(v.args || '')}" placeholder="--flags" spellcheck="false">`
        + `<input data-pf="startup" value="${esc(v.startup || '')}" placeholder="e.g. nvm use 22" spellcheck="false"></div>`; }).join('')
      + '</div><div class="set-row"><div class="lbl"><span class="hint">The agent is used by ＋ in the sidebar, Alt+Enter and new tiles in that folder. The startup command runs in PowerShell before the agent or shell starts. Applies to new tiles.</span></div></div>';
  }

  // Settings › Agents › Team (item 33): enable toggle, one row per tier (agent, model, "use for"), max workers.
  function teamEditor(cfg) {
    const team = cfg.team || {};
    const tiers = team.tiers || {};
    const tierBlock = (id, label) => {
      const t = tiers[id] || {};
      return `<div class="set-row"><div class="lbl">${label} tier</div><div class="ctl">
          <select data-team-f="${id}.agent">${cfg.agents.map(a => `<option value="${esc(a.id)}"${a.id === t.agent ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <input data-team-f="${id}.model" value="${esc(t.model || '')}" placeholder="model id" spellcheck="false">
          <select data-team-f="${id}.effort" title="Effort (Claude Code only)">${[['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']].map(([v, n]) => `<option value="${v}"${v === (t.effort || '') ? ' selected' : ''}>${n}</option>`).join('')}</select></div></div>
        <div class="set-row"><div class="lbl">${label} use for<span class="hint">Shown to the lead agent, and taught in the skill</span></div>
          <div class="ctl"><input data-team-f="${id}.use" value="${esc(t.use || '')}" placeholder="what this tier is for" spellcheck="false"></div></div>`;
    };
    // With OpenCode as the default agent, the tiers come from its models instead of the rows below.
    const def = cfg.agents.find(a => a.id === cfg.defaultAgent) || cfg.agents[0];
    const ocNote = def && /(^|[\\/])opencode(\.(exe|cmd|ps1))?$/i.test(String(def.command || '').trim().split(/\s+/)[0])
      ? `<div class="set-row"><div class="lbl">OpenCode tiers<span class="hint">OpenCode is your default agent, so its tiers come from the models it can reach: ${esc(Object.entries(cfg.teamTiers || {}).map(([n, t]) => `${n} ${t.model}${t.effort ? ' · ' + t.effort : ''}`).join(', ') || 'reading its models…')}. Free Zen models have no effort levels, so they give one tier; a paid Zen or OpenAI model adds one per effort level. The tiers below apply when another agent is the default.</span></div></div>`
      : '';
    return `<div class="set-row"><div class="lbl">Team mode<span class="hint">A lead agent hands small tasks to cheaper workers, in their own tiles</span></div>
        <div class="ctl"><button class="toggle${team.enabled ? ' on' : ''}" data-team-enabled></button></div></div>
      ${ocNote}
      ${tierBlock('xsmall', 'XSmall')}
      ${tierBlock('small', 'Small')}
      ${tierBlock('medium', 'Medium')}
      ${tierBlock('high', 'High')}
      ${tierBlock('max', 'Max')}
      <div class="set-row"><div class="lbl">Max workers at once</div><div class="ctl"><input type="number" data-team-max min="1" max="16" value="${team.maxWorkers ?? 4}"></div></div>
      <div class="set-row"><div class="lbl">Top tier allowed<span class="hint">Workers can't be started on a tier above this</span></div><div class="ctl"><select data-team-top>${Object.keys(tiers).map(n => `<option value="${esc(n)}"${n === (team.maxTier || Object.keys(tiers).pop()) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div></div>`;
  }

  // Settings › Skills backup: the repos skills and rules are pushed to, the two switches, Back up now and the last result.
  const BACKUP_LABEL = { pushed: 'pushed', nothing: 'nothing to back up', error: 'error' };
  function backupEditor(cfg, ext) {
    const b = { enabled: false, repos: [], auto: false, ...(cfg.skillsBackup || {}) };
    const { last, running } = ext.backupStatus();
    const name = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const repos = b.repos.length
      ? b.repos.map((r, i) => `<div class="set-row"><div class="lbl"><span title="${esc(r.path)}">${esc(name(r.path))}</span><span class="hint">${esc(r.path)}</span></div><div class="ctl"><button class="btn" data-backup-rm="${i}">Remove</button></div></div>`).join('')
      : '<div class="set-none">No repositories yet. Add a local clone of a private repo that has a remote.</div>';
    const line = running ? 'Backing up…'
      : !last ? 'Not run yet this session'
      : `${new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ` + last.results.map(r => (r.path ? name(r.path) + ': ' : '') + (r.status === 'error' ? r.message : BACKUP_LABEL[r.status])).join(' · ');
    const bad = !running && last && last.results.some(r => r.status === 'error');
    return `<div class="set-row"><div class="lbl">Back up skills and rules<span class="hint">Copies your skills (Operant's hub and ~/.claude/skills) and your rules into each repo's skills/ folder and rules.md, commits and pushes the current branch · .env, *.key, *.pem and credentials* files are left out · never forces a push</span></div>
        <div class="ctl"><button class="toggle${b.enabled ? ' on' : ''}" data-backup-enabled></button></div></div>
      <div class="set-row"><div class="lbl">Automatic<span class="hint">After Tidy agents applies fixes and every 6 hours while Operant is open</span></div>
        <div class="ctl"><button class="toggle${b.auto ? ' on' : ''}" data-backup-auto></button></div></div>
      ${repos}
      <div class="set-row"><div class="lbl">Add a repository<span class="hint" data-backup-err></span></div>
        <div class="ctl"><input type="text" data-backup-path placeholder="Folder of a local clone" spellcheck="false"><button class="btn" data-backup-browse>Browse…</button><button class="btn" data-backup-add>Add</button></div></div>
      <div class="set-row"><div class="lbl">Back up now<span class="hint uc-status${bad ? ' error' : ''}" data-backup-status>${esc(line)}</span></div>
        <div class="ctl"><button class="btn primary" data-backup-run${running || !b.repos.length ? ' disabled' : ''}>Back up now</button></div></div>`;
  }

  function rowHtml(it, cfg, ext) {
    if (it.type === 'skillsBackup') return backupEditor(cfg, ext);
    if (it.type === 'projects') return projectsEditor(cfg);
    if (it.type === 'theme') return themeCards(cfg.theme);
    if (it.type === 'agents') return agentsEditor(cfg.agents);
    if (it.type === 'team') return teamEditor(cfg);
    if (it.type === 'keys') return '<div class="set-keys"></div>';
    if (it.type === 'codegraph') return '<div class="cg-card"></div>';
    if (it.type === 'tokenBreakdown') return '<div class="tok-breakdown"></div>';
    if (it.type === 'memory') return '<div class="mem-card"></div>';
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
      const tbEl = pane.querySelector('.tok-breakdown');
      if (tbEl) ext.renderTokenBreakdown(tbEl);
      const memEl = pane.querySelector('.mem-card');
      if (memEl) ext.renderMemory(memEl);
      pane.querySelectorAll('[data-update]').forEach(b => b.onclick = () => {
        const a = b.dataset.update;
        if (a === 'check') { ext.checkUpdate(); b.disabled = true; b.textContent = 'Checking…'; }
        else if (a === 'install') ext.installUpdate();
        else if (a === 'log') ext.openLogFolder();
        else ext.openReleases();
      });
      pane.querySelectorAll('[data-link]').forEach(a => a.onclick = e => { e.preventDefault(); ext.openLink(a.dataset.link, e.shiftKey); });
      pane.querySelectorAll('[data-series]').forEach(b => b.onclick = () => {
        const on = new Set(cfg.usageSeries); const k = b.dataset.series;
        if (on.has(k)) { if (on.size > 1) on.delete(k); } else on.add(k);
        set('usageSeries', USAGE_SERIES.map(s => s[0]).filter(s => on.has(s))); draw();
      });
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
      pane.querySelectorAll('[data-pf]').forEach(el => el.onchange = () => {
        const p = el.closest('[data-proj]').dataset.proj, all = { ...(cfg.projectDefaults || {}) };
        const v = { ...(all[p] || {}), [el.dataset.pf]: el.value.trim() };
        for (const k of Object.keys(v)) if (!v[k]) delete v[k];
        if (Object.keys(v).length) all[p] = v; else delete all[p];
        set('projectDefaults', all);
      });
      const setBackup = patch => set('skillsBackup', { enabled: false, repos: [], auto: false, ...(cfg.skillsBackup || {}), ...patch });
      pane.querySelectorAll('[data-backup-enabled]').forEach(b => b.onclick = () => { setBackup({ enabled: !cfg.skillsBackup?.enabled }); draw(); });
      pane.querySelectorAll('[data-backup-auto]').forEach(b => b.onclick = () => { setBackup({ auto: !cfg.skillsBackup?.auto }); draw(); });
      pane.querySelectorAll('[data-backup-rm]').forEach(b => b.onclick = () => { setBackup({ repos: cfg.skillsBackup.repos.filter((_, j) => j !== +b.dataset.backupRm) }); draw(); });
      pane.querySelectorAll('[data-backup-browse]').forEach(b => b.onclick = async () => {
        const d = await pickFolder();
        if (d) { pane.querySelector('[data-backup-path]').value = d; pane.querySelector('[data-backup-add]').click(); }
      });
      pane.querySelectorAll('[data-backup-add]').forEach(b => b.onclick = async () => {
        const input = pane.querySelector('[data-backup-path]'), err = pane.querySelector('[data-backup-err]');
        const p = input.value.trim();
        if (!p) return;
        const msg = await ext.checkBackupRepo(p);
        if (msg) { err.textContent = msg; err.classList.add('uc-status', 'error'); return; }
        const repos = cfg.skillsBackup?.repos || [];
        if (!repos.some(r => r.path.toLowerCase() === p.toLowerCase())) setBackup({ repos: [...repos, { path: p }] });
        draw();
      });
      pane.querySelectorAll('[data-backup-run]').forEach(b => b.onclick = () => { b.disabled = true; ext.backupRun(); });
      pane.querySelectorAll('[data-agent-rm]').forEach(b => b.onclick = () => { setAgents(cfg.agents.filter((_, j) => j !== +b.dataset.agentRm)); draw(); });
      pane.querySelectorAll('[data-team-enabled]').forEach(b => b.onclick = () => { set('team', { ...(cfg.team || {}), enabled: !cfg.team?.enabled }); draw(); });
      pane.querySelectorAll('[data-team-max]').forEach(el => el.onchange = () => {
        const n = Math.min(16, Math.max(1, Math.round(+el.value || 4)));
        el.value = n; set('team', { ...(cfg.team || {}), maxWorkers: n });
      });
      pane.querySelectorAll('[data-team-top]').forEach(el => el.onchange = () => set('team', { ...(cfg.team || {}), maxTier: el.value }));
      pane.querySelectorAll('[data-team-f]').forEach(el => el.onchange = () => {
        const [tierId, field] = el.dataset.teamF.split('.');
        const tiers = { ...(cfg.team?.tiers || {}) };
        tiers[tierId] = { ...(tiers[tierId] || {}), [field]: el.value.trim() };
        set('team', { ...(cfg.team || {}), tiers });
      });
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
          } else if (it.type === 'tokens') {
            const n = parseTokens(el.value);
            if (n != null) set(it.key, n);
            el.value = cfg[it.key] ? fmtTokens(cfg[it.key]) : '0';
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
      fullscreen: 'Fullscreen tile', promoteMaster: 'Make focused tile the master', closeDoneAgents: 'Close finished subagents', stopAgent: 'Stop the focused agent', toggleSidebar: 'Show / hide the sidebar', focusSidebar: 'Keyboard to the sidebar',
      quickOpen: 'Quick open a file', showChanges: 'Show changes (git diff)', findInView: 'Find in a viewer or diff tile' }],
    ['Focus & swap', { focusLeft: 'Focus ←', focusRight: 'Focus →', focusUp: 'Focus ↑', focusDown: 'Focus ↓',
      swapLeft: 'Swap ←', swapRight: 'Swap →', swapUp: 'Swap ↑', swapDown: 'Swap ↓' }],
    ['Layout', { toggleLayout: 'Master ⇄ dwindle layout', toggleSplit: 'Flip split direction',
      resizeLeft: 'Resize ←', resizeRight: 'Resize →', resizeUp: 'Resize ↑', resizeDown: 'Resize ↓' }],
    ['Media', { mediaPlayPause: 'Play / pause', mediaNext: 'Next track', mediaPrev: 'Previous track', mediaShuffle: 'Shuffle' }],
    ['Workspaces', { prevWorkspace: 'Previous workspace', nextWorkspace: 'Next workspace' }],
    ['App', { commandPalette: 'Command palette', help: 'Keybinds (this popup)', settings: 'Settings', notifications: 'Notifications', tokenUsage: 'Token usage graph', newWindow: 'New Operant window', openConfig: 'Edit config.json', devtools: 'DevTools', saveQuit: 'Save and quit' }],
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

  // For the command palette: every setting with a label, and ways to open Settings on one.
  const settingsIndex = () => SECTIONS.flatMap(([t, items]) => items.filter(it => it.key && it.label).map(it => ({ tab: t, key: it.key, label: it.label, type: it.type })));
  const showSetting = label => { query = label; };
  const showTab = t => { tab = t; query = ''; };

  return { renderSettings, renderKeys, actionName, pretty, settingsTab, settingsIndex, showSetting, showTab, GROUPS };
})();
