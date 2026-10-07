<p align="center"><img src="build/icon.png" width="128" alt="Operant 3"></p>

# Operant 3

Run coding agents on your projects from one dashboard.

Each project has a **Master Terminal** (Claude Code or OpenCode) that acts as your project manager. Press Plus (or write in Discord) to send it a task. It runs the task solo or with a **team** of **seats** as its own subagents, asks you questions, and asks you to review the result (Approve or Send back). After you approve, the cheap AI you picked does the close-out: lessons, a CodeGraph re-index and a Hindsight write-back. Runs get a JOB# and appear as cards beside the terminal. Every run starts with a brief from CodeGraph and Hindsight, and lessons are held for your review by default.

## Features

- Master Terminal as project manager: tasks arrive as one fixed line, the Master asks questions and review, close-out after approval; "Run in background" is an opt-in
- Workspace dashboard: projects (grouped, reorderable), a Master Terminal per project, job cards and a job panel with each agent's log; a built-in Playground with no project
- Runs with JOB# and a per-project queue; solo or team; Claude Code or OpenCode as the main CLI, with model and effort per CLI; OpenCode models grouped by provider
- A seats editor (node and list views) and built-in team presets (Build and review, Full team, Research, Bug fix, Design to build, Quality pass) you can duplicate, reset, hide, import and export
- Seeded briefs from CodeGraph and Hindsight, write-back after each run, and a learning loop with a Learning AI of your choice (Claude, OpenCode or a local server): lessons, a Memory Manager, and skill drafts that need your approval
- Hindsight hosting: local, shared on a network adapter with an API key, or a remote URL
- MCP servers and status for both CLIs, chosen per seat
- Usage page with budgets and export; provider limits for the Claude plan, OpenCode and z.ai; import from Operant 2.8.2
- Discord as the Master's channel: a named thread per request, slash commands (`/newsolo`, `/newteam`, `/stop`, `/restart`, `/status`, `/queue`, `/approve`, `/sendback`, `/answer`, `/resume`, `/master`), buttons for questions and review, mirroring with no extra tokens, an admins list, a per-bot AI choice and connection diagnostics
- Git tab: status, diffs, stage, commit, history, branches, pull and push
- One-row top bar and a 2.8.2-style project panel with groups; 2.8.2 themes plus light, dark and system, accent and custom themes
- Terminal and Console drawers, IDE launch, a right-click project menu, Windows media controls, clock and status pills
- Settings for everything, applied live; UI scale and resizable panels; optional `.env`; tracker upkeep job
- Background commands run in hidden windows on Windows
- Automatic updates from GitHub releases on Windows, macOS and Linux

Discord, OpenCode as a full Master, the Master gate with a live Master and the live provider-limit endpoints are tested with fakes only; the media bar is Windows only.

## Install

Download the installer for your system from [Releases](https://github.com/doolecg/operant2/releases): `.msi` for Windows, `.dmg` for macOS (Apple silicon or Intel), `.AppImage` or `.deb` for Linux. Operant 3 keeps itself up to date after that.

Masters need their CLI on your `PATH`: [Claude Code](https://code.claude.com) (`claude`) or OpenCode (`opencode`).

## Development

Requires Node.js 24.

```bash
npm install
npm run dev          # run the app with the Vite dev server
npm test             # unit tests
npm run test:e2e     # build first; drives the app with a fake claude on PATH
npm run dist         # build installers for this system into dist/
```

## Configuration (.env)

Optional. Copy `.env.example` to `.env` (the repo root when running from source, the app data folder when installed) and fill in what you need. Variables already set in your environment win, values are never logged, and `.env` is gitignored.

- `OPERANT_DATA_DIR`, `OPERANT_BACKGROUND`: data folder and background-window mode.
- `DISCORD_BOT_TOKEN` (or `DISCORD_TOKEN`, `BOT_TOKEN`; the first non-empty wins): moved into the encrypted store for the one Discord bot that has no token yet, and that bot is enabled to connect; you can then delete it from `.env`. Create bots in Settings > Discord without a token; `.env` is checked at start and again when you add such a bot.
- `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`: seed a remote Hindsight server while those settings are unset.

## Credits

Operant 3's design was inspired by these open-source projects:

- [OpenRig](https://github.com/mvschwarz/openrig) by mvschwarz: running a team of coding agents as one organised, persistent system, with one skill guiding every agent.
- [Paperclip](https://github.com/paperclipai/paperclip) by paperclipai: managing agents with tasks, budgets and a dashboard.
- [CodeGraph](https://github.com/colbymchenry/codegraph) by colbymchenry: the code knowledge graph Operant 3 embeds for indexing.
- [shadcn/ui](https://github.com/shadcn-ui/ui): the UI components.

## License

[MIT](LICENSE) © doolecg
