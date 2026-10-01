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
