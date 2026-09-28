# Operant 1.15.0

You can now back up your agent skills and rules to your own private git repos, from Settings.

**Install:** download `Operant-1.15.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Skills backup:** ⚙ Settings › Skills backup lets you add one or more local clones of your private git repos. **Back up now** copies your skills (Operant's hub and `~/.claude/skills`, with links resolved) and your rules into each repo, commits and pushes the current branch, and shows the result for each repo. It never force-pushes, never touches other branches or remotes, and skips `.env`, key and credential files. Turn on **Automatic** to also back up after Tidy agents applies fixes and every 6 hours while Operant is open. A failed backup shows up in the bell.

---

# Operant 1.14.0

Operant now keeps your agent skills and rules in one place it owns, the task board moves into a dropdown, and worker agents notify you only when they hand a result back.

**Install:** download `Operant-1.14.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Tidy agents:** a new top-bar button audits your Claude setup (skills, CLAUDE.md, memory) and lists what is scattered, duplicated, broken or oversized. Nothing changes until you tick fixes and press Apply. Apply backs up everything it touches first, moves your skills into an Operant-owned hub with a link left in `~/.claude/skills`, and reduces `CLAUDE.md` to one import line. **Undo last apply** puts it all back exactly. It re-checks at startup and every few hours and shows a badge when something drifts, and it never applies anything by itself. Apply waits until no agent is running.
- **Tasks dropdown:** the task board is now a top-bar panel with a count badge and **Clear done** and **Clear all** buttons.
- **Tier dots:** worker tiles and task rows show a traffic-light dot for their tier: green for the first tier, orange for the second, red for any higher one.

## Changed
- **Fewer notifications:** worker agents no longer notify when they finish or go idle. You get one "Task N done" notification, carrying the result, when a worker reports back. Permission prompts still notify.
- **Workers always report back:** a worker that goes idle without reporting gets a reminder typed into its terminal. If it still doesn't report, or its tile closes, you get a "Task N ended without a result" notification and the task is marked.
- **The task board is no longer a tile.** `operant task` and `operant board` work as before, and tasks from an older saved session are kept.
- **Agent rules:** other agents read your rules from the hub once Tidy agents has set it up.
- **Folder label:** an agent tile's folder and branch now sit at the left of its info bar instead of under the close button.

---

# Operant 1.13.1

Team mode now has five tiers, and agents use them by default according to your top-tier slider.

**Install:** download `Operant-1.13.1.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Five team tiers:** `xsmall` (OpenCode Big Pickle), `small` (Sonnet 5.5), `medium` (Opus 5.5, medium effort), `high` (Opus 5.5, high effort) and `max` (Opus 5.5, max effort). Start one with `operant agent "<task>" --tier <name>`.
- **Effort per tier:** ⚙ Settings › Agents › Team has a row for every tier, with an effort dropdown.
- **Agents delegate on their own:** when team mode is on, every agent checks `operant team` at the start and hands tasks to the cheapest tier that fits, never above your top-tier slider.

## Changed
- **Tier names moved:** `small` is now Sonnet 5.5 and Big Pickle is `xsmall`. `operant summarize` and `operant find` use `xsmall`. If you saved your own tiers before, Operant keeps them, so check ⚙ Settings › Agents › Team.
- **Top tier defaults to Small,** so the Opus tiers stay off until you raise the slider.

---

# Operant 1.13.0

Team mode gets two more tiers for harder work, Sonnet 5.5 and Opus 5.5 become the Claude workers, and the settings panel is bigger.

**Install:** download `Operant-1.13.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Two more team tiers:** `high` (Opus 5.5, medium effort, for hard tasks) and `big` (Opus 5.5, high effort, for big tasks). Start one with `operant agent "<task>" --tier high`, and raise the "Top tier" slider in the ⚙ quick menu to allow them.
- **Effort per tier:** a tier can set an `effort` level, which Operant passes to Claude Code as `--effort`.

