# Operant 3.0.2

OpenCode now starts properly as the Master Terminal, finished sessions teach the project's memory on their own, and jobs read much better.

**Install:** download the file for your system from the assets below (same files as 3.0.1, with the new version in the name). Operant 3 keeps itself up to date from these releases.

## New
- **Learning when a session ends.** When an OpenCode Master or one of a seat's Claude terminals finishes, Operant reads what happened and saves the lessons to Hindsight and CodeGraph notes, as it already did for finished jobs and the Claude Master. It follows the learning switch in Settings.
- **Pasted images show in the job.** Images you paste into a new task appear as thumbnails in the job window. Click one to enlarge it.
- **Nicer job pages.** The task, the review summary, your send-back note and the timeline are shown as formatted text, with headings, lists, code blocks and coloured diffs for code changes. The review box has more room.
- **Add to board.** The Master can put a card on the Workspace board with `operant run add <title>`. When you say "add to board", it uses this and no longer the old side-panel Board.

---

## Changed
- **Token limit pause.** A job that passes its team's token limit now says "Token limit reached... Continue, or stop?" with a Continue button, instead of "Master stopped". Cache reads no longer count toward the limit, so short jobs stop running into it.
- **Resume feedback.** The Resume button shows "Resuming..." while it works, and a job paused only for its limit goes straight back to working.
- **OpenCode seats.** The Master's instructions now tell OpenCode to use its Task tool for seats, which carry their preset prompts and the one model you set.
- OpenCode's tabs are switched off when it runs inside Operant. Your own OpenCode settings files are not changed.

---

## Fixed
- **OpenCode Master did not start its job.** The first line was typed before OpenCode had finished loading and was lost. Operant now waits for it to be ready.
- **"Needs you: resume" on a running OpenCode.** A Master that was running fine was marked as not started after a minute. It is now recognised as ready.

---

# Operant 3.0.1

The Workspace is now a task board with a review inbox, the old workspace is the Terminal view, and a job opens in a big, readable window.

**Install:** download the file for your system from the assets below (same files as 3.0.0, with the new version in the name). Operant 3 keeps itself up to date from these releases.

## New
- **Workspace board and inbox.** Your tasks sit in columns: queued, working, needs you, in review and done. An inbox beside it lists what needs you: questions, permission prompts, reviews and failures. The Workspace tab shows a count, you get a toast, and Windows shows a notification when Operant isn't the active window (switch it off in Settings > Top bar > Panels and notifications).
- **Terminal view.** The old workspace is now called Terminal and works like Operant 2.8.2: the Master Terminal is the main tile, subagents open as read-only tiles, and the project's own shells tile beside them. Layout, split, full screen, focus and close all have keys you can rebind. Settings has new Terminal and Tiles sections.
- **Big task window.** Click a task and it opens in a near-full-screen window with room to breathe. The outcome, review summary and question are shown as a readable document: larger type, tables, code blocks, long sections you can fold, and a Copy button.
- **Replies are remembered.** What you typed in the approval note, the send-back reason, a question answer or the New task box stays when you click away and come back, and after a restart.
- **Copy and paste like 2.8.2.** Ctrl+C copies when text is selected (otherwise it interrupts), Ctrl+V pastes, and an image on the clipboard is sent to Claude. Copy-on-select, Ctrl+click on file paths (files in the project open; programs are only shown in their folder, never run) and dropping files to type their paths are options in Settings.
- **Hide the sidebars.** Alt+B hides the project list, Alt+Shift+B hides the Terminal side panel or the Workspace inbox, Alt+Z hides or restores all of them. There are buttons in the top bar and the choice is remembered.
- **Memory for the Master.** `operant memory recall` and `operant memory retain` let the Master and its seats read and write the project's Hindsight memory.
- **Delegation check.** If a task had seats and the Master did the work without using any of them, the review shows a warning.

---

## Changed
- **OpenCode uses one model.** Seats on OpenCode run on the single model you set; there is no per-seat model, and a model you wrote in a project's `.opencode/opencode.json` is never overwritten.
- **Hindsight uses your server.** If Operant's own Hindsight address is empty, it now uses the self-hosted address from your agent plugins' `~/.hindsight/coding-agent.json`. When Hindsight can't be reached, the brief says where it tried.
- The top bar switches to its compact forms at slightly wider windows to fit the new buttons.

---

