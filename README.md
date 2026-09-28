# Operant

A Hyprland-style tiling window manager for terminal AI agents on Windows. Run **Claude Code**, **OpenAI Codex**, **OpenCode**, **Gemini CLI** or any other command-line agent side by side in tiles, across nine workspaces. Operant sends a Windows notification when an agent finishes and is waiting for you. Claude Code's subagents each get their **own live tile** as soon as they start.

## Saving tokens
Operant is built so agents don't have to read their own noise. A few things do that work:

- **Long commands run in their own tile.** `operant run "npm test" --title tests` starts a test, build, install or dev server in a tile and returns right away. The agent reads back only what it needs with `operant wait <id> --errors`, `operant read <id> --new` or `operant read <id> --grep "<pattern>"`. The full log stays on screen in the tile for you; only the requested part goes into the agent's context. Output is cleaned up first — colour codes stripped, repeated and progress lines collapsed — before it reaches the agent.
- **Test and build digests:** `operant test` and `operant build` auto-detect the runner and return only the summary line plus each failure's file:line, keeping the full log on screen.
- **Auto compact and usage:** when context hits a threshold (default 80%, configurable in Settings › Agents), Operant runs `/compact` at the next idle moment. Agents can request it themselves with `operant compact` at a clean stopping point. Check `operant usage` to see your context and plan limits.
- **Tile info bar** shows the agent's model, context size, tokens used since the tile opened, and a cache-cold mark when idle.
- **Launch brief** starts every agent with the essentials: use CodeGraph before grep/reading, read `.operant/progress.md` if it exists, run long commands through `operant run`/`wait`.
- **The Operant skill installs itself** for Claude Code and OpenCode, so agents use `operant run`/`wait`/`read` without being told to. `operant help [cmd]` shows the full command reference.
- **Optional "Reroute long commands" hook** (Settings › Agents, off by default) moves test, build and install commands from the agent's shell into tiles automatically, so savings don't depend on remembering the skill.
- **Cheaper screenshots:** `operant shot --selector "<css>"` captures just part of the page; screenshots default to downscaled JPEG.
- **CodeGraph:** agents query a code index instead of grepping and reading whole files. Indexing runs on startup for projects that changed.
- **Context size on every agent tile,** like `ctx 84k`, orange at 60% and red at 85%, so you can see when to `/compact` or start a fresh session before a big context starts costing you on every message.
- **Token usage pill** with today's total, a daily budget, and a graph over time; plan limit alerts at 80% and 95%.
- **Subagents get their own tiles,** so you can see what one is doing without asking the agent to summarise it back to you.

```
operant run "npm test" --title tests
operant wait 7 --errors
```