## Changed
- **Default tiers:** `small` is OpenCode Big Pickle for very easy tasks, and `medium` is Sonnet 5.5 for smaller tasks. If you changed your tiers before, Operant keeps your `small` and `medium` as they are. Change them in ⚙ Settings › Agents › Team to use the new defaults.
- **Bigger settings panel:** ⚙ Settings opens larger, so more of each page fits without scrolling.

---

# Operant 1.12.1

Claude tiles no longer start with a stray "or" message, and the plan limits stop dropping out with a 429 error.

**Install:** download `Operant-1.12.1.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## Changed
- **Plan limits are checked every 10 minutes:** click the usage pill to check them right away. Hovering the pill shows the last numbers without asking again.

## Fixed
- **Claude tiles started with the message "or":** a double quote in Operant's instructions for agents split them apart under Windows PowerShell. Agents got only part of the instructions, and a stray "or" as their first prompt. Agents now get the full instructions and no stray prompt.
- **Plan limits showed a 429 error:** when Anthropic says it's being asked too often, Operant now keeps showing the last numbers and waits longer before asking again.

---

# Operant 1.12.0

Control team mode from the ⚙ quick menu: two sliders set how many workers can run at once and the highest tier they can use.

**Install:** download `Operant-1.12.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Team sliders in the ⚙ quick menu:** "Max workers" (1 to 16) sets how many workers can run at once. "Top tier" sets the highest tier they can use (Small or Medium). Changes apply straight away and are saved.
- **Top tier allowed:** also in ⚙ Settings › Agents › Team. When it's set to Small, `operant agent --tier medium` is refused, and `operant team` lists only the tiers that are allowed.

---

# Operant 1.11.0

Spend less on agents and ship faster. Team mode hands tasks to cheaper workers (`operant agent "<task>" --tier small`), and every agent reads what it learned in shared memory. The `operant` command now covers usage with a token breakdown, team tasks and permissions, and compacting. Every agent tile shows how many tokens it's used and warns you when the prompt cache is about to go cold. Test and build commands return just the failures. Save and quit tells agents to wrap up and waits until they're all done before closing. Every agent follows your main agent's rules, MCP servers and plugin skills.