## Fixed
- Pasted task images are kept out of `git status` and are deleted when you delete the task or the project.
- Changing the main CLI in the New task box clears seats that belong to the other CLI.

---

# Operant 3.0.0

Operant 3 now starts work as runs: pick a project, press Plus, and its Master Terminal acts as your project manager. It runs the task with your seats, asks you questions, and asks you to review the result.

**Install:** download the file for your system.
- **Windows:** `Operant3-3.0.0-windows-x64.msi`. Run it; it installs per user, so there's no admin prompt.
- **macOS:** `Operant3-3.0.0-mac-arm64.dmg` (Apple silicon) or `Operant3-3.0.0-mac-x64.dmg` (Intel). Drag Operant 3 to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine "/Applications/Operant 3.app"` once.
- **Linux:** `Operant3-3.0.0-linux-x64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant3-3.0.0-linux-x64.deb` (`sudo apt install ./Operant3-3.0.0-linux-x64.deb`).

Masters need their command on your `PATH`: `claude` for Claude Code, or `opencode`. Operant 3 keeps itself up to date from these releases after you install.

**Upgrading from Operant 2:** there is nothing to uninstall first. Your data and settings carry over, and nothing is deleted. Updates arrive in the app from these releases. The old crew, squad and operator screens are gone (see Changed). On macOS the in-app update from Operant 2 can't finish (the app bundle has a new name), so download the DMG once by hand; after that, updates work. On Windows the app doesn't reopen by itself after the first update; start it from the Start menu.

## New
- **The Master Terminal is now your project manager.** Each project's Master answers to you. Tasks from the Plus menu or from Discord reach it as one fixed line. It runs them with your seats as its subagents, asks you questions when it needs an answer, and asks you to review the result with Approve and Send back (typing "approve" in its terminal also works). One task is active per project at a time; the rest wait in order, and a sent-back task goes first. The Master phase, questions and review show on the job cards and the job panel.
- **Close-out after you approve.** The cheap AI you picked does it: Claude Haiku, an OpenCode model or a local LM Studio or Ollama model. It writes the lessons, re-indexes CodeGraph and writes the outcome to Hindsight. Each step is tried on its own, and a failed step can be retried from the job.
- **Run in background.** The old headless run is still there as an opt-in switch on the Plus menu.
- **Playground.** A built-in workspace with no project of its own (folder in the app data folder, Ctrl+Shift+P). It has a Master, runs, review, close-out and a Discord channel like any project. It can't be deleted; "Clear history" empties it.
- **Discord is the Master's channel.** A message in a project's channel goes to that project's Master, and each request gets a named thread. Slash commands: `/newsolo`, `/newteam`, `/stop`, `/restart`, `/status`, `/queue`, `/approve`, `/sendback`, `/answer`, `/resume`, `/master`. Questions and reviews come with buttons. Updates are mirrored by code, so they cost no extra tokens (level: off, results or progress). Each bot has an admins list (only admins can stop, restart, send back or use `/master`) and its own AI choice for replies: Claude, OpenCode or a local server. Connection diagnostics explain problems such as the Message Content intent being off.
- **Built-in team presets.** Build and review, Full team, Research, Bug fix, Design to build and Quality pass. Duplicate, edit, reset or hide them; import and export teams. Save a team from the Plus menu.
- **Git tab.** Status, diffs (unified or side by side), stage and unstage, commit, history, branches, and pull and push. Nothing commits or pushes without a click.
- **One-row top bar and project panel.** A compact top bar with the project name, Workspace, Seats and Memory tabs, a branch chip and one status pill. The project panel follows Operant 2.8.2, with groups.
- **Themes.** All the Operant 2.8.2 themes plus Light, Dark and System, an accent colour, and custom themes you can save, copy, export and import. Terminals and charts follow the theme.
- **Main CLI.** Choose Claude Code or OpenCode in Settings > General; the Plus menu, the Master Terminal and the MCP dialog follow it.
- **OpenCode models** are grouped by provider, with free and not-connected hints, a filter and a Refresh button.
- **Learning AI.** Pick Claude, OpenCode or a local server for learning, with a model, effort and a Test button.
- **Dialogs and layout.** Large dialogs that are never cropped, a UI scale, and panels you can resize.
- **Hidden background windows on Windows.** Operant's own background commands, Claude and Hindsight no longer open console windows.
- **Markdown outcomes.** Job outcomes show as formatted Markdown, in the app and in Discord.
- **Workspace dashboard.** Projects on the left (numbered PRJ#, drag to reorder), a Master Terminal per project in the centre, and job cards on the right. Click a card for the job panel: actions, the agents it used, and a read-only view of each agent's log. The view refreshes every two seconds; it is not a live terminal.
- **Runs and teams.** The Plus menu starts a run, solo or with a team: task text, Master CLI, model and effort, and seats with a count and model each. Runs get a JOB# (from 20001) and move through queued, working, needs you, review, done or failed. Team limits (workers, top model, token budget) are checked and a run over them is refused or, for the token budget, held for you.
- **Claude and OpenCode Masters.** Model and effort lists follow the CLI in use.
- **Seats editor.** Seats (skills, Hindsight, CodeGraph, MCP servers, model, effort) and teams are edited in one page with a node view and a list view.
- **Seeded briefs.** Each run starts with a brief from CodeGraph and Hindsight for the task. If either is down, the job still runs and the brief says which part is missing.
- **Write-back and learning.** Each finished run's outcome goes to the project's Hindsight bank, tagged with files and symbols from the git diff, and CodeGraph re-syncs. A learning step reads the run and writes lessons to Hindsight, CodeGraph notes (kept in Operant's own table) and personal memory files. Lessons wait in a review queue by default. Skill drafts are only installed after you approve them.
- **Memory Manager.** One page to search, filter, edit, merge, mark stale, delete or move lessons, plus Hindsight entries, personal memory and skill drafts, with a learning status panel, a Learn now button and a header badge. Hindsight entries are read-only because Hindsight has no edit or delete call.
- **Hindsight hosting.** Local (as before), Shared (bound to a network adapter you pick, with an API key) or Remote (a URL).
- **MCP servers and status.** List, add, edit, enable, disable and remove servers for Claude and OpenCode, with status and masked secrets. Seats choose which servers they get.
- **Usage page.** Tokens and cost by day, project, job, seat, model and CLI, with filters, trends, per-job agent costs and CSV or JSON export. Daily, project and job budgets warn and hold the queue until you resume. Master runs are counted too.
- **Provider limits.** Claude plan windows (five hour and weekly), OpenCode usage per provider, and z.ai usage when a seat's base URL is z.ai or bigmodel.cn. A header badge shows at 80% or more.
- **Import from Operant 2.8.2.** Usage history, projects and role presets, with a preview, a skipped-rows list, and no duplicates if run twice. The old data is only read.
- **Projects.** Named groups (collapse, rename, drag in and out), delete with a clear note of what is and is not removed (files on disk are never touched), a right-click menu, row buttons, and open in your IDE. What used to be called a crew is now called a project.
- **Terminal and Console drawers.** A Terminal drawer opens a shell in the project folder. The Console drawer shows output from Operant's own background commands.
- **Media bar, clock and status pills.** Media controls on Windows (title, artist, art, progress, previous, play or pause, next, shuffle, volume), a clock and date pill, and an agent-counts pill.
- **Settings and scaling.** A settings gear and a close X (Esc also closes). The UI scales with the window, or set a UI scale from 80% to 200%; Ctrl+=, Ctrl+- and Ctrl+0 change it.
- **.env support.** Optional `.env` for the data folder, background mode, a Discord bot token (`DISCORD_BOT_TOKEN`, `DISCORD_TOKEN` or `BOT_TOKEN`) and a Hindsight URL and key. Secrets are moved into the encrypted store and never logged.
- **Tracker upkeep.** Give a project a tracker file and, when a run finishes, Operant adds it to one open "Update tracker" board job for the project manager (never a duplicate). Switch it off per project or for everything, or use "Update tracker now" in the project menu.

---

## Changed
- **Crew mode is gone.** The crew, squad and operator screens, operator terminals and the Cards, List, Graph and Tiles views are removed. Seats and teams replace them. The old data stays in the database, hidden.
- The Cost tab is replaced by the Usage page.
- Operant is now called Operant 3 and uses the original Operant logo and the orange diamond.
- Lessons wait in a review queue by default, even in automatic mode when a lesson mentions a command, a URL, "always" or "never".
- The built-in full team is now called "Full team".
- Every Plus menu and Discord task now goes to the Master. Use "Run in background" to start the old headless run.

---

## Fixed
- **Slow quit.** Quit now closes quickly: every process Operant started is stopped, working runs are marked interrupted, and no shutdown step waits more than three seconds.
- **Runs stuck after a crash.** Runs left working or needing you at startup now end as failed, the queue moves on, and leftover launch files are deleted. Master runs are recovered too: a task that was working when Operant closed waits for you with a Resume button.
- **A hung learning model** no longer blocks learning: model calls time out after two minutes and the queue continues.
- **Discord project channels.** Messages from allowed users now ask for confirmation before starting a job.
- **Discord outcomes** no longer break when a long outcome message has to be split into pieces.
- **Import validation.** Imported presets are checked against known agents and permission modes; risky settings are flagged in the preview and skipped rows say why.

---

## Known limits
Only tested with fakes, not live:
- Discord on a real server (permissions, thread rate limits, slash commands).
- OpenCode as a full Master, and a full job through OpenCode (checked against OpenCode 2.0.24 only for its commands and agent files).
- A real LAN or Tailscale connection from a second machine to a shared or remote Hindsight.
- The Master gate with a live Master from start to finish. Operant types one fixed line when the Master is idle; a Master that ignores it needs a Retry from you.
- The Claude plan limits and z.ai usage endpoints.
- Learning and close-out against a live Hindsight bank, and the media bar with real playing media.

Other limits:
- Windows hides the consoles Operant starts, but not those started by hooks of other tools in your own terminals.
- On macOS the in-app update from Operant 2 can't finish, so download the DMG once by hand. On Windows the app doesn't reopen by itself after the first update.

---

# Operant 2 2.0.0

The first release of Operant 2: run crews of coding agents as a team, with a live dashboard, a shared job board and a tight grip on token use.

**Install:** download the file for your system.
- **Windows:** `Operant2-2.0.0-windows-x64.msi`. Run it; it installs per user, so there's no admin prompt.
- **macOS:** `Operant2-2.0.0-mac-arm64.dmg` (Apple silicon) or `Operant2-2.0.0-mac-x64.dmg` (Intel). Drag Operant 2 to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine "/Applications/Operant 2.app"` once.
- **Linux:** `Operant2-2.0.0-linux-x64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant2-2.0.0-linux-x64.deb` (`sudo apt install ./Operant2-2.0.0-linux-x64.deb`).

