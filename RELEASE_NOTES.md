# Operant 2.1.0

Operant now looks after itself: it backs up its own state, updates can be undone, settings and config carry over between versions, and a health panel shows what's actually working.

**Install:** download the file for your system.
- **Windows:** `Operant-2.1.0-windows-x64.msi`. Run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).
- **macOS:** `Operant-2.1.0-mac-arm64.dmg` (Apple Silicon) or `Operant-2.1.0-mac-x64.dmg` (Intel). Drag Operant to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Operant.app` once.
- **Linux:** `Operant-2.1.0-linux-x86_64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant-2.1.0-linux-amd64.deb` (`sudo apt install ./Operant-2.1.0-linux-amd64.deb`).

## New
- **Backups of Operant's own state:** your config, personal memory, board, usage tags, outcomes and memory stats are backed up daily. Each backup is read back and checked after it's written, and once a week a test restore proves a backup can really be restored. Under Settings › Backups you can *Back up now*, *Restore*, *Test restore* and *Open folder*, and choose where backups go, how often they run and how many are kept. A backup is also taken before every update and before a config upgrade. Secrets are left out of backups.
- **Updates you can undo:** a backup is taken before an update installs. The download is checked against the sha256 GitHub publishes for it, and every update is recorded in an update history (from, to, when, result). If a new version fails to start twice, Operant offers to reinstall the previous one; it never does it on its own.
- **Update channel and frequency:** pick stable or beta, and how often Operant checks. It checks there's enough disk space before downloading. Settings › Updates shows your current version, the latest one and when it last checked.
- **A health panel in the top bar:** shows what's working and what isn't, with real states. A configured MCP server or an installed model shows as available, not healthy, until it has been shown to work.
- **First run, upgrade and recovery are noticed:** Operant knows when it's a fresh install, a new version or a recovery after a problem, and treats each accordingly.
- **Restart-only settings say so:** a setting that needs a restart shows a notice with *Restart now*.
- **Reset to default:** reset a single setting, or a whole section.
- **Leads hand out cheap work:** a lead gives independent parts of a request to a cheap tier, and always approves or rejects a review.

## Changed
- **Restore is safer:** restoring a backup upgrades it to the current version, validates it and health-checks the result. A backup from a newer Operant is refused. A safety backup is taken first.
- **Config carries a version:** upgrades run as migrations, after keeping a copy of your old config. A config from a newer Operant is left alone.
- **Saves are crash-safe:** config, session, memory, usage tags and outcomes are written to a temporary file and renamed, so a crash or power cut never leaves a half-written file.
- **Settings are checked:** an invalid value is refused with a clear error that names the setting.
- **Secrets stay out of logs.**
- **Every setting is tested (for developers):** a test checks each setting saves, loads back and is actually used.

## Fixed
- **`operant remember` outside a project** (home folder, drive root) no longer creates `.operant/memory` there; it saves to personal memory.
- **Restart-only settings looked like they'd applied.** They now tell you a restart is needed.
- **A crash while saving could leave a half-written config or memory file.**

---

# Operant 2.0.0

Team work learns from what happened: every task's outcome is recorded, `operant agent` picks a tier from those results, a stuck worker moves up a tier on evidence, code tasks are checked before you review them, and remembered facts now know when they've gone stale.

**Install:** download the file for your system.
- **Windows:** `Operant-2.0.0-windows-x64.msi`. Run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).
- **macOS:** `Operant-2.0.0-mac-arm64.dmg` (Apple Silicon) or `Operant-2.0.0-mac-x64.dmg` (Intel). Drag Operant to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Operant.app` once.
- **Linux:** `Operant-2.0.0-linux-x86_64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant-2.0.0-linux-amd64.deb` (`sudo apt install ./Operant-2.0.0-linux-amd64.deb`).