**Install:** download `Operant-1.11.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Safe Save and quit:** Save and quit in the ⚙ quick menu (default `Alt+Shift+Q`) tells agents to save their progress, waits until they're all idle, then closes Operant. A "Force quit now" button if you can't wait. The Operant skill teaches agents to write a progress note and finish their step when they see this.
- **Auto compact:** when an agent tile's context passes a threshold (⚙ Settings › Agents, default 80%), Operant waits until it's idle and asks it to write a progress note, then types `/compact`. OpenCode tiles use its server instead. Agents can ask for it themselves with `operant compact`.
- **Team mode:** in ⚙ Settings › Agents › Team, set up cheaper worker tiers (e.g. OpenCode with a free model for small tasks like reading files, running tests or simple edits). Run `operant agent "<task>" --tier small` to hand off a task to a worker tile; the lead agent stays focused on the hard parts. Each worker's progress shows on the task board. Max workers at once (default 4), and workers can't start their own workers. `operant team` shows the available tiers and how many workers are running. Off by default.
- **Info bar under each agent tile:** model, context size (e.g. `ctx 84k`), and tokens used since the tile opened (input, output, cache reads). Hover for the breakdown; free-model tiles show free/paid split separately. ⚙ Settings › Usage and `operant usage --breakdown` show where tokens go per project, per tile, and per turn.
- **`operant usage`:** shows the agent's own context size, tokens used, and the plan limits, so it can compact or hand off in time. Add `--breakdown` to see per-project and per-tile counts.
- **`operant summarize` and `operant find`:** pass big reads to a cheap worker (small tier by default), get back a short answer with file:line references. The lead agent never loads the huge file or log itself.
- **Shared memory:** `operant remember "<fact>"` saves a durable fact (user preference, gotcha, decision); `operant recall` lists or searches the index. Facts are stored in the project's `.operant/memory/`, and every agent in that project reads them. `--about <file or function>` ties a fact to code (found through CodeGraph). The launch brief tells agents to check the index at start and save what they learn; ⚙ Settings › Memory lists, edits and deletes facts.
- **`operant compact`:** agents can request compacting their own context; Operant queues it for their next idle moment.
- **`operant ports`:** lists dev servers running in your tiles, with their URLs. Operant spots them in the tile's output.
- **`operant watch`:** notifies when a long-running tile prints an error. Sends a notification and tells the agent on its next call.
- **`operant plan`:** shows a plan in a viewer tile and asks Approve or Change. Returns the user's note if they choose Change, so agents know what to adjust.
- **`operant task`:** agents can split work onto a shared board with `operant task add|claim|done|note`. `operant board` and `operant tiles` show every task, its owner and status.
- **`operant test` and `operant build`:** spot the runner (npm, pytest, cargo, go test, tsc, gradle, dotnet and more) and return only the summary line plus each failure with its file:line. Unknown runners fall back to just the error lines.
- **`operant help`:** the full command reference. Agents call it when they need details on a command.
- **Task board:** a shared tile for fanned-out agents. Every task, owner and status in one place. Add, claim, mark done or leave a note with `operant task`.
- **Plan approval:** agents show you a plan in a viewer and wait for Approve or Change before proceeding.
- **Agents waiting on permission:** when an agent is stuck on a permission prompt (e.g. "Do you want to proceed?"), Operant spots it, marks the tile "waiting for you", sends a notification to the bell and Windows, and shows the exact rule to add to settings. Click the notification to jump to the tile.
- **Cache-cold mark:** when an agent tile sits idle long enough that Claude's prompt cache expires (5 minutes by default), its info bar says "cache cold", so you know the next message re-reads the whole context at full price; big contexts get a countdown in the last minute. Prompt cache settings (lifetime, compact before cold) are in ⚙ Settings › Agents.
- **Launch brief:** every agent tile gets a short Operant brief at startup: you're in Operant, use the skill; if `.codegraph/` exists use CodeGraph first; if `.operant/progress.md` exists read it; use `operant run` + `wait --errors` for long commands; check shared memory. Saves teaching it each time. Every agent shares your main agent's rules file, MCP servers and plugin skills.
- **Reroute long commands:** an optional hook (⚙ Settings › Agents › Reroute long commands) moves test, build and install commands from an agent's own shell into `operant run` tiles + `wait --errors`, so the agent stays focused and saves context. Works for Claude Code's PowerShell tool on Windows and OpenCode's equivalent.
- **Notification panel:** a bell in the top bar (or press `Alt+I`) keeps every notification (agents finishing or waiting on you, `operant watch` errors, runaway and plan-limit alerts), even with Windows notifications off. Click one to jump to its tile.
- **Gear quick menu:** the ⚙ button in the top bar opens a menu with Git (branch and changes), Shortcuts (a key reference) and Save and quit, replacing the old settings button.
- **Compact media player:** cover, title and play button, with controls on hover. ⚙ Settings › Media › *Size* brings back the full controls.
- **Smaller screenshots:** `operant shot` defaults to a downscaled JPEG, with `--selector` and `--region` to capture only part of the page, and `--full` for the old behaviour.

## Changed
- **Smaller Operant skill:** essentials only (~40 lines). The full command reference is in `operant help [cmd]`, which agents call when needed.
- **Every agent follows your main agent's rules file:** the rules (CLAUDE.md), MCP servers, and plugin skills from your main agent are shared with every agent Operant starts, per process. CodeGraph queries are guided by the same prompt instructions.
- **Top bar layout:** the gear menu replaced the settings button, with Git, Shortcuts and Save and quit all there.
- **CLI paths resolve from the shell's folder:** `operant plan ./my-plan.md` and file paths in agent commands now resolve from where the agent is, not Operant's folder.

## Fixed
- **Zen isn't detected as Firefox:** the browser detection now matches by exe name, so Zen (which registers under a `Firefox-<hash>` key) shows as Zen in ⚙ Settings › Startup › *Open links in*.
- **Messages to Claude sometimes left as unsent drafts:** messages Operant types into an agent tile (Save and quit, auto compact) are now sent, not left in the input box.
- **config.json that fails to parse:** is kept as `config.broken.json` instead of lost, so you can recover it.

---

# Operant 1.10.0

Spend fewer tokens. Agents in Operant can now run long commands in their own tiles and read back only the errors or what's new, so test runs and builds stop flooding their context. Every agent tile shows how full its context is, and a guard warns you about (or stops) agents that loop or burn tokens. OpenCode's hidden subagents get their own tiles, agents can open and check web pages in a browser tile, and Operant is much smoother: GPU-drawn terminals, quicker animations and fast scrolling through huge files.

**Install:** download `Operant-1.10.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **The Operant skill:** Operant installs a skill for Claude Code and OpenCode that teaches them to use the app. Agents run tests, builds and dev servers in a tile next to them and read back only the errors, the new output or the lines they're looking for, instead of pulling thousands of log lines into their context. They can also show you a plan in a viewer tile, start other agents in tiles beside them, ask you a question in a dialog, and notify you when they're done. Turn it off in ⚙ Settings › Agents › *Operant skill for agents*.
- **The `operant` command:** works in every tile (PowerShell, cmd, Git Bash and any agent). `operant run`, `read --errors`, `read --new`, `read --grep`, `wait`, `view`, `diff`, `agent`, `ask`, `notify`, `tiles` and more. Run `operant help` in a tile for the list.
- **Context size on agent tiles:** each Claude Code and OpenCode tile shows how full its context is, like `ctx 84k`. It turns orange at 60% and red at 85%, so you know when to `/compact` or start fresh. Turn it off in ⚙ Settings › Usage.
- **OpenCode subagents as tiles:** when OpenCode starts a subagent, it opens in its own tile beside the OpenCode tile, with its messages and tool calls, and closes after it finishes, just like Claude Code's. OpenCode tiles also notify you when they're waiting for you. Subagents from OpenCode running outside Operant show up too (⚙ Settings › Tiles & subagents).
- **Runaway guard:** Operant watches agent tiles for loops (the same tool call over and over), heavy token use, working for an hour without a break, or too many subagents at once. The tile gets a ⚠ badge and you get a notification; click the badge (or press `Alt+Shift+X`) to stop it (Claude Code gets Esc, so the conversation stays). ⚙ Settings › Tiles & subagents can make it stop agents by itself, and sets the limits. Agents can stop tiles they started with `operant stop`.
- **Browser tile:** a real browser inside Operant, with back, forward, reload and DevTools. Open one from the command palette or with `operant browse localhost:3000`. Agents can look at the page (`operant shot`), read its text or console errors, and click or type for simple flows.
- **OpenCode uses Operant's theme:** OpenCode tiles match your theme and accent, with a see-through background. Your own OpenCode settings aren't changed.
- **Git button in the top bar:** the focused project's branch and changes; click it (or press `Alt+G`) to see and commit them.
- **Save and quit:** the ⏻ button in the top bar (or `Alt+Shift+Q`) saves your open editor files and your whole layout, then closes Operant. Everything reopens next time, and Claude Code conversations carry on.
- **Paste screenshots into agents:** with an image on the clipboard, `Ctrl+V` (or `Alt+V`) passes it to Claude Code and OpenCode as in Windows Terminal. Drop files onto a terminal to type their paths, or drag them from the sidebar.
- **Copy on select:** selecting text in a terminal, viewer or changes tile copies it, with a small "Copied" note. Turn it off in ⚙ Settings › Terminal.
- **Images:** the viewer fits images to the tile; click for actual size, `Ctrl`+wheel to zoom, drag to pan. Markdown files show their images inline. Image files always open in the viewer.
- **Resumed agents come back:** a finished subagent's tile reopens when its agent is used again.
- **Links open in Operant:** web links open in a browser tile next to you; Shift+click (or ↗ in a browser tile) sends them to your second browser, Zen if you have it, otherwise Windows' default. ⚙ Settings › Startup › *Open links in*.
- **Crash logs:** Operant now keeps a log and local crash reports (never uploaded) so crashes can be tracked down. ⚙ Settings › Updates › *Open log folder*. If the window itself crashes, it reloads and your tiles come back.
- **Animation setting:** ⚙ Settings › Appearance › *Animations*: Normal, Fast or Off.
- **GPU-accelerated terminals:** terminals are drawn with WebGL, much faster when several tiles are busy. Turn it off in ⚙ Settings › Terminal, or turn off *Hardware acceleration* there for the whole window if Operant draws wrongly on your machine.

