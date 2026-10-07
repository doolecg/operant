<p align="center"><img src="build/icon.png" width="128" alt="Operant 3"></p>

# Operant 3

Run coding agents on your projects from one dashboard.

Each project has a **Master Terminal** (Claude Code or OpenCode). Press Plus to start a **run**, solo or with a **team** of **seats** that the Master uses as its own subagents. Runs get a JOB# and appear as cards beside the terminal. Every run starts with a brief from CodeGraph and Hindsight, and what it learns is written back, with lessons held for your review by default.

## Features

- Workspace dashboard: projects (grouped, reorderable), a Master Terminal per project, job cards and a job panel with each agent's log
- Runs with JOB# and a per-project queue; solo or team; Claude or OpenCode, with model and effort per CLI
- A seats editor (node and list views) for seats and teams
- Seeded briefs from CodeGraph and Hindsight, write-back after each run, and a learning loop: lessons, a Memory Manager, and skill drafts that need your approval
- Hindsight hosting: local, shared on a network adapter with an API key, or a remote URL
- MCP servers and status for both CLIs, chosen per seat
- Usage and cost page with budgets and export; provider limits for the Claude plan, OpenCode and z.ai; import from Operant 2.8.2
- Discord bots with an allowlist, pairing codes, a front desk and a thread per job
- Terminal and Console drawers, IDE launch, a right-click project menu, Windows media controls, clock and agent pills
- Settings for everything, applied live; UI scale and window scaling; optional `.env`
- Automatic updates from GitHub releases on Windows, macOS and Linux

Discord and the OpenCode job path are tested with fakes only; the media bar is Windows only.

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
- `DISCORD_BOT_TOKEN`: moved into the encrypted store for the Discord bot that has no token yet, on first run; you can then delete it from `.env`. Create bots in Settings > Discord; with no bot the value is ignored.
- `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`: seed a remote Hindsight server while those settings are unset.

## Credits

Operant 3's design was inspired by these open-source projects:

- [OpenRig](https://github.com/mvschwarz/openrig) by mvschwarz: running a team of coding agents as one organised, persistent system, with one skill guiding every agent.
- [Paperclip](https://github.com/paperclipai/paperclip) by paperclipai: managing agents with tasks, budgets and a dashboard.
- [CodeGraph](https://github.com/colbymchenry/codegraph) by colbymchenry: the code knowledge graph Operant 3 embeds for indexing.
- [shadcn/ui](https://github.com/shadcn-ui/ui): the UI components.

## License

[MIT](LICENSE) © doolecg