## New
- **The tier is picked from real results:** `operant agent` without a tier chooses the cheapest tier that has passed most tasks of that kind, and says why in one line (for example "small: 7/8 fixes passed"). With too little history it says "insufficient data" and falls back to the usual suggestion. Now and then it tries the tier below a proven one, so a cheaper tier can earn its way back. It never goes above the top tier you allow.
- **Every team task's outcome is recorded:** type, tier, model, tokens, cost, attempts, escalations and result, kept for 90 days. This is what tier picking reads.
- **A stuck worker moves up a tier on evidence:** when the same command fails again with the same output, or fails three times, or a code task runs 30 tool calls without editing a file. The limit sits next to the runaway guard in Settings (*Tool calls without a file edit*; 0 turns it off).
- **Checks before review:** when a worker finishes a fix, feature, refactor or test task, Operant runs the project's test (else build) command, and the review card shows a pass or fail mark and the size of the diff. A failing check goes back to the worker once. Docs and lookup tasks skip it. Turn it off under Settings › Agents › Team › *Run checks before review*.
- **Memory that knows when it's stale:** facts record their confidence, dates and the code they describe. A fact whose code has changed shows as stale instead of being trusted or deleted. Recall ranks by relevance, how useful a fact has been and its age. `operant recall used <id>` and `operant recall wrong <id>` tell it which facts helped, `operant remember --supersedes <id>` replaces an old fact, and `--confidence` and `--about` set the rest. Usage counters are kept outside your memory files, so recalling never edits them. Existing memories keep working unchanged.
- **Agents report back with `operant notify`** when you ask them to say when long work is done.
- **A benchmark suite in the evals** covers team work and compares against a run without Operant (for developers).

## Changed
- **A rejected worker is told exactly what to do next:** redo the task and hand it back.

## Fixed
- **A rejected worker no longer trips the runaway guard** by checking the board.
- **Board checks don't count as a loop:** read-only `operant` status calls are ignored by the guard.

---

# Operant 1.19.0

Agents get cheaper and better briefed: the Operant skill loads per session, a live context is injected at start and after every compact, team tiers span Claude and OpenCode, results are reviewed before they count, agents can message each other, and usage shows cost by model, tier, task and project.

**Install:** download the file for your system.
- **Windows:** `Operant-1.19.0-windows-x64.msi`. Run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).
- **macOS:** `Operant-1.19.0-mac-arm64.dmg` (Apple Silicon) or `Operant-1.19.0-mac-x64.dmg` (Intel). Drag Operant to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Operant.app` once.
- **Linux:** `Operant-1.19.0-linux-x86_64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant-1.19.0-linux-amd64.deb` (`sudo apt install ./Operant-1.19.0-linux-amd64.deb`).

## New
- **The Operant skill loads per session:** Claude Code and OpenCode get it from Operant when a tile starts, so nothing is written to your home folder any more. Copies that older versions left in your agents' folders are removed.
- **Live context:** at session start and after every compact, the agent is handed the current state with `operant prime`. Subagents get a short brief, workers are asked to report when they stop, and the launch brief is down to about 600 bytes.
- **Lean skill and worker hand-backs:** the skill is much shorter. A worker finishes with `operant task done --status done|blocked|failed --note "<files, open issues>"`, a note of 100 words at most.
- **Team tiers across Claude and OpenCode:** tiers use Haiku, Sonnet and Opus and OpenCode's free and paid models, whichever are available. When a CLI or model is missing, the tier falls back and Settings shows what it fell back to. OpenCode leads get tier subagents, and a tier is suggested when none is given.
- **Review, retry and escalation:** a worker's result waits for approval on the board. A failed task is retried once, then moved up a tier. Each tier can have a token budget (Settings › Agents › Team, or `--budget`) that stops a worker and escalates it; 0 means no limit.
- **Agent messaging (opt-in):** `operant msg <tile> "<text>"` and `operant inbox` let agents talk to each other, Claude Code and OpenCode included. Messages arrive between tool calls, at the end of a turn, when the agent is idle, or through OpenCode's server, and never land on a permission prompt. Repeats are dropped and each pair is rate limited. Turn it on in Settings › Agents › Team.
- **Usage by model, tier, task and project:** the usage panel shows tokens and cost for each, plus the cache hit rate. Every price shows where it came from, and a model without a known price stays unknown instead of guessed. Claude cost is the API-equivalent figure, not what your plan charges.
- **OpenCode history from its database:** OpenCode usage is read from OpenCode's own database, so past sessions count too.
- **A more reliable `operant` command:** no 5-minute limit on `plan`, `ask` and `wait`; commands run in the folder your shell is in (`--cwd` only to override); options take commas, which suits PowerShell; each `run` names the next step; aliases work and a mistyped command suggests the closest match; `operant help <topic>` explains a topic.

## Changed
- **Reroute long commands is on by default** (Settings › Agents).

## Fixed
- **Claude Code never saw the skill's description:** its frontmatter wasn't valid, so Claude saw only "Operant control".
- **The long-command reroute could approve a command for you.** It never does now.
- **`operant test` and `operant build` gave up after about 20 seconds** on slower suites. They now wait for the result.
- **OpenCode tokens were counted too often:** every update re-added the running total, inflating usage, budgets and the runaway guard. Each message is now counted once.
- **Team workers stopped on permission prompts** for harmless commands like `git status`. Workers may now run read-only git commands, folder listings and the `operant` commands they report with; anything else still asks, and your own deny or ask rules still win.
- **Retries, report nudges and `operant send --enter` left the text in the prompt** without submitting it. They now submit.

---

# Operant 1.18.1

Four fixes: shortcuts that stopped working with some Markdown files open, links to headings in long files, long lines in the changes tile, and the *Always allow…* button.

**Install:** download the file for your system.
- **Windows:** `Operant-1.18.1-windows-x64.msi`. Run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).
- **macOS:** `Operant-1.18.1-mac-arm64.dmg` (Apple Silicon) or `Operant-1.18.1-mac-x64.dmg` (Intel). Drag Operant to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Operant.app` once.
- **Linux:** `Operant-1.18.1-linux-x86_64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant-1.18.1-linux-amd64.deb` (`sudo apt install ./Operant-1.18.1-linux-amd64.deb`).