## Install
Download `Operant-<version>.msi` from the [latest release](https://github.com/doolecg/operant/releases/latest) and run it. It installs per-user, so there's no admin prompt, and adds Start menu and desktop shortcuts. Windows SmartScreen may warn because the installer isn't code-signed: choose *More info → Run anyway*.

You need the agent CLIs themselves installed and on your `PATH`, for example:

| Agent | Command | Install |
|---|---|---|
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` |
| OpenAI Codex | `codex` | `npm i -g @openai/codex` |
| OpenCode | `opencode` | `npm i -g opencode-ai` |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` |

**Explorer integration:** right-click any folder, the empty space inside one, or a drive, and choose **Open in Operant**. It opens your default agent in that folder. If Operant is already running, the folder opens as a new tile in that window. You can turn this off in Settings.

**Auto-updates:** the app checks this repo's latest release at startup and every 3 hours, then downloads the new MSI in the background. When it's ready, an *Update* pill appears in the top bar. Click it to install and restart, or it installs when you quit. You can turn this off in Settings.

## Agents
The first time Operant starts, it asks which agent you'd like to use. That agent opens right away and becomes your default.

`Alt+Enter` opens your default agent. `Alt+N` (or the ＋ in the top bar) opens the launcher: press `1`–`9` to pick an agent, or hold `Shift` to choose a folder first.

In **Settings › Agents** you can add any command that runs in a terminal (Aider, Goose, Amp, a local model wrapper), give it a name, icon and arguments, and choose the default. Each agent runs through the shell set in Settings (PowerShell by default). If it exits with an error, the tile stays open so you can read it.

## Notifications
Operant sends a Windows notification when:
- an agent that was working goes quiet (it finished, or it's asking you something),
- an agent rings the terminal bell,
- a Claude subagent finishes.

Click the notification, or click it later in the Action Center, and Operant comes to the front on that tile. It switches to the right window and workspace if it needs to. By default you don't get one for the tile you're looking at. **Settings › Notifications** has the switches and the quiet time.

## Claude Code subagents
Claude Code writes each subagent's transcript to
`~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`. Operant watches that folder:

- A subagent started from a Claude Code tile opens next to that tile. Each Claude tile is launched with its own `--session-id`, which is how Operant knows which subagents belong to it.
- Subagents from Claude sessions running elsewhere (another terminal, your IDE) also show up. You can turn that off in Settings.
- Past the tiles-per-workspace limit, new subagents spill onto the next workspace, and a toast tells you where.

## Idle closing
A tile closes when nothing has happened in it for a while: no output, no typing, no new transcript lines, and you're not looking at it. The badge counts down the last 30 seconds. The focused tile and the master are never closed.

Nothing closes while it's still working: a subagent stays open until it says it's finished, and an agent terminal stays open while its agent is busy. A tile that has finished also waits until you've seen it. That means it has been on screen while Operant is the active window, and until then its badge reads *new*. The countdown starts from that moment, so a finished subagent closes 15 seconds after you first see it.

| config key | default |
|---|---|
| `autoCloseDoneAgentsSeconds` | 15 |
| `idleCloseTerminalMinutes` | 10 |

Set any of them to `0` to disable it.

## More than one window
Start Operant again (Start menu, desktop shortcut, or *New window* when you right-click its taskbar icon) and you get another Operant window, with its own workspaces and tiles. You can also press `Alt+Shift+N` or use *New Operant window* in the agent picker. A Claude subagent opens in the window whose tile started it. Settings changed in one window apply to all of them. Explorer's *Open in Operant* adds a tile to the window you used last, or opens a new window: pick which in Settings › Startup.

## Projects sidebar
The left side shows your **projects**, each with a folder tree you can expand, plus the folders your open tiles are running in. `Alt+B` or the sidebar button at the far left of the top bar hides and shows it. Drag its right edge to resize it.

- **Add a project** with **＋** in its header, or right-click any folder and choose *Pin as project*.
- **Click a folder** to expand it. It also becomes the folder new tiles open in. Double-click a file to open it in its default app.
- **Hover a folder** for quick buttons that start your default agent or a shell there. **Right-click** for more: pick an agent here, open in Explorer, copy the path, pin or unpin.
- A project shows how many tiles are open in it, and the one your focused tile is in is highlighted.
- Settings › Sidebar has the on/off toggle, the width and *Show hidden files*.

## Media controls
The top bar shows whatever Windows is playing, whether that's Spotify, a browser tab or any other player that shows up in Windows' volume flyout. You get the cover, the track and artist, and **shuffle**, **previous**, **play/pause** and **next** buttons. There's also a **volume** slider: drag it or scroll over it, and click the speaker to mute. The slider sets that app's own volume in the Windows mixer, or the system volume when the app has no audio of its own. Turn it off in Settings › Media. Play/pause, next, previous and shuffle can each get a key in the keybinds popup.

## Token usage
The top bar shows how many tokens Claude Code has used today, across every session (Operant's tiles, other terminals, your IDE and subagents). Hover it for the breakdown and the last hour. Click it, or press `Alt+U`, for a graph over the last 5 hours, 24 hours, 7 days or 30 days, with totals by type and by project. Hover a bar for its numbers.

The numbers come from Claude Code's own transcripts in `~/.claude/projects`, so they cover what those still hold (Claude Code clears out old ones after 30 days by default). By default the bar counts input, output and cache-write tokens. Cache reads are usually far bigger than the rest, so they're left out. Click a type on the graph, or use Settings › Usage, to count it or leave it out. Turn the pill off in Settings › Usage.

## Settings and themes
`Alt+,` (or the ⚙ in the top bar) opens **Settings**, with a tab for each area down the left and a search box that finds any setting. It reopens on the tab you used last. Changes apply straight away and are saved. You can change:

- **Theme:** 16 dark themes: Obsidian (default), Void, Ember, Graphite, Claude, Midnight, Terminal, Nord, Dracula, Tokyo Night, Catppuccin, Gruvbox, Rosé Pine, Everforest, Solarized and One Dark. Most bring their own terminal colors. You can also pick an accent color.
- **Look:** wallpaper, the animated border, its speed, tile opacity and blur, rounding, border width and gaps.
- **Terminal:** font, size, line height, cursor, scrollback.
- **Agents, notifications, layout, idle closing, sidebar, media controls, token usage and startup:** everything above, plus the default folder and the shell.
- **Keybinds:** the same editor as the keybinds popup.
- **Updates:** your version, **Check for updates**, and *Update automatically*. When a new version has downloaded, this is where you see what's new and can restart to install it.

## Keys (Alt is the "Super" key; Alt+K shows them all)
`Alt+K` (or the ⌨ in the top bar) opens the **keybinds** popup. Hover a row and click **+** to add a key, or **✕** to remove one. A key that's already used moves to the new action.

| | |
|---|---|
| `Alt+Enter` / `Alt+Shift+Enter` | new default agent / new agent in a folder |
| `Alt+N` | pick an agent |
| `Alt+Shift+T` | new PowerShell |
| `Alt+Q` | close tile |
| `Alt+M` / `Alt+Shift+M` | master ⇄ dwindle layout / make focused tile the master |
| `Alt+K` / `Alt+,` | keybinds / settings |
| `Alt+U` | token usage graph |
| `Alt+←↑→↓` or `Alt+H`, `Alt+J`, `Alt+L` | move focus |
| `Alt+Shift+arrows` | swap tiles |
| `Ctrl+Alt+arrows` | resize |
| `Alt+F` / `Alt+E` | fullscreen / flip split (dwindle) |
| `Alt+1…9` / `Alt+Shift+1…9` | go to / move tile to workspace |
| `Alt+Shift+A` | close all finished subagents |
| `Alt+B` | show / hide the projects sidebar |
| `Alt+Shift+N` | new Operant window |
| `Alt+drag`, `Alt+right-drag`, `Alt+wheel` | swap, resize, switch workspace |

Settings live in `%APPDATA%\Operant\config.json`, which stores only what you've changed. Settings has an *Open config.json* button.

## Develop
```
npm install
npm start          # run from source
npm run dist       # build dist/Operant-<version>.msi
```
To ship a release: bump the version in `package.json`, add its section to the top of `RELEASE_NOTES.md`, then push a plain version tag (`git tag 1.0.1 && git push origin refs/tags/1.0.1`). The `release` workflow builds the MSI and publishes it with those notes, and installed copies update themselves.

Operant started as a generic version of [Claude Agent Viewer](https://github.com/doolecg/claude-agent-viewer).
