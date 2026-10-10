<p align="center"><img src="build/icon.png" width="128" alt="Operant 3"></p>

# Operant 3

Keep your coding terminals for every project in one place: Claude Code and OpenCode side by side, memory kept per project, and backups.

Operant does not run tasks for you. Each project has its own terminals, and you work in them directly.

## Features

- Embedded terminals for Claude Code and OpenCode, one per tile, with capability detection and a per-tile model and context bar
- Claude Mods: an info bar under each Claude tile and a Subagent Panel that follows its sub-agents
- Soul Bank and per-project memory, with controls to edit, export and reset
- Learning from finished sessions with Off, Suggest, Controlled and Advanced modes, bounded budgets and rollback; Run now learns from the focused Claude tile
- Hindsight hosting (local, shared on a network adapter with an API key, or a remote URL) and CodeGraph notes
- Built-in presets, Superpowers detection and MCP status for both CLIs
- Usage popout with budgets and export; provider limits for the Claude plan, OpenCode and z.ai
- Backups and restore, and a settings reset
- Git popout (from the branch chip): status, diffs, stage, commit, history, branches, pull and push
- One-row top bar and a project panel with groups; built-in themes plus light, dark and system, accent and custom themes
- Terminal and Console drawers, IDE launch, a right-click project menu, Windows media controls, clock and status pills
- Settings for everything, applied live; UI scale and resizable panels; optional `.env`
- Background commands run in hidden windows on Windows
- Automatic updates from GitHub releases on Windows, macOS and Linux

The embedded terminals, memory and learning are tested with a fake Claude on `PATH`; the media bar is Windows only.

## Install

Download the installer for your system from [Releases](https://github.com/doolecg/operant2/releases): `.msi` for Windows, `.dmg` for macOS (Apple silicon or Intel), `.AppImage` or `.deb` for Linux. Operant 3 keeps itself up to date after that.

Terminals need their CLI on your `PATH`: [Claude Code](https://code.claude.com) (`claude`) or OpenCode (`opencode`).

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
- `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`: seed a remote Hindsight server while those settings are unset.

## Credits

Operant 3's design was inspired by these open-source projects:

- [OpenRig](https://github.com/mvschwarz/openrig) by mvschwarz: running a team of coding agents as one organised, persistent system, with one skill guiding every agent.
- [Paperclip](https://github.com/paperclipai/paperclip) by paperclipai: managing agents with tasks, budgets and a dashboard.
- [CodeGraph](https://github.com/colbymchenry/codegraph) by colbymchenry: the code knowledge graph Operant 3 embeds for indexing.
- [shadcn/ui](https://github.com/shadcn-ui/ui): the UI components.

## License

[MIT](LICENSE) © doolecg