## Fixed
- **Shortcuts stopped with some Markdown files open:** a file in a viewer tile with a heading named like one of Operant's panels, such as "Notifications" or "Settings", made Operant think that panel was open, so most shortcuts did nothing until the file was closed. Headings no longer get in the way, and links to them within the file still jump there.
- **Links to a heading in a long Markdown file overshot it:** the first click could scroll past the heading. It now jumps straight to it.
- **Long lines in the changes tile were cut off** at the tile's edge. They scroll sideways now.
- **Always allow… opened a folder:** after Claude Code asks for the same permission three times, *Always allow…* › *Open settings file* opened the project's `.claude` folder. It now opens `.claude/settings.local.json` in an editor tile.

---

# Operant 1.18.0

Operant now runs on macOS and Linux as well as Windows, with an installer for each in every release. Every tile also gets the info bar, and tile titles no longer overlap their buttons.

**Install:** download the file for your system.
- **Windows:** `Operant-1.18.0-windows-x64.msi`. Run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).
- **macOS:** `Operant-1.18.0-mac-arm64.dmg` (Apple Silicon) or `Operant-1.18.0-mac-x64.dmg` (Intel). Drag Operant to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Operant.app` once.
- **Linux:** `Operant-1.18.0-linux-x86_64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need `sudo apt install libfuse2t64` first, `libfuse2` on 22.04) or `Operant-1.18.0-linux-amd64.deb` (`sudo apt install ./Operant-1.18.0-linux-amd64.deb`).

## New
- **macOS and Linux versions:** tiles run your own shell (zsh or bash) with the PATH your terminal has, so tools from Homebrew, nvm or `~/.local/bin` are found. Agents, subagent tiles, the `operant` command, git, viewers, notifications and updates all work as on Windows.
- **macOS:** the window keeps its own traffic-light buttons. Cmd+C and Cmd+V copy and paste in terminals, while Ctrl+C and Ctrl+V go to the terminal (so Ctrl+V still pastes images into Claude Code). Quick open, the command palette, find and devtools use Cmd (defaults `Cmd+P`, `Cmd+Shift+P`, `Cmd+F`, `Cmd+Alt+I`). Drop a folder on the Dock icon, or open it with Operant from Finder, to open it in a tile; right-click the Dock icon for a new window. The token pill reads Claude Code's login from the Keychain, so macOS asks once.
- **Updates on every system:** each copy downloads its own system's installer. macOS swaps the new app in place, the AppImage replaces itself, and the .deb installs through a password prompt when you click *Update*.
- **Info bar on every tile:** viewer, image and changes tiles get the bar under the title too: the folder and branch, an image's size, file size and zoom, and the number of changed files. Pieces drop out one at a time when a tile gets narrow (⚙ Settings › Usage › *Tile info bar*).
- **Click to bring forward:** a click or touch anywhere on an Operant window brings it to the front, including from a remote desktop app on a phone.