Operators need their agent's command on your `PATH`: `claude` for Claude Code, or `codex`. Operant 2 keeps itself up to date from these releases after you install.

## New
- **Crews, squads and operators.** A crew is a team working in one project folder. Squads group its operators, and each operator is a Claude Code, Codex or shell session with a stable address such as `lead@shop`.
- **Four ways to see a crew.** Cards (the default), List, Graph (nodes and the messages and handoffs between operators, draggable, positions saved) and Tiles (your own quick terminals in a tiling layout). The choice is remembered per crew.
- **A job board agents can use.** You, your Master Terminal and operators create jobs; operators claim them atomically, with a lease that frees a job if its terminal dies. Jobs can depend on each other. A project manager operator reviews finished work by default, and only jobs with a long estimate wait for your go-ahead.
- **Operators talk to each other.** Each operator gets an `operant` command to message others, read its inbox, and work the job board. Messages are labelled with who sent them, and only the dashboard counts as you, so an agent can't pass on your consent.
- **Role presets.** Project manager, researcher, designer, implementor, senior implementor, tester and reviewer, each with its own model, effort, tools and a short role text. Edit, duplicate or reset any of them. Change a running operator's model or effort right on its card, with a warning about what it costs.
- **A Master Terminal per crew.** Your own Claude Code session with elevated rights on the job board.
- **Token use kept low.** Context size caps, a model chosen per role, only the tools each role needs, one blocking inbox call instead of polling, and per-operator and daily spend caps that pause an operator without killing it. The Cost tab splits spend by kind, model and operator, shows cache hit ratio and cold restarts, and flags waste.
- **Everything is editable.** Crews, squads, operators, presets, jobs, links, messages and scratch terminals can all be edited and deleted. Deleted operators keep their history and are purged once it's safe.
- **Activity, CodeGraph and settings.** A live activity feed, CodeGraph indexing of a crew's project, and settings for budgets, models, shell, updates and rebindable keyboard shortcuts, all applied as you change them.
- **Automatic updates** from GitHub releases on Windows, macOS and Linux.
