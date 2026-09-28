# Operant plan after 1.8.0

Next up: the three tile bugs (1–3), then the two stalls that slow every window (13–14). Features after that.

1.8.0 shipped on 28 Sept 2026 with the file viewer and vim tiles, plan limits, the redesigned top bar, named
workspaces, CodeGraph on startup and tiles reopening after updates. Everything below was found while building it.

## Fixes

- [x] **1. Closing a vim tile loses unsaved edits.** ✕ ends vim with no warning. Ask before closing an editor tile
      with unsaved changes (Save and close / Discard / Cancel).
- [x] **2. Viewer tiles close after 10 idle minutes,** the same rule as terminals, so a doc you're reading in another
      tile disappears. Leave viewers out of the idle close.
- [x] **3. Viewer and editor tiles don't come back after an update;** only terminals do. Save them in the session
      with their file and reopen them.
- [x] **4. Typing a workspace name can trigger Alt shortcuts,** because the window's key handler runs before the
      text box. Skip shortcuts while a text box in the bar has focus.
- [x] **5. Click-the-track can't find Firefox:** Windows reports it under a code, not its name. Map known player
      codes to program names, and fall back to matching the window title.

## Features

- [x] **6. Git in the sidebar:** each project's branch, changed files tinted, and a count of changes.
- [x] **7. Diff tile:** what an agent changed in a project, file by file, before you commit.
- [x] **8. Quick open (`Ctrl+P`):** type part of a filename to open it in the viewer.
- [x] **9. Viewer upgrades:** find in page (`Ctrl+F`), syntax colours for code, and images.
- [x] **10. Plan-limit alerts:** a notification at 80% and 95% of the session limit, and a small ring on the token pill.
- [x] **11. Command palette:** every action and setting searchable from one box.
- [x] **12. Per-project defaults:** which agent, extra arguments or startup command each project opens with.

## Optimising

- [x] **13. Opening a tile stalls every terminal.** The main process blocks while it reads PATH from the registry
      (`reg.exe`, twice) and looks for the editor (`where`). Do it asynchronously and cache it for a minute.
- [x] **14. The sidebar rebuilds its whole tree on every click.** Slow with big folders open, and the reason
      double-click needed a workaround. Update only the rows that changed.
- [x] **15. The music helper polls Windows every 0.8 s** and resends the cover image. Use the media session's change
      events instead, so it's idle when nothing changes.
- [x] **16. The top bar redraws too much.** Every focus or title change redraws the workspace buttons, re-checks the
      sidebar and saves the session. Redraw only what changed.
- [x] **17. Viewers check their file every 1.5 s each.** Watch the file for changes instead.
- [x] **18. Faster terminal drawing:** xterm's WebGL add-on (`@xterm/addon-webgl`) draws busy terminals much faster.
      New dependency, so it needs an OK first.

## Vim

- [x] **19. Vim keys everywhere (Settings › Keybinds › Vim keys):** `j`/`k`, `h`/`l`, `gg`/`G`, `Ctrl+D`/`Ctrl+U` and `/`
      in the sidebar, viewer, diff tile and pickers; `Ctrl+J`/`Ctrl+K` in lists. Config.json can open in the editor tile.
- [x] **20. Resize tiles with the mouse:** drag the gap between two tiles (no Alt needed).

## Git

- [x] **21. Commit like IntelliJ:** in the diff tile, tick the files, write a message and Commit (or Commit and Push,
      or Amend); Pull and Push buttons; roll back a file; switch branch.

## 1.11: the Operant skill, part 2 (after 1.10.0 ships)

- [ ] **22. Browser tile:** a real in-app browser tile (Electron's own web view, no new dependency): URL bar, back,
      forward, reload, DevTools. Agents: `operant browse <url>`, `operant shot <tile>` (a PNG they can look at),
      `operant console <tile> [--errors]`, `operant click`/`type` for simple flows.
- [ ] **23. Plan approval:** `operant plan plan.md` shows the plan in a viewer with Approve / Change and waits for the
      answer (Change returns the user's note).
- [ ] **24. Task board:** a shared board tile for fanned-out agents: `operant task add|claim|done|note`, `operant board`;
      the user sees every task, owner and status in one tile.
- [x] **25. `operant usage`:** the agent's own context size and the plan limits, so it can compact or hand off in time.
- [x] **26. Dev servers:** `operant ports` lists servers started in tiles with their URLs, spotted in their output.
- [x] **27. Watch and alert:** `operant watch <tile> --errors` notifies (and tells the agent on its next call) when a
      long-running tile prints an error.
- [ ] **28. Skill update:** teach all of the above in `skill/operant/SKILL.md`, still short.

## Next (asked for during 1.10.0)

- [x] 22. Browser tile shipped in 1.10.0 (untested: Alt shortcuts while the page has focus, reopening its URL after restart).
- [x] **29. Safe Save and quit:** Save and quit tells agents to save their progress (the Operant skill teaches them to
      write a progress note and finish their current step when Operant says it's closing), waits until every agent is
      at a safe point (idle), then closes; a "Force quit now" button for when you can't wait.
- [x] **31. Ship in 1.10.1 (already in the working tree, uncommitted):** browser detection matches by exe name, so Zen
      (which registers under a `Firefox-<hash>` key) isn't listed as Firefox in Settings › Startup.
- [x] **32. Auto compact:** when an agent tile's context passes a threshold (Settings › Agents, default 80%, off
      switch), Operant waits until the agent is idle, asks it to write its progress note (as in 29), then types
      `/compact` into it. OpenCode tiles use its server instead (`POST /session/<id>/summarize` on the tile's
      `--port`, with the session's provider and model), falling back to typing `/compact`; context size comes from
      its SSE token counts, same as the badge. Test both Claude Code and OpenCode (Zen free model). Agents can ask for it themselves with
      `operant compact`, which queues it for their next idle moment. The skill teaches: check `operant usage`
      (item 25) on long jobs, keep `.operant/progress.md` current, and re-read it after a compact.
- [x] **30. Check after 1.10.0** (browser URL restore, crash reload and the WebGL cap pass; Alt keys inside a browser
      tile need a real keypress to test, CDP key events skip `before-input-event`): crash log (`operant.log`, Settings › Updates › Open log folder) after a day of use;
      Alt+1 while a browser tile has focus; window reload after a renderer crash; the 12-context WebGL cap.