## Changed
- **Download names say the system:** `Operant-1.18.0-windows-x64.msi`, `-mac-arm64.dmg` and so on. Installed copies find the new names by themselves.
- **Windows only for now:** the Explorer "Open in Operant" entry and the media controls in the top bar. Their settings are hidden on macOS and Linux.

## Fixed
- **Tile titles overlapped their buttons:** on viewer, image, changes and subagent tiles the folder was drawn over the buttons. The title now shortens before the buttons, and the folder moved to the info bar.
- **OpenCode tiles lost prompts that named code:** Operant's CodeGraph context was added in a form OpenCode 1.18 rejects, so a prompt naming a real function or file never reached the agent. It now arrives with the context attached, and the context stays out of the message bubble.

---

# Operant 1.17.5

The task board now shows a one-line summary for each task instead of the worker's whole prompt.

**Install:** download `Operant-1.17.5.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## Changed
- **Task summaries:** each task on the board reads as one short line: the name the agent gave the worker, or the first sentence of its task. Hover a task to see the full text.
- **Task notifications say which task:** "Task 3 done: <summary>" and "Task 3 ended without a result: <summary>".
- **`operant board`** lists the summaries too; `operant board --full` prints the whole text.

---

# Operant 1.17.4

Team mode opens fewer terminals: agents only start Operant tiles when Claude Code and OpenCode work together.

**Install:** download `Operant-1.17.4.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## Changed
- **Subagents before tiles:** when a tier runs the same agent as the one handing out work (Claude Code to a Claude tier, OpenCode to an OpenCode tier), the agent uses its own subagents with that tier's model instead of opening a new Operant terminal. Worker tiles are now only for Claude Code and OpenCode teamwork, one tile per tier with all its tasks.

---

# Operant 1.17.3

Notifications now say what they are about in the title, so you can tell at a glance whether to switch.

**Install:** download `Operant-1.17.3.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## Changed
- **Notification titles carry a short summary:** an agent that has gone quiet now reads "Claude is waiting: <tile title or folder>", and a permission prompt reads "Claude needs approval: <what it wants to run>", instead of just "is waiting for you".

---

# Operant 1.17.2

The info bar under each tile's title no longer overlaps, and shell tiles now have it too.

**Install:** download `Operant-1.17.2.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## Changed
- **Shell tiles have the info bar:** with "Tile info bar" on in ⚙ Settings, shell tiles show their folder and git branch under the title, like agent tiles, instead of the folder in the title badge.

## Fixed
- **Info bar overlapping on narrow tiles:** when a tile is too narrow, the bar now hides pieces one at a time (branch, folder, cache, tokens, context numbers, model) until it fits, and brings them back when the tile widens.

---

# Operant 1.17.1

Auto compact no longer interrupts agents long before their context is full, and it no longer types into a message you're writing.

**Install:** download `Operant-1.17.1.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## Fixed
- **Auto compact started far too early:** Operant treated every Claude model as having a 200K context window. On models with 1M (Opus and Sonnet 4.6 and later, and Fable), it asked agents to compact at about 160K tokens, and again every time they got back there. It now uses each model's real context window, so the threshold in ⚙ Settings › Agents (80% by default) means 80% of 1M on those models. The context badge on agent and subagent tiles shows the right size too.
- **Auto compact typed into your message:** if you had started typing in an agent's tile, Operant's "Before compacting" note and `/compact` could land in the middle of your text. It now waits until you've sent it.

---

# Operant 1.17.0

Operant now asks where you want to work before it opens an agent. New agent terminals follow the tier slider all the way, links open in your own browser, and a few small bugs in Tidy agents and the tour are fixed.

**Install:** download `Operant-1.17.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## New
- **Choose where to work at startup:** Operant opens on a list of your pinned projects and your default folder, plus *Browse for a folder…*. Pick one and the agent opens there, or click *Start empty* to open nothing. Turn it off in ⚙ Settings › Startup › *Ask where to work on startup*. Opening a folder with Explorer's "Open in Operant" still starts the agent there straight away.
- **About Operant:** click the Operant name in the top bar for the version, the tour and the GitHub page.

