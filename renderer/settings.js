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
  // Settings read only at startup: a change waits for a restart, and Settings offers "Restart now".
  const RESTART_KEYS = ['hardwareAcceleration', 'autoUpdate', 'agentLookbackSeconds'];
  const launchVals = {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Called once the config is loaded, before anything can change it: what the running app started with.
  const noteLaunch = cfg => { for (const k of RESTART_KEYS) launchVals[k] = cfg[k]; };
  const restartPending = cfg => RESTART_KEYS.filter(k => k in launchVals && !same(cfg[k], launchVals[k]));
  let confirmingReset = false;
  // Token counts as typed and shown in Settings: 2M, 1.5m, 500k, 1200000.
  const fmtTokens = n => n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n);
  const parseTokens = t => {
    const m = String(t).trim().replace(/[,_\s]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/i);
    return m ? Math.round(+m[1] * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1)) : null;
  };
  const NEW_TILES = 'Applies to new tiles';
  // The browser choices name what "default" means and what a custom one is: an exe on Windows, an app on macOS.
  const DEFAULT_BROWSER = IS_WIN ? "Windows' default browser" : 'Default browser';
  const BROWSER_PATH = IS_WIN ? 'path to the browser\'s exe' : IS_MAC ? 'the browser app, e.g. /Applications/Firefox.app' : 'path to the browser, e.g. /usr/bin/firefox';

  const GROUPS_ALL = [
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
      { key: 'defaultAgent', label: 'Default agent', hint: IS_WIN ? 'Alt+Enter, the master tile and Explorer\'s entry open this one.' : 'Alt+Enter and the master tile open this one.', when: 'New tiles', type: 'select',
        options: cfg => cfg.agents.map(a => [a.id, a.name]) },
      { key: 'opencodeTheme', label: 'OpenCode uses Operant’s theme', hint: 'OpenCode tiles get your theme and accent; your own OpenCode settings stay as they are.', when: 'New OpenCode tiles', type: 'toggle' },
      { key: 'installSkill', label: 'Operant skill for agents',
        hint: 'Gives Claude Code and OpenCode tiles the Operant skill each session; nothing is written to their own folders.', when: 'New tiles', type: 'toggle' },
      { key: 'briefAgents', label: 'Brief agents at launch', hint: 'A short first message in every agent tile so the rules apply from the start.', when: 'New tiles', type: 'toggle' },
      { key: 'longCommandHook', label: 'Reroute long commands', hint: 'Tests, builds and installs run through Operant so only the failures reach the agent; end a command with # raw to skip it.', when: 'New tiles', type: 'toggle' },
      { key: 'backgroundAfterSeconds', label: 'Run in the Backrooms after', hint: 'A rerouted command still running after this many seconds moves to the Backrooms page and the agent waits for its errors only. 0 = always at once.', when: 'The next rerouted command', type: 'number', min: 0, max: 600 },
      { key: 'autoCompact', label: 'Auto compact at', hint: 'When a tile\'s context passes this percent: waits for it to go idle, asks it to save a progress note, then compacts it (Claude Code: /compact · OpenCode: its own summarize, falling back to /compact) · 0 = off',
        type: 'number', min: 0, max: 100 },
      { key: 'cacheTtlMinutes', label: 'Prompt cache lifetime', hint: 'Minutes an idle tile\'s cache stays warm before its next message pays full price · 60 if your setup uses the 1-hour cache', type: 'number', min: 1, max: 120 },
      { key: 'compactBeforeCold', label: 'Compact before the cache goes cold', hint: 'Compact big idle agents just before their prompt cache expires, instead of paying to rebuild it', type: 'toggle' },
      ...AgentSettings.META.map(m => ({ key: 'team.' + m.id, type: 'tset', sid: m.id, label: m.label, hint: m.does, group: m.group, adv: !!m.adv })),
      { key: 'shareSetup', label: 'Share your main agent\'s setup',
        hint: 'Rules, MCP servers and skills from your default agent reach every agent you launch, for that process only.', when: 'New tiles', type: 'toggle' },
    ]],
    ['Notifications', [
      { key: 'notifications', label: IS_WIN ? 'Windows notifications' : 'Notifications', type: 'toggle' },
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
      { key: 'stuckTurns', label: 'Tool calls without a file edit', hint: 'How many tool calls a team worker on a code task may make without editing a file before the task pauses and asks you (so does the same command failing again). 0 = off.', when: 'Workers started after the change', type: 'number', min: 0, max: 200 },
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
      { key: 'ideCommand', label: 'Custom IDE command', hint: 'When IDE is Custom command · the folder is added at the end, e.g. ' + (IS_WIN ? '"C:\\Tools\\IDE\\bin\\ide64.exe"' : '"/opt/ide/bin/ide"'), type: 'text' },
    ]],
    ['Projects', [
      { type: 'projects', label: 'Project defaults agent arguments startup command per project' },
    ]],
    ['Files', [
      { key: 'fileOpens', label: 'Double-clicking a file in the sidebar', hint: 'Right-click a file for the others', type: 'select',
        options: [['view', 'Views it in Operant'], ['edit', 'Edits it in a terminal'], ['system', IS_WIN ? 'Opens it with Windows' : 'Opens it with the default app']] },
      { key: 'editor', label: 'Editor', hint: 'The terminal editor for “Edit” · Auto takes the first found: Neovim, Vim, micro, Edit, nano', type: 'select',
        options: [['auto', 'Auto'], ['vim', 'Vim'], ['nvim', 'Neovim'], ['micro', 'micro'], ['nano', 'nano'], ['edit', 'Edit (Windows)'], ['custom', 'Custom command']] },
      { key: 'configOpensIn', label: 'Edit config.json in', hint: 'The settings file, from Settings’ Open config.json button', type: 'select',
        options: [['system', IS_WIN ? 'Windows’ app for .json' : 'The default app for .json'], ['editor', 'The editor tile (vim…)']] },
      { key: 'editorCommand', label: 'Custom editor command', hint: 'When Editor is Custom command · the file is added at the end, e.g. ' + (IS_WIN ? '"C:\\Tools\\hx.exe"' : '"/usr/local/bin/hx"'), type: 'text' },
    ]],
    ['Top bar', [
      { key: 'clockFormat', label: 'Clock', hint: 'Hover it for a calendar · click it to copy the time and date', type: 'select',
        options: [['auto', IS_WIN ? 'Like Windows' : 'Like the system'], ['24', '24-hour'], ['12', '12-hour']] },
      { key: 'clockSeconds', label: 'Show seconds', type: 'toggle' },
      { key: 'clockDate', label: 'Show the date', type: 'toggle' },
      { key: 'barTitle', label: 'Focused tile’s title beside the clock', type: 'toggle' },
      { key: 'gitButton', label: 'Git tile', hint: 'In the gear’s quick menu: the focused project’s branch and changes · click to see and commit them', type: 'toggle' },
    ]],
    ['Media', [
      { key: 'mediaControls', win: true, label: 'Media controls in the top bar', hint: 'What Windows is playing (Spotify, a browser tab…): cover, track, buttons and that app’s volume', type: 'toggle' },
      { key: 'mediaSize', win: true, label: 'Size', type: 'select',
        options: [['compact', 'Compact: cover, title and play; the rest on hover'], ['full', 'Full: everything always shown']] },
    ]],
    ['Usage', [
      { key: 'tokenUsage', label: 'Token usage in the top bar', hint: 'Claude Code tokens used today, from its transcripts · click it (or Alt+U) for a graph over time', type: 'toggle' },
      { key: 'usageSeries', label: 'Count these tokens', hint: 'In the bar and the graph · cache reads are usually most of the total', type: 'series' },
      { key: 'planLimits', label: 'Plan limits when hovering the pill', hint: 'Your Claude 5-hour session and weekly limits, as Claude Code’s /usage shows them · asked of Anthropic with your Claude Code login', type: 'toggle' },
      { key: 'planLimitAlerts', label: 'Session limit alerts', hint: 'A notification at 80% and 95% of your 5-hour session, and a ring on the pill showing how much is used', type: 'toggle' },
      { key: 'tokenBudget', label: 'Daily token budget', hint: 'Counted tokens a day, like 2M or 500k · the pill turns orange at 80% and red past it · 0 = off', type: 'tokens' },
      { key: 'contextBadge', label: 'Context size in the info bar', hint: 'How full each Claude Code and OpenCode tile’s context is · orange at 60%, red at 85% · big contexts cost more tokens per message · needs Token usage in the top bar for Claude Code', type: 'toggle' },
      { key: 'tileTokens', label: 'Tile info bar', hint: 'A thin bar under every tile’s title: folder and git branch, plus model, context and tokens used since it opened on agents, size and zoom on images, and how many files changed on the changes tile', type: 'toggle' },
      { type: 'tokenBreakdown', label: 'Where tokens go' },
    ]],
    ['Startup', [
      { key: 'masterOnStartup', label: 'Ask where to work on startup', type: 'toggle' },
      { key: 'defaultCwd', label: 'Default folder', type: 'folder' },
      { key: 'shell', label: 'Shell', hint: (IS_WIN ? 'PowerShell' : 'Your shell (zsh, bash…)') + ' runs the agents · ' + NEW_TILES, type: 'text' },
      { key: 'explorerContextMenu', win: true, label: 'Explorer right-click entry', hint: '"Open in Operant" on folders (installed app)', type: 'toggle' },
      { key: 'explorerOpensIn', label: '"Open in Operant" opens', hint: 'Starting Operant again always opens another window', type: 'select',
        options: [['tile', 'A tile in the window I used last'], ['window', 'A new Operant window']] },
      { key: 'linkBrowser', label: 'Open links in', hint: 'Links from agents, viewers and release notes', type: 'select',
        options: cfg => [['default', DEFAULT_BROWSER],
          ...cfg.__browsers.map(b => [b.id, b.name]), ['custom', 'Custom']] },
      { key: 'linkBrowserCommand', label: 'Custom browser', hint: 'When Open links in is Custom · ' + BROWSER_PATH, type: 'text' },
      { key: 'secondBrowser', label: 'Second browser', hint: 'Shift+click a link', type: 'select',
        options: cfg => [['auto', IS_WIN ? 'Zen if installed, else Windows\' default' : 'Zen if installed, else the default browser'], ['default', DEFAULT_BROWSER],
          ...cfg.__browsers.map(b => [b.id, b.name]), ['custom', 'Custom']] },
      { key: 'secondBrowserCommand', label: 'Custom second browser', hint: 'When Second browser is Custom · ' + BROWSER_PATH, type: 'text' },
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
    ['Backups', [
      { type: 'stateBackups', label: 'Backups restore config session memory copy folder' },
    ]],
    ['Updates', [
      { type: 'updates', label: 'Check for updates version release' },
      { key: 'autoUpdate', label: 'Update automatically', hint: 'Checks at startup and on the schedule below, downloads in the background, installs when you click the pill or quit · ' + RESTART, type: 'toggle' },
      { key: 'updateChannel', label: 'Update channel', hint: 'Stable is releases only · Beta also offers prereleases · takes effect at the next check', type: 'select',
        options: [['stable', 'Stable'], ['beta', 'Beta']] },
      { key: 'updateCheckHours', label: 'Check for updates every', hint: 'Hours, 1-24 · 0 = only at startup and when you click Check for updates', type: 'number', min: 0, max: 24 },
    ]],
  // Rows flagged `win` exist only on Windows; a group left with none goes too.
  ].map(([t, items]) => [t, items.filter(it => IS_WIN || !it.win)]).filter(([, items]) => items.length);

  // Item 88: the groups above as 8 tabs. Every row keeps its group as a heading (`sub`); the rarely changed ones (`adv`)
  // sit under a collapsed Advanced at the foot of the tab. Search still finds every row.
  const TABS = [
    ['General', ['Startup', 'Notifications', 'Updates']],
    ['Look', ['Appearance', 'Terminal', 'Top bar', 'Media']],
    ['Agents', AgentSettings.GROUPS],
    ['Tiles', ['Layout', 'Tiles & subagents']],
    ['Projects', ['Projects', 'Sidebar', 'Files', 'CodeGraph']],
    ['Usage', ['Usage', 'Context and cache']],
    ['Data', ['Memory', 'Backups', 'Skills backup']],
    ['Keybinds', ['Keybinds']],
  ];
  // Rows that move to another group than the one they were written in.
  const MOVED = { autoCompact: 'Context and cache', cacheTtlMinutes: 'Context and cache', compactBeforeCold: 'Context and cache',
    agents: 'Who does the work', defaultAgent: 'Who does the work', stuckTurns: 'When they get stuck',
    opencodeTheme: 'What they use', installSkill: 'What they use', briefAgents: 'What they use', longCommandHook: 'What they use',
    backgroundAfterSeconds: 'What they use', shareSetup: 'What they use' };
  const ADVANCED = new Set(['borderAnimationSeconds', 'animations', 'blur', 'rounding', 'borderSize', 'gapsIn', 'gapsOut',
    'lineHeight', 'cursorStyle', 'cursorBlink', 'scrollback', 'gpuTerminals', 'hardwareAcceleration', 'clockSeconds', 'clockDate', 'barTitle', 'mediaSize',
    'shell', 'explorerOpensIn', 'linkBrowserCommand', 'secondBrowser', 'secondBrowserCommand', 'notifySubagents', 'notifyOnlyUnfocused',
    'updateChannel', 'updateCheckHours', 'opencodeTheme', 'installSkill', 'briefAgents', 'longCommandHook', 'shareSetup',
    'masterRatio', 'maxTilesPerWorkspace', 'moveFollowsTile', 'updateWhenIdle', 'saveQuitWaits', 'showExternalAgents', 'autoCloseDoneAgentsSeconds',
    'idleCloseTerminalMinutes', 'agentLookbackSeconds', 'stuckTurns', 'runawayLoopRepeats', 'runawayTokens', 'runawayMinutes', 'runawaySubagents',
    'sidebarWidth', 'sidebarHiddenFiles', 'ideCommand', 'configOpensIn', 'editorCommand', 'codegraphChangedFiles', 'codegraphButtons',
    'usageSeries', 'planLimitAlerts', 'contextBadge', 'tileTokens', 'cacheTtlMinutes', 'compactBeforeCold']);
  const rowsOf = g => GROUPS_ALL.flatMap(([name, items]) => items.map(it => ({ ...it, sub: MOVED[it.key] || it.group || name })))
    .filter(it => it.sub === g).map(it => ({ ...it, adv: !!it.adv || ADVANCED.has(it.key) }));
  const SECTIONS = TABS.map(([t, groups]) => [t, groups.flatMap(rowsOf)]).filter(([, items]) => items.length);
  // An old tab name (links, health actions, hints) -> [tab, group to scroll to].
  const tabFor = name => {
    if (SECTIONS.some(s => s[0] === name)) return [name, null];
    const hit = TABS.find(([, groups]) => groups.includes(name));
    return hit ? [hit[0], name] : [SECTIONS[0][0], null];
  };
  let advOpen = false, scrollTo = null;
  const TAB_ICONS = { General: '⏻', Look: '◐', Agents: '✻', Tiles: '▦', Projects: '◈', Usage: '▥', Data: '⛁', Keybinds: '⌨' };

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
  let updateHistory = [], updateHistoryAt = 0;
  const UH_RESULT = { installing: 'installing', healthy: 'started fine', 'failed-to-start': "didn't start" };
  function updateHistoryList() {
    const rows = updateHistory.slice().reverse().map(e => `<div class="set-row"><div class="lbl"><span>${esc(e.from)} → ${esc(e.to)}${e.digestChecked ? ' <span title="Installer checked against its published SHA-256">✓</span>' : ''}</span><span class="hint">${esc(e.at ? new Date(e.at).toLocaleString() : '')} · ${esc(UH_RESULT[e.result] || e.result || '')}</span></div></div>`).join('');
    return `<div data-uh><div class="pane-title">Update history</div>${rows || '<div class="set-row"><div class="lbl">No updates installed yet</div></div>'}</div>`;
  }

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
    const when = t => (t ? new Date(t).toLocaleString() : 'not yet this session');
    const row = (l, v) => `<div class="set-row"><div class="lbl"><span>${l}</span></div><span>${esc(v)}</span></div>`;
    return `<div class="update-card"><span class="uc-logo">◈</span><div class="uc-main"><div class="uc-name">Operant ${esc(u.version)}</div>`
      + `<div class="uc-status ${esc(s.state || '')}">${esc(line)}</div></div>${btn}</div>`
      + row('Current version', u.version) + row('Latest available', s.latest || 'unknown until a check finishes') + row('Last checked', when(s.checkedAt))
      + (s.notes && (s.state === 'ready' || s.state === 'downloading')
        ? `<details class="uc-notes" open><summary>What's new in ${esc(s.version)}</summary><div class="md">${md(s.notes)}</div></details>`
        : s.notes && s.state === 'current' ? `<details class="uc-notes"><summary>What's new in this version</summary><div class="md">${md(s.notes)}</div></details>` : '')
      + '<div class="uc-links"><button class="link" data-update="releases">All releases on GitHub ↗</button>'
      + '<button class="link" data-update="log">Open log folder</button></div>'
      + updateHistoryList();
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
  let tab = 'General', query = '';
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
      + '</div><div class="set-row"><div class="lbl"><span class="hint">The agent is used by ＋ in the sidebar, Alt+Enter and new tiles in that folder. The startup command runs in ' + (IS_WIN ? 'PowerShell' : 'your shell') + ' before the agent or shell starts. Applies to new tiles.</span></div></div>';
  }

  // Settings › Agents › Team (item 33): enable toggle, one row per tier (agent, model, "use for"), max workers.
  // Settings > Agents > Team > Local model (item 95): a guided card, one row per part of the setup with its own state
  // (local-setup.js words them), the go-ahead question before anything downloads, Cancel/Resume/Retry while it runs,
  // and Test it / Remove once it is in place. State comes from main.js through ext.localModelState().
  const LOCAL_MODELS = ['gemma4:e4b', 'gemma4:e2b', 'gemma4:12b'];
  const LOCAL_MARK = { idle: '○', checking: '◌', downloading: '↓', installing: '⚙', starting: '▸', ready: '✓', failed: '✕' };
  const LOCAL_WORD = { idle: 'Not started', checking: 'Checking', downloading: 'Downloading', installing: 'Installing', starting: 'Starting', ready: 'Ready', failed: 'Failed' };
  const LOCAL_PARTS = [['ollama', 'Ollama'], ['running', 'Ollama running'], ['model', 'Model'], ['ready', 'Ready to use'], ['connected', 'Connected to OpenCode']];
  const lmBytes = n => n == null ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`;
  function localPlanBlock(s) {
    const p = s.plan;
    const dl = p.downloads.length ? p.downloads.map(d => `${esc(d.what)} (about ${lmBytes(d.bytes)})`).join(' + ') + `, ${lmBytes(p.totalBytes)} in all` : 'Nothing to download';
    const disk = p.disk.free == null ? 'Free disk space could not be read' : `${lmBytes(p.disk.free)} free on the disk, ${lmBytes(p.disk.need)} needed${p.disk.ok ? '' : ': not enough'}`;
    const mem = p.memory.ok == null ? '' : `<div>Memory: ${lmBytes(p.memory.total)}, ${esc(s.model)} wants about ${p.memory.needGB} GB${p.memory.ok ? ': fine' : ': too little'}</div>`;
    const other = p.other ? `<div class="lm-warn">This computer can't run ${esc(s.model)} well. ${esc(p.other.model)} (about ${lmBytes(p.other.bytes)}) fits.</div>` : '';
    const notes = p.notes.map(n => `<div class="lm-warn">${esc(n)}</div>`).join('');
    return `<div class="lm-plan"><b>This will download:</b> ${dl}<div>${disk}</div>${mem}${other}${notes}</div>`;
  }
  function localModelBlock(cfg, ext) {
    const s = ext.localModelState();
    const model = (cfg.localModel && cfg.localModel.model) || LOCAL_MODELS[0];
    const models = LOCAL_MODELS.includes(model) ? LOCAL_MODELS : [model, ...LOCAL_MODELS];
    const parts = s.parts || {};
    const running = s.status === 'installing';
    const ft = cfg.teamTiers && (cfg.teamTiers.free || cfg.teamTiers.xsmall);
    const active = ft && ft.fallback ? ft.active : '';
    const rows = LOCAL_PARTS.map(([id, label]) => {
      const p = parts[id] || { state: 'idle', detail: 'Not started' };
      const bar = id === 'model' && p.state === 'downloading' ? `<progress max="100" value="${p.pct || 0}" data-lm-bar></progress>` : '';
      return `<div class="lm-part ${esc(p.state)}" data-lm-part="${id}"><span class="lm-mark">${LOCAL_MARK[p.state] || '○'}</span>`
        + `<span class="lm-name">${esc(label)}</span><span class="lm-state">${esc(LOCAL_WORD[p.state] || p.state)}</span><span class="lm-detail">${esc(p.detail || '')}</span>${bar}</div>`;
    }).join('');
    const f = s.failed;
    const fail = f ? `<div class="lm-fail"><b>${esc(f.label)} failed.</b> ${esc(f.what)}<div>${esc(f.leftover)}</div>${f.link ? `<a href="#" data-local-link="${esc(f.link)}">${esc(f.link)}</a>` : ''}</div>`
      : s.status === 'error' ? `<div class="lm-fail">${esc(s.message)}</div>` : '';
    const askBlock = s.status === 'confirm' && s.plan ? localPlanBlock(s) : '';
    const info = s.status === 'ready' && s.info ? `<div class="lm-info">${esc(s.info.model)} · ${lmBytes(s.info.bytes)} on disk · Ollama's models use ${lmBytes(s.info.diskUsed)} in all</div>` : '';
    const btn = (attr, label, cls = '', dis = false) => `<button class="btn${cls ? ' ' + cls : ''}" ${attr}${dis ? ' disabled' : ''}>${esc(label)}</button>`;
    let ctl;
    if (running) ctl = btn('data-local-cancel', 'Cancel');
    else if (s.status === 'confirm') ctl = btn('data-local-go', 'Download and install', 'primary', !!(s.plan && s.plan.blocked)) + (s.plan && s.plan.other ? btn(`data-local-switch="${esc(s.plan.other.model)}"`, `Use ${s.plan.other.model} instead`) : '') + btn('data-local-dismiss', 'Not now');
    else if (s.status === 'paused') ctl = btn('data-local-go', 'Resume', 'primary') + btn('data-local-dismiss', 'Close');
    else if (s.status === 'error') ctl = btn('data-local-go', f ? f.retry : 'Retry', 'primary') + btn('data-local-dismiss', 'Close');
    else if (s.status === 'ready') ctl = btn('data-local-test', 'Test it') + btn('data-local-remove', 'Remove the model');
    else ctl = btn('data-local-install', 'Set up the local model', 'primary');
    const lead = running ? `Working on ${esc(s.model)}: ${esc(s.message || '')}` : s.status === 'ready' ? `Ready: ${esc(s.model)}` : s.status === 'paused' ? 'Paused' : s.status === 'error' ? 'Setup stopped' : s.status === 'confirm' ? 'Waiting for your go-ahead' : esc(s.message || 'Not installed');
    return `<div class="set-row lm-card"><div class="lbl">Local model<span class="hint uc-status ${esc(s.status)}${s.status === 'error' ? ' error' : ''}" data-lm-lead>${lead}${active ? ' · the free tier is using ' + esc(active) : ''}</span>`
      + `<span class="hint">The free tier uses Big Pickle first. When it is rate limited, busy or out of free use, and this model is installed, it runs here instead (free, on your computer) and goes back to Big Pickle later. Setup asks before it downloads anything.</span>`
      + `${askBlock}<div class="lm-parts">${rows}</div>${fail}${info}</div>`
      + `<div class="ctl"><select data-local-model${running ? ' disabled' : ''}>${models.map(m => `<option value="${esc(m)}"${m === model ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>${ctl}</div></div>`;
  }
  // The card's own handlers; also used when only the card is redrawn (progress arrives several times a second).
  function bindLocalCard(pane, cfg, set, ext) {
    const model = () => (cfg.localModel && cfg.localModel.model) || LOCAL_MODELS[0];
    const on = (sel, fn) => pane.querySelectorAll(sel).forEach(b => b.onclick = e => { e.preventDefault(); fn(b); });
    pane.querySelectorAll('[data-local-model]').forEach(el => el.onchange = () => { set('localModel', { ...(cfg.localModel || {}), model: el.value }); ext.localModelDismiss(); });
    on('[data-local-install]', b => { b.disabled = true; ext.localModelInstall(model()); });
    on('[data-local-go]', b => { b.disabled = true; ext.localModelInstall(model(), { confirmed: true }); });
    on('[data-local-switch]', b => { set('localModel', { ...(cfg.localModel || {}), model: b.dataset.localSwitch }); ext.localModelInstall(b.dataset.localSwitch); });
    on('[data-local-cancel]', b => { b.disabled = true; ext.localModelCancel(); });
    on('[data-local-dismiss]', () => ext.localModelDismiss());
    on('[data-local-test]', b => { b.disabled = true; ext.localModelTest(); });
    on('[data-local-remove]', b => { b.disabled = true; ext.localModelRemove(model()); });
    on('[data-local-link]', a => ext.openLink(a.dataset.localLink));
  }
  // Redraws just the card (returns false when it is not on the page). Called on every state push.
  function refreshLocalCard(body, cfg, set, ext) {
    const holder = body && body.querySelector('[data-sid="localModel"]');
    if (!holder) return false;
    holder.innerHTML = localModelBlock(cfg, ext);
    bindLocalCard(holder, cfg, set, ext);
    return true;
  }
  // Items 91/92: the limits' suggestions from past tasks (ext.limitSuggestions(): null until read), and a refused change.
  let teamLimitMsg = '';
  const kTok = n => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  function suggestionText(s) {
    if (!s) return 'Suggestion: reading past tasks…';
    if (!s.enough) return `Suggestion: not enough history (${s.n} of 5 finished tasks), so the tier default`;
    return `Suggested ${kTok(s.tokens)} from ${s.n} passed tasks${s.direction ? ` (${s.direction}: ${s.reason})` : ` (${s.reason})`}`;
  }
  // Item 96: per tier, its routes in order and how this week's tasks went on each (ext.routeUse(): null until read).
  function routesBlock(cfg, ext) {
    const d = ext.routeUse ? ext.routeUse() : null;
    const usd = n => '$' + (n || 0).toFixed(2);
    const lines = Object.entries(cfg.teamTiers || {}).filter(([n, t]) => (t.routes && t.routes.length > 1) || (d && d.use && d.use[n])).map(([n, t]) => {
      const order = t.routes && t.routes.length > 1 ? t.routes.map(r => r.label).join(' → ') : (t.route ? t.route.label : t.model);
      const now = t.fallback ? ` · now ${t.active}: ${t.fallback}` : '';
      const week = ((d && d.use && d.use[n]) || []).map(r => {
        const why = Object.entries(r.why || {}).map(([k, c]) => `${k} ×${c}`).join(', ');
        const paid = d.paid && d.paid[n] ? TeamRouteLabel(d.paid[n]) : '';
        return `${r.route}: ${r.tasks} task${r.tasks === 1 ? '' : 's'}, ${kTok(r.tokens)} tokens${r.free && paid ? `, ${usd(r.savedUsd)} saved vs ${paid}` : r.usd ? `, ${usd(r.usd)}` : ''}${why ? ` (${why})` : ''}`;
      });
      return `<b>${esc(n)}</b>: ${esc(order)}${esc(now)}${week.length ? '<br>&nbsp;&nbsp;' + week.map(esc).join('<br>&nbsp;&nbsp;') : ''}`;
    });
    return `<div class="set-row"><div class="lbl">Routes this week<span class="hint">Each tier tries its routes in order: the next one only when the first was busy, out of free use, or this kind of task kept failing there. Tasks, tokens and cost saved are from this week's finished tasks</span>
      <span class="hint">${lines.length ? lines.join('<br>') : (d ? 'No tasks this week yet' : 'Reading this week…')}</span></div></div>`;
  }
  // Item 96: after a config migration, an xsmall tier on a paid model is offered Big Pickle first; nothing is switched until the click.
  function bigPickleOffer(cfg) {
    if (!(cfg.tierOffers || []).includes('use-big-pickle')) return '';
    const x = (cfg.team && cfg.team.tiers && cfg.team.tiers.xsmall) || {};
    return `<div class="set-row"><div class="lbl">Use Big Pickle first<span class="hint">Your xsmall tier runs ${esc(TeamRouteLabel(x.model || ''))}. Big Pickle is free: with this change xsmall runs it first and goes to ${esc(TeamRouteLabel(x.model || ''))} only when Big Pickle is busy, out of free use, or this kind of task kept failing there</span></div>
        <div class="ctl"><button class="btn primary" data-offer-use-bp>Use Big Pickle</button><button class="btn" data-offer-dismiss>Not now</button></div></div>`;
  }
  const TeamRouteLabel = id => (typeof TierRoutes !== 'undefined' ? TierRoutes.labelOf({ model: id }) : id);
  // Item 94: the team settings, one row each, worded by agent-settings.js. Every row: short label, what it does for
  // you, the value in effect and when it applies, its warnings, a Reset when it differs from the default, and its
  // developer term (config key) only under Advanced.
  let presetPreview = null;
  function tsetRow(it, cfg, ext) {
    const m = AgentSettings.byId[it.sid], team = cfg.team || {}, tiers = team.tiers || {};
    const ctx = { localStatus: ext.localModelState().status };
    const warn = (AgentSettings.warnings(cfg, ctx)[it.sid] || []).map(w => `<span class="hint warn">${esc(w)}</span>`).join('');
    const dt = ext.defaults && ext.defaults.team;
    const rst = m.path && dt && !same(AgentSettings.get(team, m.path), AgentSettings.get(dt, m.path))
      ? `<button class="btn rst" data-team-reset="${esc(m.path)}" title="Reset to the default">Reset</button>` : '';
    const eff = AgentSettings.effective(cfg, it.sid);
    const shell = (ctl, extra = '') => `<div class="set-row${warn ? ' has-warn' : ''}" data-sid="${it.sid}"><div class="lbl">${esc(m.label)}<span class="hint">${esc(m.does)}</span>`
      + `<span class="hint now">${eff ? `Now: ${esc(eff)} · ` : ''}Applies: ${esc(m.when)}</span>${extra}${warn}${it.adv ? `<span class="hint dev">${esc(m.dev)}</span>` : ''}</div><div class="ctl">${rst}${ctl}</div></div>`;
    const sugg = ext.limitSuggestions ? ext.limitSuggestions() : null;
    const tog = (attr, on) => `<button class="toggle${on ? ' on' : ''}" ${attr}></button>`;
    switch (it.sid) {
      case 'enabled': return shell(tog('data-team-enabled', team.enabled));
      case 'maxWorkers': return shell(`<input type="number" data-team-max min="1" max="16" value="${team.maxWorkers ?? 4}">`);
      case 'maxTier': return shell(`<select data-team-top>${Object.keys(tiers).map(n => `<option value="${esc(n)}"${n === (team.maxTier || Object.keys(tiers).pop()) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`);
      case 'savingProgress': return shell(`<select data-team-saving><option value="over"${team.savingProgress !== 'inside' ? ' selected' : ''}>On top of the limit</option><option value="inside"${team.savingProgress === 'inside' ? ' selected' : ''}>Inside the limit</option></select>`,
        `<span class="hint">On top: the work stops at the limit and saving gets its own allowance (10% of the limit, at most 15k). Inside: the allowance comes out of the limit, and limits under 20k are refused.</span>${teamLimitMsg ? `<span class="hint uc-status error">${esc(teamLimitMsg)}</span>` : ''}`);
      case 'dailyCap': return shell(`<input type="number" data-team-cap min="0" step="100000" value="${team.dailyCap ?? 0}">`);
      case 'suggest': return shell(`<button class="btn" data-team-apply${sugg && Object.values(sugg).some(s => s && s.enough) ? '' : ' disabled'}>Apply suggestions</button>`,
        '<span class="hint">From at least 5 passed tasks per tier: the 90th percentile of tokens used, plus 25%.</span>');
      case 'askBeforeMoveUp': return shell('<button class="toggle on" disabled title="Always on in this release"></button>');
      case 'verifyBeforeReview': return shell(tog('data-team-verify', team.verifyBeforeReview !== false));
      case 'messaging': return shell(tog('data-messaging', cfg.messaging));
      case 'refineTo': return shell(`<select data-refine-to><option value="claude"${cfg.refineTo !== 'team' ? ' selected' : ''}>A Claude tile</option><option value="team"${cfg.refineTo === 'team' ? ' selected' : ''}>Team work</option></select>`);
      case 'localModel': return `<div data-sid="localModel">${localModelBlock(cfg, ext)}</div>`;
      case 'routing': {
        const def = cfg.agents.find(a => a.id === cfg.defaultAgent) || cfg.agents[0];
        const ocNote = def && /(^|[\\/])opencode(\.(exe|cmd|ps1))?$/i.test(String(def.command || '').trim().split(/\s+/)[0])
          ? `<div class="set-row"><div class="lbl">OpenCode tiers<span class="hint">OpenCode is your default agent, so its tiers come from the models it can reach: ${esc(Object.entries(cfg.teamTiers || {}).map(([n, t]) => `${n} ${t.model}${t.effort ? ' · ' + t.effort : ''}`).join(', ') || 'reading its models…')}. Free Zen models have no effort levels, so they give one tier; a paid Zen or OpenAI model adds one per effort level. The tiers under Advanced apply when another agent is the default.</span></div></div>` : '';
        const fb = ocNote ? [] : Object.entries(cfg.teamTiers || {}).filter(([, t]) => t.fallback);
        const fbNote = fb.length ? `<div class="set-row"><div class="lbl">Fallbacks in use<span class="hint">${esc(fb.map(([n, t]) => `${n}: ${t.agent} ${t.model}${t.effort ? ' · ' + t.effort : ''} (${t.fallback})`).join('; '))}</span></div></div>` : '';
        return `<div data-sid="routing">${ocNote}${fbNote}${bigPickleOffer(cfg)}${routesBlock(cfg, ext)}</div>`;
      }
    }
    if (it.sid.startsWith('tier.')) {
      const id = it.sid.slice(5), t = tiers[id] || {};
      return shell(`<select data-team-f="${id}.agent">${cfg.agents.map(a => `<option value="${esc(a.id)}"${a.id === t.agent ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <input data-team-f="${id}.model" value="${esc(t.model || '')}" placeholder="model id" spellcheck="false">
          <select data-team-f="${id}.effort" title="Effort (Claude Code only)">${[['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']].map(([v, n]) => `<option value="${v}"${v === (t.effort || '') ? ' selected' : ''}>${n}</option>`).join('')}</select>`,
        `<span class="hint">Use for (shown to the lead and taught in the skill): <input data-team-f="${id}.use" value="${esc(t.use || '')}" placeholder="what this tier is for" spellcheck="false" style="width:100%"></span>`);
    }
    if (it.sid.startsWith('budget.')) {
      const id = it.sid.slice(7);
      return shell(`<input type="number" data-team-budget="${id}" min="0" step="10000" value="${team.budgets?.[id] ?? 0}">`, `<span class="hint">${esc(suggestionText(sugg && sugg[id]))}</span>`);
    }
    return '';
  }
  // The top of Settings › Agents: what is set now in plain sentences (each with a Change link), and the presets.
  function agentTop(cfg, ext) {
    const s = AgentSettings.summary(cfg, { labelOf: TeamRouteLabel, localStatus: ext.localModelState().status, localModel: cfg.localModel && cfg.localModel.model });
    const team = cfg.team || {};
    const pv = presetPreview && AgentSettings.PRESETS[presetPreview] ? presetPreview : null;
    const diff = pv ? AgentSettings.presetDiff(team, pv) : [];
    const cur = s.preset;
    const btns = AgentSettings.PRESET_ORDER.map(id => `<button class="btn preset${cur.id === id ? ' on' : ''}${pv === id ? ' previewing' : ''}" data-preset="${id}" title="${esc(AgentSettings.PRESETS[id].blurb)}">${esc(AgentSettings.PRESETS[id].name)}</button>`).join('')
      + (cur.custom ? '<span class="preset-custom">Custom</span>' : '');
    const preview = pv ? `<div class="preset-preview"><div><b>${esc(AgentSettings.PRESETS[pv].name)}</b>: ${esc(AgentSettings.PRESETS[pv].blurb)} It does not change which models the tiers use or whether team mode is on.</div>`
      + (diff.length ? `<ul>${diff.map(c => `<li>${esc(c.text)}</li>`).join('')}</ul><div class="ctl"><button class="btn primary" data-preset-apply="${pv}">Apply ${esc(AgentSettings.PRESETS[pv].name)}</button><button class="btn" data-preset-cancel>Cancel</button></div>`
        : '<div class="hint">Already set this way; nothing would change.</div><div class="ctl"><button class="btn" data-preset-cancel>Close</button></div>') + '</div>' : '';
    return `<div class="ag-summary"><div class="ag-title">What is set now</div><ul>${s.lines.map(l => `<li>${esc(l.text)} <a href="#" data-goto="${esc(l.target)}">Change</a></li>`).join('')}</ul>
        <div class="hint">${esc(s.presetText)}</div></div>
      <div class="ag-presets"><div class="ag-title">Presets <span class="hint">Pick one to see what it changes first; nothing changes until you apply it.</span></div><div class="preset-row">${btns}</div>${preview}</div>`;
  }

  // Settings › Data › Skills backup: the repos skills and rules are pushed to, the two switches, Back up now and the last result.
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

  // Settings › Data › Backups: Operant's own state (config, session, memory) copied into a backups folder on a schedule;
  // the switches and numbers, the folder, what the last backup and the last restore test found, and the list. Restore asks first.
  const BK_DEFAULTS = { enabled: true, everyHours: 24, keepLast: 10, keepDays: 7, location: '', beforeUpdate: true, beforeMigration: true };
  let stateBackups = null, stateBackupsAt = 0, stateBackupMsg = '', stateBackupErr = '', stateBackupInfo = null;
  const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const BK_STATUS = { valid: 'valid', cantRestore: 'can’t be restored', failed: 'failed', '': 'not tested yet' };
  function stateBackupsEditor(cfg) {
    const bk = { ...BK_DEFAULTS, ...(cfg.backups || {}) };
    const num = (k, label, hint, min, max) => `<div class="set-row"><div class="lbl">${label}<span class="hint">${hint}</span></div><div class="ctl"><input type="number" data-bk-num="${k}" min="${min}" max="${max}" value="${bk[k]}"></div></div>`;
    const sw = (k, label, hint) => `<div class="set-row"><div class="lbl">${label}<span class="hint">${hint}</span></div><div class="ctl"><button class="toggle${bk[k] ? ' on' : ''}" data-bk-toggle="${k}"></button></div></div>`;
    const info = stateBackupInfo, last = info && info.last, val = info && info.validated;
    const lastLine = !info ? 'Loading…' : last ? `${new Date(last.at).toLocaleString()} · ${fmtSize(last.bytes)} · ${last.files} files · ${info.location}` : `No backup yet · ${info.location}`;
    const valLine = !info ? '' : val ? `${new Date(val.at).toLocaleString()} · ${val.ok ? 'restored into a temporary folder and every file read back' : val.error}` : 'Not tested yet. A restore test runs weekly.';
    const rows = stateBackups === null ? '<div class="set-row"><div class="lbl">Loading…</div></div>'
      : stateBackups.length ? stateBackups.map(b => `<div class="set-row"><div class="lbl"><span>${esc(b.at ? new Date(b.at).toLocaleString() : b.id)} · ${esc(b.reason || 'unknown')}</span><span class="hint">${b.ok ? `Operant ${esc(b.version || '?')} · ${b.files} files · ${fmtSize(b.bytes)}` : 'Unreadable (no manifest)'} · <span class="uc-status${b.status === 'cantRestore' || b.status === 'failed' ? ' error' : ''}" title="${esc(b.validation && b.validation.error || '')}">${BK_STATUS[b.status] || ''}</span></span></div><div class="ctl"><button class="btn" data-sbk-restore="${esc(b.id)}"${b.ok && b.status !== 'cantRestore' ? '' : ' disabled'}>Restore</button></div></div>`).join('')
      : '<div class="set-row"><div class="lbl">No backups yet</div></div>';
    return `
      <div class="set-row"><div class="lbl">Last backup<span class="hint">${esc(lastLine)}</span></div></div>
      <div class="set-row"><div class="lbl">Last restore test<span class="hint uc-status${val && !val.ok ? ' error' : ''}">${esc(valLine)}</span></div></div>
      ${sw('enabled', 'Back up automatically', 'Config, session, usage and memory are copied on the schedule below')}
      ${num('everyHours', 'Back up every', 'Hours, 1-168 · checked hourly and at startup', 1, 168)}
      ${num('keepLast', 'Keep the newest', 'Backups, whatever their age', 1, 1000)}
      ${num('keepDays', 'And the newest of each of the last', 'Days · older ones are removed after each backup', 0, 3650)}
      <div class="set-row"><div class="lbl">Location<span class="hint${stateBackupErr ? ' uc-status error' : ''}">${esc(stateBackupErr || 'Empty is Operant’s data folder (backups). Backups already made stay where they are')}</span></div>
        <div class="ctl"><input type="text" data-bk-location value="${esc(bk.location)}" placeholder="Operant's data folder" spellcheck="false"><button class="btn" data-bk-browse>Browse…</button></div></div>
      ${sw('beforeUpdate', 'Back up before an update installs', 'So a version that fails to start can be rolled back with its settings')}
      ${sw('beforeMigration', 'Back up before a settings upgrade', 'A full backup, not just a copy of config.json, when a new version reshapes the saved settings')}
      <div class="set-row"><div class="lbl">Back up now<span class="hint uc-status" data-sbk-status>${esc(stateBackupMsg || 'Test restore restores the newest backup into a temporary folder and reads it back (your data is not touched)')}</span></div>
        <div class="ctl"><button class="btn primary" data-sbk-create>Back up now</button><button class="btn" data-sbk-test>Test restore</button><button class="btn" data-sbk-open>Open folder</button></div></div>${rows}`;
  }

  function rowHtml(it, cfg, ext) {
    if (it.type === 'stateBackups') return stateBackupsEditor(cfg);
    if (it.type === 'skillsBackup') return backupEditor(cfg, ext);
    if (it.type === 'projects') return projectsEditor(cfg);
    if (it.type === 'theme') return themeCards(cfg.theme);
    if (it.type === 'agents') return agentsEditor(cfg.agents);
    if (it.type === 'tset') return tsetRow(it, cfg, ext);
    if (it.type === 'keys') return '<div class="set-keys"></div>';
    if (it.type === 'codegraph') return '<div class="cg-card"></div>';
    if (it.type === 'tokenBreakdown') return '<div class="tok-breakdown"></div>';
    if (it.type === 'memory') return '<div class="mem-card"></div>';
    if (it.type === 'updates') return updatesCard(ext.update());
    const err = ext.errors && ext.errors[it.key];
    const rst = ext.defaults && it.key in ext.defaults && !same(cfg[it.key], ext.defaults[it.key])
      ? `<button class="btn rst" data-reset="${it.key}" title="Reset to the default">Reset</button>` : '';
    return `<div class="set-row"><div class="lbl">${it.label}${it.hint ? `<span class="hint">${it.hint}</span>` : ''}${it.when ? `<span class="hint now">Applies: ${esc(it.when)}</span>` : ''}${err ? `<span class="hint uc-status error" data-err="${it.key}">${esc(err)}</span>` : ''}</div><div class="ctl">${rst}${control(it, cfg[it.key], cfg)}</div></div>`;
  }

  const labelOf = key => SECTIONS.flatMap(s => s[1]).find(i => i.key === key && i.label)?.label || key;
  // Above every pane: settings that only apply after a restart, and saves that were refused for a key with no row of its own.
  function notices(cfg, ext) {
    const shownKeys = new Set(SECTIONS.flatMap(s => s[1]).filter(i => i.key && i.label && !['agents'].includes(i.key) && i.type !== 'tset').map(i => i.key));
    const stray = Object.entries(ext.errors || {}).filter(([k]) => !shownKeys.has(k));
    const pend = restartPending(cfg);
    return (stray.length ? `<div class="set-row"><div class="lbl"><span class="uc-status error">Not saved</span>${stray.map(([k, m]) => `<span class="hint uc-status error">${esc(labelOf(k))}: ${esc(m)}</span>`).join('')}</div></div>` : '')
      + (pend.length ? `<div class="set-row"><div class="lbl"><span>Restart needed</span><span class="hint">Saved, but applies after a restart: ${esc(pend.map(labelOf).join(', '))}</span></div><div class="ctl"><button class="btn primary" data-restart>Restart now</button></div></div>` : '');
  }
  const teamChanged = (items, cfg, ext) => items.some(it => it.type === 'tset') && ext.defaults && ext.defaults.team ? AgentSettings.changedFrom(cfg.team || {}, ext.defaults.team) : [];
  // Foot of a tab: put every setting in it back to its default, after a confirm.
  function sectionReset(items, cfg, ext) {
    const n = items.filter(it => it.key && ext.defaults && it.key in ext.defaults && !same(cfg[it.key], ext.defaults[it.key])).length + teamChanged(items, cfg, ext).length;
    if (!n) return '';
    const what = `${n} changed setting${n === 1 ? '' : 's'}`;
    return confirmingReset
      ? `<div class="set-row"><div class="lbl"><span>Reset ${what} in this section to the defaults?</span><span class="hint">Other sections are not touched</span></div><div class="ctl"><button class="btn primary" data-reset-section="yes">Reset</button><button class="btn" data-reset-section="no">Cancel</button></div></div>`
      : `<div class="set-row"><div class="lbl"><span class="hint">${what} in this section</span></div><div class="ctl"><button class="btn" data-reset-section="ask">Reset this section</button></div></div>`;
  }

  // Tabs down the left, one section at a time; typing in the search box shows matches from all of them.
  // set(key, value) applies and saves one setting. ext: { renderKeys(el), renderCodegraph(el), update(), checkUpdate(), installUpdate(), openReleases() }
  function renderSettings(body, cfg, set, pickFolder, ext) {
    currentTheme = cfg.theme;
    if (!SECTIONS.some(s => s[0] === tab)) [tab, scrollTo] = tabFor(tab);
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
        const groups = [...new Set(items.map(it => it.sub))];
        const block = rows => groups.map(g => { const its = rows.filter(it => it.sub === g); return its.length
          ? `<div class="set-section" data-grp="${esc(g)}">${groups.length > 1 ? `<h3>${esc(g)}</h3>` : ''}${its.map(it => rowHtml(it, cfg, ext)).join('')}</div>` : ''; }).join('');
        const adv = items.filter(it => it.adv);
        const changed = adv.filter(it => ext.defaults && it.key in ext.defaults && !same(cfg[it.key], ext.defaults[it.key])).length;
        html = `<div class="pane-title">${esc(tab)}</div>` + notices(cfg, ext) + (tab === 'Agents' ? agentTop(cfg, ext) : '') + block(items.filter(it => !it.adv))
          + (adv.length ? `<details class="set-adv"${advOpen ? ' open' : ''}><summary>Advanced <span class="hint">${adv.length} setting${adv.length === 1 ? '' : 's'}${changed ? ` · ${changed} changed` : ''}</span></summary>${block(adv)}</details>` : '')
          + sectionReset(items, cfg, ext);
      } else {
        const hits = SECTIONS.map(([t, items]) => [t, items.filter(it => it.type === 'tset' ? AgentSettings.matches(AgentSettings.byId[it.sid], q) : `${t} ${it.sub} ${it.label || it.key || ''} ${it.hint || ''} ${it.type === 'theme' ? 'theme colors' : ''} ${it.type === 'agents' ? 'agents commands' : ''}`.toLowerCase().includes(q))])
          .filter(([, items]) => items.length);
        html = notices(cfg, ext) + (hits.length ? hits.map(([t, items]) => `<div class="set-section"><h3>${esc(t)}</h3>${items.map(it => rowHtml(it, cfg, ext)).join('')}</div>`).join('')
          : `<div class="set-none">Nothing matches “${esc(query)}”.</div>`);
      }
      pane.innerHTML = html;
      pane.scrollTop = top;
      const advEl = pane.querySelector('.set-adv');
      if (advEl) advEl.addEventListener('toggle', () => { advOpen = advEl.open; });
      if (scrollTo && !q) { pane.querySelector(`[data-grp="${CSS.escape(scrollTo)}"]`)?.scrollIntoView({ block: 'start' }); scrollTo = null; }
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
      pane.querySelectorAll('[data-restart]').forEach(b => b.onclick = () => ext.restart());
      const clone = v => JSON.parse(JSON.stringify(v));
      pane.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => { set(b.dataset.reset, clone(ext.defaults[b.dataset.reset]), true); draw(); });
      pane.querySelectorAll('[data-reset-section]').forEach(b => b.onclick = () => {
        const a = b.dataset.resetSection;
        if (a === 'yes') {
          const its = SECTIONS.find(s => s[0] === tab)[1];
          for (const it of its) if (it.key && it.key in ext.defaults && !same(cfg[it.key], ext.defaults[it.key])) set(it.key, clone(ext.defaults[it.key]), true);
          const paths = teamChanged(its, cfg, ext);
          if (paths.length) set('team', paths.reduce((t, path) => AgentSettings.put(t, path, AgentSettings.get(ext.defaults.team, path)), cfg.team || {}));
        }
        confirmingReset = a === 'ask';
        draw();
      });
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
      // Re-read whenever the list is older than a couple of seconds, so opening Settings or the tab shows current backups.
      if (Date.now() - stateBackupsAt > 2000 && pane.querySelector('[data-sbk-create]')) { stateBackupsAt = Date.now(); Promise.all([ext.listStateBackups(), ext.stateBackupStatus()]).then(([l, i]) => { stateBackups = l; stateBackupInfo = i; draw(); }); }
      const refreshBackups = async () => { [stateBackups, stateBackupInfo] = await Promise.all([ext.listStateBackups(), ext.stateBackupStatus()]); draw(); };
      const setBk = patch => set('backups', { ...BK_DEFAULTS, ...(cfg.backups || {}), ...patch });
      pane.querySelectorAll('[data-bk-toggle]').forEach(b => b.onclick = () => { const k = b.dataset.bkToggle; setBk({ [k]: !{ ...BK_DEFAULTS, ...(cfg.backups || {}) }[k] }); draw(); });
      pane.querySelectorAll('[data-bk-num]').forEach(el => el.onchange = () => {
        const lo = +el.min, hi = +el.max, n = Math.min(hi, Math.max(lo, Math.round(+el.value || BK_DEFAULTS[el.dataset.bkNum])));
        el.value = n; setBk({ [el.dataset.bkNum]: n });
      });
      const setLocation = async dir => {
        const msg = await ext.checkBackupLocation(dir);
        stateBackupErr = msg;
        if (!msg) { setBk({ location: dir }); stateBackupMsg = ''; await refreshBackups(); } else draw();
      };
      pane.querySelectorAll('[data-bk-location]').forEach(el => el.onchange = () => setLocation(el.value.trim()));
      pane.querySelectorAll('[data-bk-browse]').forEach(b => b.onclick = async () => { const d = await pickFolder(); if (d) setLocation(d); });
      pane.querySelectorAll('[data-sbk-test]').forEach(b => b.onclick = async () => {
        b.disabled = true; b.closest('.set-row').querySelector('[data-sbk-status]').textContent = 'Testing the newest backup…';
        const r = await ext.testStateRestore();
        stateBackupMsg = r.ok ? 'The newest backup restores correctly' : `Restore test failed: ${r.error}`;
        await refreshBackups();
      });
      if (Date.now() - updateHistoryAt > 2000 && pane.querySelector('[data-uh]')) { updateHistoryAt = Date.now(); ext.updateHistory().then(l => { updateHistory = l; draw(); }); }
      pane.querySelectorAll('[data-sbk-create]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        const r = await ext.createStateBackup();
        stateBackupMsg = r.ok ? 'Backed up' : `Backup failed: ${r.error}`;
        await refreshBackups();
      });
      pane.querySelectorAll('[data-sbk-open]').forEach(b => b.onclick = () => ext.openBackupsFolder());
      pane.querySelectorAll('[data-sbk-restore]').forEach(b => b.onclick = async () => {
        const r = await ext.restoreStateBackup(b.dataset.sbkRestore);
        if (!r.ok && !r.cancelled) { stateBackupMsg = `Restore failed: ${r.error}`; draw(); }
      });
      pane.querySelectorAll('[data-backup-run]').forEach(b => b.onclick = () => { b.disabled = true; ext.backupRun(); });
      pane.querySelectorAll('[data-agent-rm]').forEach(b => b.onclick = () => { setAgents(cfg.agents.filter((_, j) => j !== +b.dataset.agentRm)); draw(); });
      pane.querySelectorAll('[data-refine-to]').forEach(s => s.onchange = () => { set('refineTo', s.value); draw(); });
      pane.querySelectorAll('[data-messaging]').forEach(b => b.onclick = () => { set('messaging', !cfg.messaging); draw(); });
      pane.querySelectorAll('[data-team-reset]').forEach(b => b.onclick = () => { set('team', AgentSettings.put(cfg.team || {}, b.dataset.teamReset, clone(AgentSettings.get(ext.defaults.team, b.dataset.teamReset)))); draw(); });
      pane.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { presetPreview = presetPreview === b.dataset.preset ? null : b.dataset.preset; draw(); });
      pane.querySelectorAll('[data-preset-cancel]').forEach(b => b.onclick = () => { presetPreview = null; draw(); });
      pane.querySelectorAll('[data-preset-apply]').forEach(b => b.onclick = () => { set('team', AgentSettings.applyPreset(cfg.team || {}, b.dataset.presetApply)); presetPreview = null; teamLimitMsg = ''; draw(); });
      pane.querySelectorAll('[data-goto]').forEach(a => a.onclick = e => {
        e.preventDefault();
        const id = a.dataset.goto, row = pane.querySelector(`[data-sid="${CSS.escape(id)}"]`);
        if (!row) return;
        const adv = row.closest('.set-adv');
        if (adv) { adv.open = true; advOpen = true; }
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
      });
      pane.querySelectorAll('[data-team-enabled]').forEach(b => b.onclick = () => { set('team', { ...(cfg.team || {}), enabled: !cfg.team?.enabled }); draw(); });
      pane.querySelectorAll('[data-team-verify]').forEach(b => b.onclick = () => { set('team', { ...(cfg.team || {}), verifyBeforeReview: cfg.team?.verifyBeforeReview === false }); draw(); });
      pane.querySelectorAll('[data-team-max]').forEach(el => el.onchange = () => {
        const n = Math.min(16, Math.max(1, Math.round(+el.value || 4)));
        el.value = n; set('team', { ...(cfg.team || {}), maxWorkers: n });
      });
      pane.querySelectorAll('[data-team-budget]').forEach(el => el.onchange = () => {
        const n = Math.max(0, Math.round(+el.value || 0));
        if (n && n < 20000 && cfg.team?.savingProgress === 'inside') { teamLimitMsg = `A ${el.dataset.teamBudget} limit under 20k leaves no room to save progress inside it. Nothing was changed.`; draw(); return; }
        teamLimitMsg = '';
        el.value = n; set('team', { ...(cfg.team || {}), budgets: { ...(cfg.team?.budgets || {}), [el.dataset.teamBudget]: n } });
      });
      pane.querySelectorAll('[data-team-saving]').forEach(el => el.onchange = () => {
        const small = Object.entries(cfg.team?.budgets || {}).filter(([, n]) => n && n < 20000).map(([k]) => k);
        if (el.value === 'inside' && small.length) { teamLimitMsg = `Keep it inside needs every limit at 20k or more (${small.join(', ')} ${small.length === 1 ? 'is' : 'are'} under). Nothing was changed.`; draw(); return; }
        teamLimitMsg = '';
        set('team', { ...(cfg.team || {}), savingProgress: el.value }); draw();
      });
      pane.querySelectorAll('[data-team-cap]').forEach(el => el.onchange = () => {
        const n = Math.max(0, Math.round(+el.value || 0));
        el.value = n; set('team', { ...(cfg.team || {}), dailyCap: n });
      });
      pane.querySelectorAll('[data-team-apply]').forEach(b => b.onclick = async () => { if (await ext.applyLimitSuggestions()) draw(); });
      bindLocalCard(pane, cfg, set, ext);
      pane.querySelectorAll('[data-offer-use-bp]').forEach(b => b.onclick = () => ext.useBigPickle());
      pane.querySelectorAll('[data-offer-dismiss]').forEach(b => b.onclick = () => set('tierOffers', (cfg.tierOffers || []).filter(o => o !== 'use-big-pickle')));
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
        if (it.type === 'toggle') return el.onclick = () => { set(it.key, !cfg[it.key]); el.classList.toggle('on', cfg[it.key]); draw(); };
        if (el.type === 'color') return el.oninput = () => { set('accent', el.value); pane.querySelectorAll('.accent-dot').forEach(d => d.classList.remove('on')); };
        if (it.type === 'range') { el.onchange = draw; return el.oninput = () => { set(it.key, +el.value); el.nextElementSibling.textContent = it.fmt(+el.value); }; }
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
          draw();
        };
      });
    }

    body.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
      tab = b.dataset.tab; query = ''; search.value = ''; confirmingReset = false;
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
    ...(IS_WIN ? [['Media', { mediaPlayPause: 'Play / pause', mediaNext: 'Next track', mediaPrev: 'Previous track', mediaShuffle: 'Shuffle' }]] : []),
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
        <kbd>${MOD}+C</kbd> copies a selection, <kbd>${MOD}+V</kbd> pastes</div>`;
    body.querySelectorAll('[data-add]').forEach(b => b.onclick = () => onAdd(b.dataset.add));
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => onRemove(b.dataset.rm, +b.dataset.i));
  }

  // For the command palette: every setting with a label, and ways to open Settings on one.
  const settingsIndex = () => SECTIONS.flatMap(([t, items]) => items.filter(it => it.key && it.label).map(it => ({ tab: t, key: it.key, label: it.label, type: it.type })));
  const showSetting = label => { query = label; };
  // An old tab name (now a group) opens its new tab, scrolled to that group.
  const showTab = t => { [tab, scrollTo] = tabFor(t); query = ''; };

  return { renderSettings, refreshLocalCard, noteLaunch, renderKeys, actionName, pretty, settingsTab, settingsIndex, showSetting, showTab, GROUPS };
})();