## Changed
- **Smoother everywhere:** tiles move and resize on the GPU, the tile borders animate only where you can see them, and huge files, long diffs and big folders scroll smoothly (an 80,000-line file used to freeze Operant).
- **Moving a tile takes you with it:** `Alt+Shift+1`–`9` now switches to the workspace you moved the tile to. Turn it off in ⚙ Settings › Layout.
- **Smaller music controls:** the cover, title and play button, with the rest on hover. ⚙ Settings › Media › *Size* brings back the full controls.
- **Subagents from other sessions open where your master tile is**, not in whichever window you used last.

---

# Operant 1.9.0

Git inside Operant: see what changed, commit and push like in IntelliJ. Also quick open, a command palette, vim keys, resizing tiles with the mouse, and a faster app all round.

**Install:** download `Operant-1.9.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Commit from Operant:** the changes tile lists what changed in a project, file by file, with the diff beside it. Tick the files, write a message and **Commit** or **Commit and Push** (`Ctrl+Enter` commits), or tick **Amend**. Its bar has **Pull**, **Push** and the branch: click the branch to switch or make a new one. Right-click a file to roll it back.
- **Git in the sidebar:** each project shows its branch and how many files changed. Click the count to open the changes tile. Changed files are tinted (yellow changed, green new). Turn it off in ⚙ Settings › Sidebar.
- **Quick open:** press `Ctrl+P` (default) and type part of a file name to view it. `Shift+Enter` edits it instead.
- **Command palette:** press `Ctrl+Shift+P` (default) to run any action or change any setting from one box.
- **Find in viewers:** press `Ctrl+F` (default) in a viewer or changes tile. Enter and Shift+Enter step through the matches. Terminals keep `Ctrl+F` for themselves.
- **Syntax colours** in the viewer, in Markdown code blocks and in diffs.
- **Images in the viewer:** PNG, JPEG, GIF, WebP, SVG and more, with their size.
- **Vim keys:** turn them on in ⚙ Settings › Keybinds. `j`/`k`, `h`/`l`, `gg`/`G`, `Ctrl+D`/`Ctrl+U` and `/` work in viewers and the changes tile, and `[`/`]` changes file there. `Alt+Shift+B` (default) puts the keyboard in the sidebar, where `j`/`k` move, `l` opens, `h` closes, `e` edits, and `a`/`s` open an agent or shell. `Ctrl+J`/`Ctrl+K` move in quick open and the palette.
- **config.json in vim:** ⚙ Settings › Files › *Edit config.json in* can open it in the editor tile.
- **Resize tiles with the mouse:** drag the gap between two tiles.
- **Per-project defaults:** ⚙ Settings › Projects (or right-click a project › *Project defaults…*) sets which agent a project's tiles open with, extra arguments for it, and a command that runs first in every tile opened there.
- **Session limit alerts:** a notification at 80% and 95% of your Claude 5-hour session, and a ring on the token pill showing how much is used. Turn them off in ⚙ Settings › Usage.

## Changed
- **Faster everywhere:** opening a tile no longer stalls the other terminals, the sidebar only redraws the rows that change, the top bar only redraws what changed, and viewers wait for their file to change instead of checking it.
- **Lighter music controls:** the music helper now reacts to Windows' change events instead of checking every 0.8 seconds, and sends the cover only when the track changes.

## Fixed
- **Closing a vim tile with unsaved edits** now asks: Save and close, Discard or Cancel.
- **Viewer tiles no longer close after 10 idle minutes**, and neither do editor tiles with unsaved changes.
- **Viewer and editor tiles come back after an update**, like terminals.
- **Typing a workspace name** no longer sets off Alt shortcuts.
- **Clicking the track finds Firefox,** and the volume slider controls Firefox's own volume.

---

# Operant 1.8.0

View and edit files inside Operant, see your Claude plan limits, and a redesigned top bar with the clock in the middle and music beside your workspaces. Your tiles now come back after an update.

**Install:** download `Operant-1.8.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Your tiles come back after an update:** the same tiles, folders and layout reopen, and Claude Code conversations pick up where they left off. ⚙ Settings › Tiles & subagents › *Reopen my tiles* can also do it every time Operant starts.
- **Updates wait for your agents:** clicking the update pill while an agent is working installs once it finishes. Click again to update now, or right-click to cancel.
- **File viewer:** double-click a file in the sidebar to view it in a tile. Markdown is rendered (headings, lists, task lists, tables, code blocks, links), other text files show with line numbers, and the tile reloads when the file changes. **Source** shows the raw Markdown, and ✎ edits the file.
- **Edit files in vim:** right-click a file › *Edit in vim*. Vim shows line numbers and a strip of its shortcuts along the bottom, and the tile closes when you quit. ⚙ Settings › Files picks the editor (Vim, Neovim, micro, nano, Windows' Edit or your own) and what double-clicking a file does.
- **Plan limits:** hover the token pill for a card with today's tokens and your Claude 5-hour session and weekly limits as bars, with when each resets, like Claude Code's `/usage`. Turn it off in ⚙ Settings › Usage.
- **Daily token budget:** set one in ⚙ Settings › Usage and the token pill turns orange at 80% and red past it.
- **Calendar:** hover the clock for this month's calendar. Click the clock to copy the time and date.
- **Clock settings:** ⚙ Settings › Top bar sets 12- or 24-hour time, seconds and the date, and can show the focused tile's title beside the clock.
- **Named workspaces:** double-click a workspace number to name it. The name shows on the active workspace, on hover and on an empty workspace.
- **Track progress and quick jump:** a thin line under the music shows how far through the track you are (hover it for the time left). Click the track name to bring the player to the front.
- **Jump to a project's terminal:** click the ◈ next to a project in the sidebar to go to its most recent master terminal.
- **CodeGraph on startup:** when Operant starts, pinned projects with lots of changes since their last index are indexed together in one tile. ⚙ Settings › CodeGraph can do it for all projects, change what counts as lots, or turn it off.

## Changed
- **Top bar:** the time and date sit in the middle, and the music controls sit right after the workspace switcher. On narrow windows the music shrinks to the cover and play/pause, and the date drops out.

---

# Operant 1.7.1

Smoother typing: busy terminals in other tiles no longer hold up what you type in the one you're using.

**Install:** download `Operant-1.7.1.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## Changed
- **The tile you're typing in comes first:** its output still shows the moment it arrives. Other tiles catch up a few times a second, and a little less often while you type.

## Fixed
- **Typing stalled while other tiles were busy:** with several agents working at once, keys could stop showing up in the focused tile until they calmed down. Now they go through straight away.
- **Keys going nowhere:** if the focused tile loses the keyboard without anything else taking it, for example when another tile closes, it takes it straight back.

---

# Operant 1.7.0

Token usage in the top bar: see how many tokens Claude Code has used today, and click for a graph of them over time.

**Install:** download `Operant-1.7.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Token usage pill:** the top bar shows Claude Code's tokens used today, across every session: Operant's tiles, other terminals, your IDE and subagents. Hover it for input, output, cache write and cache read, and the last hour.
- **Token usage graph:** click the pill (default `Alt+U`) for stacked bars over the last 5 hours, 24 hours, 7 days or 30 days. Hover a bar for its numbers. It also shows totals by token type and which projects used the most, and it updates live.
- **Choose what counts:** click a token type on the graph, or use ⚙ Settings › Usage, to count it or leave it out. Cache reads are left out by default because they're usually far bigger than everything else. ⚙ Settings › Usage also turns the pill off.

The numbers come from Claude Code's transcripts in `~/.claude/projects`, so they go back as far as those do.

---

# Operant 1.6.1

Readable release notes: what's new in an update now shows formatted in Settings › Updates.

**Install:** download `Operant-1.6.1.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## Changed
- **Formatted release notes:** ⚙ Settings › Updates shows the notes with headings, lists and bold text instead of raw Markdown. They appear while an update downloads, and when you're up to date, *What's new in this version* shows the notes for the version you have. Links in them open in your browser.
- **Update pill:** its tooltip now points to ⚙ Settings › Updates for what's new, instead of showing the notes as raw text.

---

# Operant 1.6.0

Project groups in the sidebar, and CodeGraph built in: install it and index your projects from Operant.

**Install:** download `Operant-1.6.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Project groups:** sort your pinned projects into named groups in the sidebar. Click ▣ in the sidebar header to make one and type its name. Right-click a project to move it into a group or out of one, or use a group's ＋ to add a folder. Click a group to fold it, double-click to rename it, and right-click it to rename or remove it. Removing a group keeps its projects pinned.
- **CodeGraph:** a code index your agents query instead of searching files. ⚙ Settings › CodeGraph shows whether it's installed, with a button to install or update it. Installing also connects it to your agents.
- **Index with CodeGraph:** ◇ on a project indexes it, ◇ on a group indexes the whole group, and ◇ in the sidebar header indexes all your projects. It also appears when you right-click a folder. The indexing runs in a terminal tile, so you can watch it. Folders that are already indexed are brought up to date. You can hide these buttons in ⚙ Settings › CodeGraph.

---

# Operant 1.5.0

Open a project in your IDE straight from the sidebar.

**Install:** download `Operant-1.5.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Open in IDE:** hover a project in the sidebar and click ⌨ to open it in your IDE. Right-clicking any folder in the tree also has *Open in …*. Choose the IDE in ⚙ Settings › Sidebar: VS Code (default), Cursor, Windsurf, Zed, IntelliJ IDEA, Rider, Sublime Text, or a custom command. Operant finds the IDE even when it isn't on your PATH, as long as it's in its usual install folder.

---

# Operant 1.4.1

Safer automatic updates. An update that ran while Operant was still open, or at the same time as another update, could leave Operant unable to start.

**Install:** download `Operant-1.4.1.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves. If Operant won't start after an earlier update (a "JavaScript error occurred in the main process" message about `app.asar.unpacked`), run this installer by hand to repair it.

## Fixed
- **Updates no longer break the install:** if part of Operant is still running when an update is due, the update waits and tries again the next time you close Operant, instead of installing over files in use.
- **Two updates at once:** if another installer is already running, the update waits for it to finish instead of failing.
- **Always the newest version:** a newer release now replaces an update that downloaded earlier and hasn't been installed yet, so an older update is never installed over a newer one.

---

# Operant 1.4.0

A projects sidebar with a folder tree, more than one Operant window at a time, and a cleaner Settings with tabs and a Check for updates button. Clicking a notification now reliably takes you to its tile.

**Install:** download `Operant-1.4.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves.

## New
- **Projects sidebar:** your pinned projects down the left, each with a folder tree, plus the folders your open tiles are running in. Click a folder to expand it; it also becomes where new tiles open. Hover a folder to start your default agent or a shell there, or right-click it to pick an agent, open it in Explorer, copy the path, or pin it. Add a project with ＋. Hide or show the sidebar with the button at the far left of the top bar or `Alt+B`, and drag its edge to resize it. ⚙ Settings › Sidebar has the width and *Show hidden files*.
- **More than one window:** starting Operant again opens another window with its own workspaces and tiles. So do `Alt+Shift+N`, *New Operant window* in the agent picker, and *New window* when you right-click the taskbar icon. A subagent opens in the window whose tile started it, and a setting changed in one window applies to all of them.
- **Check for updates:** ⚙ Settings › Updates shows your version and has a **Check for updates** button. When a new version has downloaded, the same tab shows what's new and a **Restart and install** button.

## Changed
- **Settings has tabs:** one tab per area down the left, plus a search box that finds any setting. It reopens on the tab you used last. Keybinds now have their own tab too.
- **Explorer's "Open in Operant"** still adds a tile to the window you used last. You can switch it to open a new window instead in ⚙ Settings › Startup.

## Fixed
- **Clicking a notification** brings Operant to the front on that tile, switching window and workspace if needed. That now also works when you click it later from the Action Center. It used to do nothing at times, or leave Operant behind other windows.

---

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