## Changed
- **New agent terminals use your top tier's agent:** with team mode on, a new agent terminal now starts with the agent and model of the highest tier the slider allows. With the slider on *xsmall* (OpenCode Big Pickle), it opens OpenCode. An agent you pick by name in the launcher stays that agent, on its highest allowed tier.
- **Links open in your browser:** the in-app browser tile is gone for now. Links, and `operant browse` from agents, open in Windows' default browser, or the one you chose in ⚙ Settings › Startup › *Open links in*. The agent commands that drove the browser tile (`shot`, `console`, `text`, `click`, `type` and `url`) are removed.
- **Lead agents close finished workers:** once a worker's task is done and the lead has checked its work, the lead closes the worker's tile.

## Fixed
- **Tidy agents showed *Select all* and *Apply* on its summary page,** and the tour showed *Skip tour* on its last step. They're hidden again.
- **Tidy agents misread some code blocks:** a line such as ```` ```js ```` inside another code block ended it early, and indented code blocks weren't recognised, so text inside them could be tidied. A file starting with a byte-order mark failed its frontmatter check, and a missing `description:` could be read from the wrong line.
- **Undo after *Optimise big files*** also forgets that the file was optimised, so it's offered again.
- **Tidy agents stuck on "Scanning…"** when a scan failed. It now shows the error.
- **First run** asks where to work after you choose your agent, instead of opening it in your home folder.

---

# Operant 1.16.0

This release makes Tidy agents clean up and slim down your Markdown, names the team tiers, and fits the tiers to your default agent. It also adds a first-run tour, and Operant now supports only Claude Code and OpenCode.

**Install:** download `Operant-1.16.0.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## New
- **First-run tour:** a short walkthrough on first launch. You can skip it, and reopen it from the quick menu.
- **Tidy agents checks your Markdown:** it looks at your rules, your own skills and your memory files. The panel opens on a summary of how many files it checked and how big they are, with three buttons:
  - **Tidy everything safe:** Operant fixes whitespace, blank lines and repeated paragraphs itself.
  - **Optimise big files:** one agent shortens large rules and skill files.
  - **Fix index and structure problems:** one agent fixes heading jumps, empty sections, broken links, missing skill descriptions and memory indexes that are too long.

  Everything it changes is backed up and can be undone. **Details** shows the full list to tick by hand.
- **Status bar on subagent tiles:** tiles for Claude subagents now show the same info bar as agent terminals: model, context used, tokens and folder.

## Changed
- **Tidy agents is in the quick menu** (⚙) instead of having its own button in the top bar.
- **Team tier slider:** each tier now shows its model by name, its effort, and what it's used for.
- **New agent terminals follow your top tier:** with team mode on, a new agent terminal starts on the highest tier you allow for that agent.
- **Tiers follow your default agent:** with Claude Code as the default you get your configured tiers. With OpenCode as the default, the tiers come from the models you have:
  - Only free Zen models (such as Big Pickle): one tier.
  - A paid Zen or OpenAI model: one tier for each effort level.
- **OpenCode team work runs in one instance:** team mode sends all of a tier's tasks to OpenCode as a single prompt, so OpenCode uses its own subagents instead of opening one instance per task.
- **Only Claude Code and OpenCode are built in.** Codex and Gemini are removed, and a saved default of either switches to Claude Code. Both remaining agents work with the usual AI providers, and custom agents you add in Settings still work.

---

# Operant 1.15.2

Running the installer by hand while Operant is open no longer breaks the install.

**Install:** download `Operant-1.15.2.msi` and run it. It installs per-user, so there's no admin prompt. 1.1.0 and later update to this by themselves (except 1.15.0, which needs a manual install).

## Fixed
- **"Error writing to file" when installing:** if Operant was still open, or hung, when you ran the `.msi` yourself, the installer stopped halfway and left the install folder empty. The installer now closes Operant first, then installs. It closes it without asking, so finish or save anything running in Operant before you run the installer by hand. Updates installed from inside Operant work as before.

---

# Operant 1.15.1

Fixes 1.15.0 crashing on startup with "Cannot find module './backup'".

**Install:** download `Operant-1.15.1.msi` and run it. It installs per-user, so there's no admin prompt. If you have 1.15.0 installed, it can't update itself because it crashes on launch, so install this one by hand. Other versions from 1.1.0 on update to this by themselves.

## Fixed
- **Startup crash in 1.15.0:** the installer left out the skills backup module, so Operant showed a JavaScript error and closed on launch. It's included now and Operant starts normally, and the release build now checks that every part of the app is in the installer before publishing.

---

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
