# AgentLand

A Hyprland-style tiling window manager for terminal AI agents on Windows. Run **Claude Code**, **OpenAI Codex**, **OpenCode**, **Gemini CLI** or any other command-line agent side by side in tiles, across nine workspaces. AgentLand sends a Windows notification when an agent finishes and is waiting for you. Claude Code's subagents each get their **own live tile** as soon as they start.

## Install
Download `AgentLand-<version>.msi` from the [latest release](https://github.com/doolecg/agentland/releases/latest) and run it. It installs per-user, so there's no admin prompt, and adds Start menu and desktop shortcuts. Windows SmartScreen may warn because the installer isn't code-signed: choose *More info → Run anyway*.

You need the agent CLIs themselves installed and on your `PATH`, for example:

| Agent | Command | Install |
|---|---|---|
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` |
| OpenAI Codex | `codex` | `npm i -g @openai/codex` |
| OpenCode | `opencode` | `npm i -g opencode-ai` |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` |

**Explorer integration:** right-click any folder, the empty space inside one, or a drive, and choose **Open in AgentLand**. It opens your default agent in that folder. If AgentLand is already running, the folder opens as a new tile in that window. You can turn this off in Settings.

**Auto-updates:** the app checks this repo's latest release at startup and every 3 hours, then downloads the new MSI in the background. When it's ready, an *Update* pill appears in the top bar. Click it to install and restart, or it installs when you quit. You can turn this off in Settings.

## Agents
`Alt+Enter` opens your default agent. `Alt+N` (or the ＋ in the top bar) opens the launcher: press `1`–`9` to pick an agent, or hold `Shift` to choose a folder first.

In **Settings › Agents** you can add any command that runs in a terminal (Aider, Goose, Amp, a local model wrapper), give it a name, icon and arguments, and choose the default. Each agent runs through the shell set in Settings (PowerShell by default). If it exits with an error, the tile stays open so you can read it.

## Notifications
AgentLand sends a Windows notification when:
- an agent that was working goes quiet (it finished, or it's asking you something),
- an agent rings the terminal bell,
- a Claude subagent finishes.

Click the notification to jump to that tile. By default you don't get one for the tile you're looking at. **Settings › Notifications** has the switches and the quiet time.

## Claude Code subagents
Claude Code writes each subagent's transcript to
`~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`. AgentLand watches that folder:

- A subagent started from a Claude Code tile opens next to that tile. Each Claude tile is launched with its own `--session-id`, which is how AgentLand knows which subagents belong to it.
- Subagents from Claude sessions running elsewhere (another terminal, your IDE) also show up. You can turn that off in Settings.
- Past the tiles-per-workspace limit, new subagents spill onto the next workspace, and a toast tells you where.

## Idle closing
A tile closes when nothing has happened in it for a while: no output, no typing, no new transcript lines, and you're not looking at it. The badge counts down the last 30 seconds. The focused tile and the master are never closed.

| config key | default |
|---|---|
| `autoCloseDoneAgentsSeconds` | 15 |
| `idleCloseAgentSeconds` | 90 |
| `idleCloseTerminalMinutes` | 10 |

Set any of them to `0` to disable it.

## Settings and themes
`Alt+,` (or the ⚙ in the top bar) opens **Settings**. Changes apply straight away and are saved. You can change:

- **Theme:** 16 dark themes: Obsidian (default), Void, Ember, Graphite, Claude, Midnight, Terminal, Nord, Dracula, Tokyo Night, Catppuccin, Gruvbox, Rosé Pine, Everforest, Solarized and One Dark. Most bring their own terminal colors. You can also pick an accent color.
- **Look:** wallpaper, the animated border, its speed, tile opacity and blur, rounding, border width and gaps.
- **Terminal:** font, size, line height, cursor, scrollback.
- **Agents, notifications, layout, idle closing and startup:** everything above, plus the default folder and the shell.

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
| `Alt+←↑→↓` or `Alt+H`, `Alt+J`, `Alt+L` | move focus |
| `Alt+Shift+arrows` | swap tiles |
| `Ctrl+Alt+arrows` | resize |
| `Alt+F` / `Alt+E` | fullscreen / flip split (dwindle) |
| `Alt+1…9` / `Alt+Shift+1…9` | go to / move tile to workspace |
| `Alt+Shift+A` | close all finished subagents |
| `Alt+drag`, `Alt+right-drag`, `Alt+wheel` | swap, resize, switch workspace |

Settings live in `%APPDATA%\AgentLand\config.json`, which stores only what you've changed. Settings has an *Open config.json* button.

## Develop
```
npm install
npm start          # run from source
npm run dist       # build dist/AgentLand-<version>.msi
```
To ship a release: bump the version in `package.json`, add its section to the top of `RELEASE_NOTES.md`, then push a plain version tag (`git tag 1.0.1 && git push origin refs/tags/1.0.1`). The `release` workflow builds the MSI and publishes it with those notes, and installed copies update themselves.

AgentLand started as a generic version of [Claude Agent Viewer](https://github.com/doolecg/claude-agent-viewer).
