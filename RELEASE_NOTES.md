# Operant 3.0.0

Operant 3 now starts work as runs: pick a project, press Plus, and a Master (Claude or OpenCode) does the task alone or with a team of seats, while you watch it on the dashboard.

**Install:** download the file for your system.
- **Windows:** `Operant3-3.0.0-windows-x64.msi`. Run it; it installs per user, so there's no admin prompt.
- **macOS:** `Operant3-3.0.0-mac-arm64.dmg` (Apple silicon) or `Operant3-3.0.0-mac-x64.dmg` (Intel). Drag Operant 3 to Applications. The app isn't code-signed, so macOS blocks the first launch: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine "/Applications/Operant 3.app"` once.
- **Linux:** `Operant3-3.0.0-linux-x64.AppImage` (`chmod +x` it, then run it; Ubuntu 22.04 and later need FUSE 2 first: `sudo apt install libfuse2t64`, or `libfuse2` on 22.04) or `Operant3-3.0.0-linux-x64.deb` (`sudo apt install ./Operant3-3.0.0-linux-x64.deb`).

Masters need their command on your `PATH`: `claude` for Claude Code, or `opencode`. Operant 3 keeps itself up to date from these releases after you install.

**Upgrading from Operant 2:** there is nothing to uninstall first. Your data and settings carry over, and nothing is deleted. Updates arrive in the app from these releases. The old crew, squad and operator screens are gone (see Changed). On macOS the in-app update from Operant 2 can't finish (the app bundle has a new name), so download the DMG once by hand; after that, updates work. On Windows the app doesn't reopen by itself after the first update; start it from the Start menu.

## New
- **Workspace dashboard.** Projects on the left (numbered PRJ#, drag to reorder), a Master Terminal per project in the centre, and job cards on the right. Click a card for the job panel: actions, the agents it used, and a read-only view of each agent's log. The view refreshes every two seconds; it is not a live terminal.
- **Runs and teams.** The Plus menu starts a run, solo or with a team: task text, Master CLI, model and effort, and seats with a count and model each. Runs get a JOB# (from 20001) and move through queued, working, needs you, done or failed. Each project runs one at a time by default (you can raise it); the rest wait in order. Team limits (workers, top model, token budget) are checked and a run over them is refused or, for the token budget, stopped.
- **Claude and OpenCode Masters.** Model and effort lists follow the CLI in use. The OpenCode path was checked against a real OpenCode 2.0.24 but a full job has only been run with fakes.
- **Seats editor.** Seats (skills, Hindsight, CodeGraph, MCP servers, model, effort) and teams are edited in one page with a node view and a list view.
- **Seeded briefs.** Each run starts with a brief from CodeGraph and Hindsight for the task. If either is down, the job still runs and the brief says which part is missing.
- **Write-back and learning.** When a run finishes, its outcome goes to the project's Hindsight bank, tagged with files and symbols from the git diff, and CodeGraph re-syncs. A cheap learning step then reads the run and writes lessons to Hindsight, CodeGraph notes (kept in Operant's own table) and personal memory files. Lessons wait in a review queue by default. Skill drafts are only installed after you approve them. Tested with a fake model and fake Hindsight; not yet run against a live Hindsight bank.
- **Memory Manager.** One page to search, filter, edit, merge, mark stale, delete or move lessons, plus Hindsight entries, personal memory and skill drafts, with a learning status panel, a Learn now button and a header badge. Hindsight entries are read-only because Hindsight has no edit or delete call.
- **Hindsight hosting.** Local (as before), Shared (bound to a network adapter you pick, with an API key) or Remote (a URL). Checked on a loopback address; a connection from a second machine has not been tried.
- **MCP servers and status.** List, add, edit, enable, disable and remove servers for Claude and OpenCode, with status and masked secrets. Seats choose which servers they get. OpenCode remove, disable and failed-status output are unverified.
- **Usage and cost page.** Tokens and cost by day, project, job, seat, model and CLI, with filters, trends, per-job agent costs and CSV or JSON export. Daily, project and job budgets warn and hold the queue until you resume.
- **Provider limits.** Claude plan windows (five hour and weekly), OpenCode usage per provider, and z.ai usage when a seat's base URL is z.ai or bigmodel.cn. A header badge shows at 80% or more. Tested on fake responses; the z.ai endpoints were never called.
- **Import from Operant 2.8.2.** Usage history, projects and role presets, with a preview, a skipped-rows list, and no duplicates if run twice. The old data is only read. Tried on fixtures only.
- **Discord bots.** Several bots, a per-bot allowlist of user IDs, pairing codes you approve in the app, a front-desk agent for the home channel, project channels that go to that project's Master, and a thread per job. Tokens are kept in the encrypted store. Tested with a fake gateway only; not yet run on real Discord.
- **Projects.** Named groups (collapse, rename, drag in and out), delete with a clear note of what is and is not removed (files on disk are never touched), a right-click menu, row buttons, and open in your IDE.
- **Terminal and Console drawers.** A Terminal drawer opens a shell in the project folder. The Console drawer shows output from Operant's own background commands, which now run hidden with no console window.
- **Top bar.** Media controls (Windows only: title, artist, art, progress, previous, play or pause, next, shuffle, volume), a clock and date pill, and an agent-counts pill. Checked with a fake helper; not yet with real playing media.
- **Settings and scaling.** A settings gear and a close X (Esc also closes). The UI scales with the window, or set a UI scale from 80% to 200%; Ctrl+=, Ctrl+- and Ctrl+0 change it.
- **.env support.** Optional `.env` for the data folder, background mode, a Discord bot token and a Hindsight URL and key. Secrets are moved into the encrypted store and never logged.
- **Tracker upkeep.** Give a project a tracker file and, when a run finishes, Operant adds it to one open "Update tracker" board job for the project manager (never a duplicate). Switch it off per project or for everything, or use "Update tracker now" in the project menu.

---

## Changed
- **Crew mode is gone.** The crew, squad and operator screens, operator terminals and the Cards, List, Graph and Tiles views are removed. Seats and teams replace them. The old data stays in the database, hidden.
- The Cost tab is replaced by the Usage page.
- Operant is now called Operant 3 and uses the original Operant logo and the orange diamond.

---

## Fixed
- **Slow quit.** Quit now closes quickly: every process Operant started is stopped, working runs are marked interrupted, and no shutdown step waits more than three seconds.
- **Runs stuck after a crash.** Runs left working or needing you at startup now end as failed, the queue moves on, and leftover launch files are deleted.
- **A hung learning model** no longer blocks learning: model calls time out after two minutes and the queue continues.
- **Discord project channels.** Messages from allowed users now ask for confirmation before starting a job.
- **Import validation.** Imported presets are checked against known agents and permission modes; risky settings are flagged in the preview and skipped rows say why.

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
