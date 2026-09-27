# Operant 1.3.0

Media controls in the top bar, like Spotify's. Tiles also no longer close while their agent is still working, or before you've seen that it finished.

**Install:** download `Operant-1.3.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Media controls:** the middle of the top bar shows whatever Windows is playing (Spotify, a browser tab, any player in Windows' volume flyout). You get the cover, the track and artist, and shuffle, previous, play/pause and next buttons. The volume slider sets that app's own volume in the Windows mixer, or the system volume when the app has no audio of its own. Drag it, scroll over it, or click the speaker to mute. Turn it off in ⚙ Settings › Media.
- **Media keybinds:** play/pause, next, previous and shuffle can each get a key in the keybinds popup (default `Alt+K`). None are bound by default, since keyboard media keys already work.

## Changed
- **Nothing closes while it's working:** a subagent tile stays open until the subagent says it's finished, and an agent terminal stays open while its agent is busy. The *Close quiet agents after* setting is gone, because it closed agents that hadn't finished.
- **Finished tiles wait for you:** a subagent that finished, or an agent terminal that finished a turn, stays open until you've seen it. That means it has been on screen while Operant is the active window. Until then its badge reads *new*. The *Close finished agents after* countdown (15 seconds by default) starts from that moment.

---

# Operant 1.2.0

The status pill in the top bar now counts your agent terminals too, including the master, so you can see how many are working and how many are idle.

**Install:** download `Operant-1.2.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 updates to this by itself.

## New
- **Idle count:** the status pill in the top bar now reads *running · idle · done*. *Idle* is the number of agent terminals that are open but quiet.

## Changed
- **Agent terminals count as running:** the master tile and any other agent terminal count under *running* while the agent is producing output, not just Claude subagents.
- **Workspace busy dot:** a workspace button now shows the busy dot while an agent terminal on it is working, not only while one of its subagents runs.

---

# Operant 1.1.0

AgentLand is now **Operant**. On its first start, Operant asks which agent you'd like to use and then opens that one each time.

**Install:** download `Operant-1.1.0.msi` and run it. It installs per-user, so there's no admin prompt. Later versions install themselves. If you installed AgentLand 1.0.0, uninstall it from *Settings › Apps* once Operant is in: the new name makes it a separate app, and your AgentLand settings don't carry over.

## New
- **Pick your agent on first start:** the first time Operant opens, it asks which agent to use (Claude Code, OpenAI Codex, OpenCode, Gemini CLI or one you add). That agent opens right away and becomes the default for `Alt+Enter`, the master tile and the Explorer entry. You can change it later in ⚙ Settings › Agents.

## Changed
- **New name:** AgentLand is now Operant, including the window, the installer, the *Open in Operant* Explorer entry and the GitHub repo ([doolecg/operant](https://github.com/doolecg/operant)).

## Fixed
- **A `config.json` saved with a byte-order mark** (Notepad, PowerShell) used to be ignored silently. Now it loads.

---

# AgentLand 1.0.0

First release, as AgentLand. It's a tiling workspace for terminal AI agents. You can run Claude Code, OpenAI Codex, OpenCode, Gemini CLI or any other command-line agent side by side, and get a Windows notification when one needs you.

## New
- **Any terminal agent:** Claude Code, OpenAI Codex, OpenCode and Gemini CLI are set up already. You can add any other command in ⚙ Settings › Agents, with its own name, icon and arguments, and choose which one is the default. If an agent's CLI isn't installed, its tile tells you how to install it.
- **Agent launcher** (default `Alt+N`, or the ＋ in the top bar): press `1`–`9` to open an agent, or hold `Shift` to choose a folder first. `Alt+Enter` opens the default agent straight away.
- **Windows notifications** when an agent finishes and is waiting for you, rings the terminal bell, or a Claude subagent finishes. Click one to jump to that tile. You can change this in ⚙ Settings › Notifications.
- **16 themes**, including Nord, Dracula, Tokyo Night, Catppuccin, Gruvbox, Rosé Pine, Everforest, Solarized, One Dark and two new ones, Midnight and Terminal. Most set their own terminal colors.
- **Everything from Claude Agent Viewer:** Hyprland-style master and dwindle layouts, nine workspaces, a live tile for each Claude Code subagent, idle tiles that close themselves, rebindable keys, the Settings page, the Explorer entry, and auto-updates from GitHub releases.
- **Agents find their commands** even when they were installed after the app started, because tiles pick up the current `PATH` from Windows.
