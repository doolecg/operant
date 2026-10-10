<p align="center"><img src="build/icon.png" width="128" alt="Operant 3"></p>

# Operant 3

A home for your coding terminals. Claude Code and OpenCode side by side, with memory and skills kept per project.

## Features

- **Terminals as tiles.** Claude Code and OpenCode per project, in a Chat or Terminal view, with model and context on each tile.
- **Claude Mods.** An Agents panel for sub-agents, a Commands menu, and an activity box for learning and memory.
- **Memory that sticks.** Lessons from finished sessions go to the project's Hindsight bank. Useful procedures become skills you approve once, for every session.
- **Usage at a glance.** Plan rings for the 5-hour and weekly limits, budgets and export.
- **Git, backups, presets and themes**, with settings applied live.

## Install

Download the installer for your system from [Releases](https://github.com/doolecg/operant2/releases): `.msi` for Windows, `.dmg` for macOS (Apple silicon or Intel), `.AppImage` or `.deb` for Linux. Operant then updates itself.

You need [Claude Code](https://code.claude.com) (`claude`) or OpenCode (`opencode`) on your `PATH`.

## Development

Needs Node.js 24.

```bash
npm install
npm run dev        # app with the Vite dev server
npm test           # unit tests
npm run dist       # installers for this system into dist/
```

Optional settings go in a `.env` (copy `.env.example`).

## Credits

Inspired by [OpenRig](https://github.com/mvschwarz/openrig) and [Paperclip](https://github.com/paperclipai/paperclip). Built with [CodeGraph](https://github.com/colbymchenry/codegraph) and [shadcn/ui](https://github.com/shadcn-ui/ui).
