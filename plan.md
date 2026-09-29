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

- [x] **22. Browser tile:** a real in-app browser tile (Electron's own web view, no new dependency): URL bar, back,
      forward, reload, DevTools. Agents: `operant browse <url>`, `operant shot <tile>` (a PNG they can look at),
      `operant console <tile> [--errors]`, `operant click`/`type` for simple flows.
- [x] **23. Plan approval:** `operant plan plan.md` shows the plan in a viewer with Approve / Change and waits for the
      answer (Change returns the user's note).
- [x] **24. Task board:** a shared board tile for fanned-out agents: `operant task add|claim|done|note`, `operant board`;
      the user sees every task, owner and status in one tile.
- [x] **25. `operant usage`:** the agent's own context size and the plan limits, so it can compact or hand off in time.
- [x] **26. Dev servers:** `operant ports` lists servers started in tiles with their URLs, spotted in their output.
- [x] **27. Watch and alert:** `operant watch <tile> --errors` notifies (and tells the agent on its next call) when a
      long-running tile prints an error.
- [x] **28. Skill update:** teach all of the above in `skill/operant/SKILL.md`, still short.

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

## Next: team workflow (asked for after the 1.10.1 work)

- [x] **33. Team mode (Settings › Agents › Team):** a lead agent (Claude Code by default) hands tasks to cheaper
      workers in their own tiles, so the lead's tokens go on the hard parts.
      - **Tiers**, each an agent + model + a one-line "use for": `small` = OpenCode with `opencode/big-pickle` (free
        Zen: look things up, read and summarise files, renames, run tests, simple edits, docs tweaks); `medium` =
        user's pick (e.g. OpenCode with another model, or Claude Code `--model sonnet`); hard work stays with the lead.
        Editable in Settings, and any configured agent/model can fill a tier.
      - **CLI:** `operant agent "<task>" --tier small` (or `--model <id>` directly) opens a worker tile with that
        agent and model (OpenCode `-m`, Claude Code `--model`). `operant team` prints the tiers and how many workers
        are running, so the lead knows what it can use.
      - **Hand-off and results:** each worker task goes on the task board (item 24) with its tile as owner; the
        worker ends with `operant task done <id> --note "<what changed, files>"`; the lead gets the note from
        `operant wait <tile>` / `operant board` and reviews the diff before accepting (free models make mistakes).
      - **Guardrails:** max workers at once (default 4, the runaway guard still applies); workers can't start their
        own workers; one file per worker at a time (the board shows who has what); a worker that fails twice is
        stopped and its task goes back to the lead.
      - **Skill:** a short "Team" section, only acted on when `operant team` says team mode is on: what goes to
        `small`, what to keep, write self-contained task prompts, review before merging.
      - **UI:** a tier badge in each worker tile's title; the token pill splits free and paid tokens.
      - **Test:** a Claude Code lead in a background instance sends two small tasks to Big Pickle tiles and one
        to itself; both workers finish, notes come back through the board, the lead reviews and merges.

## Token efficiency (make Operant the cheapest way to run agents)

Already in: `run`/`wait --errors|--new|--grep`, repeated-line folding, `text` over `shot`, auto compact (32),
team mode (33). In order of how much each should save:

- [x] **34. Test and build digests:** `operant test` / `operant build` (or `run --digest`) spot the runner (npm/vitest/
      jest, pytest, cargo, go test, tsc, eslint, gradle/maven, dotnet) and return only the summary line plus each
      failure with its file:line and the first project frame of the stack; everything else stays in the tile.
      Unknown runners fall back to `--errors`.
- [x] **35. Cheap readers on free models:** `operant summarize <file|tile|url> ["question"]` and
      `operant find "<question>"` hand the big read to a small-tier worker (Big Pickle by default, from 33) and
      return a short answer with file:line references, so the lead never loads the big file, log or page itself.
- [x] **36. Don't let the prompt cache go cold:** Claude's cache lasts minutes; an agent left idle past it pays
      full price to re-read its whole context on the next message. Show a "cache cold" mark on idle tiles, and an
      option to compact big idle contexts before the cache expires (or when you leave the tile for a set time).
- [x] **37. Big commands never flood the context:** an optional Claude Code hook (installed with the skill, off
      by default, Settings › Agents) that moves long-running commands (test, build, install, dev servers) from the
      agent's own shell into `operant run` + `wait --errors` automatically, so savings don't depend on the agent
      remembering the skill. OpenCode: the same through its plugin/config if it allows it.
- [x] **38. Smaller skill:** keep SKILL.md to the essentials (~40 lines) and move the full command reference to
      `operant help [cmd]`, which agents call only when they need it.
- [ ] **39. Where the tokens go:** per-tile and per-task token counts (input, output, cache hits, free vs paid),
      the biggest single reads, repeated reads of the same file, and each session's fixed overhead (CLAUDE.md,
      memory, skills, MCP tool lists), with a hint when something is oversized (e.g. an MCP server that's loaded but
      never used).
- [x] **40. Cheaper screenshots:** `operant shot` defaults to a downscaled JPEG, with `--selector`/`--region`
      to capture only part of the page and `--full` for the old behaviour.
- [x] **41. Skill nudges for the big wins:** use CodeGraph (when `.codegraph/` exists) before grep/read, read only
      the lines needed, prefer `--new` on re-reads, and hand small tasks to the small tier.
- [x] **42. Tokens per tile since it opened:** every agent tile's title bar shows the tokens it has used since the
      tile opened (input + output, cache reads counted separately, from the same Claude session files and
      OpenCode events the context badge and token pill use), next to the context badge; hover for the breakdown
      and cost-free/paid split. Resumed agents count from when the tile opened, not the whole session. Also in
      `operant tiles` and `operant status`.
- [x] **43. Every agent gets the rules from its first message, master included:** today the skill only loads when
      the agent decides to use it, so the master terminal can start working without it. Operant passes a short
      brief at launch to every agent tile (master, `operant agent` workers, reopened/resumed agents): Claude Code via
      `--append-system-prompt`, OpenCode via an `instructions` file in its per-process config (like the theme's
      `OPENCODE_TUI_CONFIG`, never the user's own config). The brief (a few lines, so it stays cheap and cached):
      you're in Operant, use the `operant` skill; before anything else, if `.codegraph/` exists use CodeGraph
      before grep/reading files; if `.operant/progress.md` exists read it first; long commands through
      `operant run`/`wait --errors`. Setting: Settings › Agents › "Brief agents at launch" (on). Test on a master
      tile for both Claude Code and OpenCode: the first action on a repo with `.codegraph/` is a CodeGraph query.
- [x] **44. Agents waiting on a permission prompt ask you:** an agent stuck on "Do you want to proceed?" (Claude
      Code) or a permission request (OpenCode's `permission.asked` SSE event) just sits there, often in a tile
      you're not looking at. Operant spots it (Claude: the prompt in the tile's output; OpenCode: the event), marks
      the tile ("waiting for you" in its title and the status pill), sends a notification to the bell and Windows,
      and clicking it focuses the tile. If the same kind of command keeps asking, the notification offers "Always
      allow…", which shows the exact permission rule to add and opens the right settings file (Claude
      `.claude/settings.local.json`, OpenCode `opencode.json` `permission`) in the editor tile, for the user to
      save; Operant never writes permission rules itself.
- [x] **45. Shared memory across agents:** Operant keeps one memory per project that every agent reads and adds
      to, so what one agent learns (a user preference, a gotcha, a decision) reaches the next one, whichever CLI it
      is. `operant remember "<fact>" [--type user|feedback|project|reference]` saves one fact as a small file with
      a one-line index entry; `operant recall ["query"]` returns the index or the matching facts. Stored in the
      project's `.operant/memory/` (index `MEMORY.md`), with user-wide facts in Operant's userData. The launch
      brief tells agents to read the index at start and to save durable facts they learn; the main agent's own
      memory (Claude: `~/.claude/projects/<project>/memory/`) is included read-only so other agents see it too.
      A Memory page in Settings lists, edits and deletes facts.

## 1.19: token-saving Operant skill, both CLIs' tiers, Claude↔OpenCode messaging (asked 29 Sept)

Clean restart; code comes from the local `salvage/skill-redesign` branch where it fits, reviewed first. One item per
commit, each tested and checked before the next. Full plan with research: ~/.claude/plans/federated-painting-summit.md.

- [x] **46. Correctness fixes:** the skill's frontmatter is valid YAML (Claude only ever saw "Operant control"),
      the long-command reroute never auto-approves and is on by default, `operant test/build` wait past 20 s.
- [x] **47. CLI reliability:** no 5-minute limit on plan/ask/wait (node:http, not fetch), `--cwd` defaults to the
      shell's folder, `--options` takes commas (PowerShell), `run` names the next step, aliases and closest-match
      errors, `operant help <topic>`.
- [x] **48. Skill per session:** an `agent-plugin/` loaded with `--plugin-dir` (Claude) and `skills.paths`
      (OpenCode); nothing written to the user's home, old copies removed.
- [x] **49. Live context:** `operant prime` injected at session start and after every compact (SessionStart hook,
      OpenCode plugin), a short brief for subagents, a ~600-byte launch brief.
- [x] **50. Skill body and worker discipline:** a lean skill; workers hand back `task done --status
      done|blocked|failed --note` (files, one line each; open issues; ≤100 words).
- [x] **51. Tiers across Claude and OpenCode by availability:** Haiku/Sonnet/Opus plus OpenCode's free and paid
      tiers, fallback when a CLI or model is missing, OpenCode tier subagents, a tier suggested when none is given.
- [x] **52. Review, escalation, budgets:** results wait for approval; one retry then one tier up; per-tier token
      budgets stop and escalate a worker.
- [x] **53. Messaging (opt-in):** `operant msg <tile> "<text>"` between any agents, Claude and OpenCode included.
- [x] **54. Token and cost tracking:** OpenCode history from opencode.db, usage by model/tier/task/project, prices
      with source (unknown stays unknown), cache hit rate.
- [x] **55. Evals, docs, release notes:** before/after on Sonnet, 13 cases x 3: pass 74% -> 95%, worker reports
      0% -> 100%, plan approval 0% -> 100%, raw long commands 0.2 -> 0 per run, cost flat; notify-when-done 33%.


## 2.0: the core — memory that knows when it's stale, routing from real outcomes (planned 29 Sept, after 1.19)

Branch `dev-2.0.0`. One item per commit, tests with each, a live check where it touches tiles. Sonnet builds from
a spec; Haiku runs checks and docs; Opus (medium) only where marked. Research and open-source decisions: see
~/.claude/plans/federated-painting-summit.md (memor-ai, agentmemory, opencode-x: borrow ideas, no dependencies).

- [x] **56. 1.19 leftovers:** agents reach for `operant notify` when asked to say when long work is done (eval
      notify-when-done 33% → pass; fix in the skill/brief wording, confirmed with that eval case only); a rejected
      worker isn't flagged as a runaway for re-running `operant board` (the reject message says exactly what to do
      next, and read-only `operant` status calls don't count toward the loop guard); `evals/results/` ignored.
- [x] **57. Task outcomes:** every board task records its outcome in `outcomes.jsonl` (userData): task type (a small
      deterministic classifier: fix, feature, lookup, test, refactor, docs), tier, agent/model, tokens and $ (from
      item 54), attempts, retries, escalations, final status, duration, files changed. Kept 90 days. This is the
      data routing and the benchmark read; nothing else changes yet.
- [x] **58. Memory that knows when it's stale:** Markdown stays the source of truth; frontmatter gains `confidence`
      (verified / observed / inferred / stale), created/updated/last-used, recalls/uses/rejects, `supersedes`, and
      `about_sig` (a file hash, or the CodeGraph signature of the symbol). A fact whose code drifted is marked stale
      at recall, never deleted. Recall ranks by BM25 (pure JS) × usefulness `(uses−rejects+1)/(recalls+2)` × decay
      (14-day half-life), logs which ids it injected, and `operant memory used|wrong <id>` feeds usefulness.
      `operant remember --supersedes <id>` chains facts. Existing memories keep working unchanged.
- [x] **59. Routing from outcomes:** `operant agent` without a tier picks the cheapest tier whose success rate for
      that task type is ≥ 80% over at least 5 recent tasks; with fewer, it says `insufficient data` and uses today's
      keyword suggestion. Every choice is explained in one line ("small: 7/8 fixes passed, $0.03 avg"). One task in
      ten tries the tier below a proven one so a tier can earn its way back. Never above the top tier allowed.
      (Opus medium to review the policy before it ships.)
- [x] **60. Outcome signals and doom-loop guard:** a worker is escalated a tier on evidence, not only on reject:
      the same error twice, the same command failing twice with the same output, or no file change after N turns on
      a code task. Clean passes at a tier count toward trying the cheaper one (item 59). The guard explains itself.
- [x] **61. Verification by risk:** before a code task reaches review, Operant runs the project's test/build
      (detected as `operant test` does) and attaches the result and diff size to the review card; docs/lookup tasks
      skip it. A failing check goes back to the worker once, like a reject.
- [x] **62. Benchmark suite:** the eval harness grows cases for team work (hand-off, escalation, review) and can
      run the same cases on two providers (Claude tier vs OpenCode tier) and without Operant as a baseline; one
      summary table per run. (OpenCode arm gated behind OPERANT_EVAL_OPENCODE_UNSAFE=1: `opencode run` edited the
      repo's own fixture instead of the temp copy; fix before using it.)
- [ ] ~~**63.**~~ Skipped for 2.0 (user, 29 Sept), later: **Provider seams, only where two implementations exist:** model launching (Claude Code, OpenCode) and
      code context (CodeGraph, grep fallback) behind small interfaces, so a third can be added without touching the
      renderer. (A refactor: ask the user before starting; Opus medium.)
- [ ] ~~**64.**~~ Skipped for 2.0 (user, 29 Sept), later: **Optional local helper model (ask first, downloads ~3 GB):** llama.cpp `llama-server` + a small open
      model registered as an OpenCode provider for an offline xsmall tier; or a user-supplied Ollama/LM Studio URL.
      Nothing downloads without an explicit yes in Settings.
- [x] **65. 2.0 docs, evals before/after, release.** Evals (Sonnet, 17 cases x 3): 1.19.0 88% vs 2.0 88%, cost
      $0.090 vs $0.097/run; notify-when-done 0/3 -> 3/3; review-approve 3/3 -> 3/6 and plan-approval 3/3 -> 5/6 over
      two runs, all failures after a denied raw verification command (eval don't-ask mode); handoff 0/3 in both (the
      lead does everything itself). Follow-ups: handoff and review-approve.

## 2.0.1 follow-ups (shipping in 2.1, 29 Sept)
- [x] **66.** `operant remember` outside a project (home folder, drive root) saves to personal memory, not
      `<home>/.operant/memory`; leads hand independent parts to a cheap tier (eval `handoff` 0/3) and always decide
      a review (eval `review-approve` 3/6); the OpenCode eval mode stays inside its temp workspace. Evals after:
      handoff 2/3, review-approve 3/3, negatives 6/6, dev-server and slow-suite 3/3.

## 2.1: operations — updates you can undo, backups you can restore, settings that carry over (planned 29 Sept)
Branch `dev-2.1.0`. Same rules as 2.0: one item per commit, tests with each, Sonnet builds from a spec, a live
check in an isolated profile before release.

- [ ] **67. Atomic state writes:** config.json, the board, outcomes, usage tags and memory stats are written to a
      temp file and renamed, so a crash or power cut mid-write never leaves a half file; a file that doesn't parse
      is kept as `.broken` (as config already is) and the last good backup is offered.
- [ ] **68. Operant's own backups:** a snapshot of Operant's state (config, personal memory, board, usage tags,
      outcomes, memory stats) into userData/backups/<time>/ with a manifest of sha256 per file, read back and
      checked after writing. Daily and before every update; keeps the last 10 plus one a day for a week. Settings ›
      Backups lists them with *Back up now* and *Restore*; a restore takes a safety backup first.
- [ ] **69. Updates you can undo:** before installing, a backup (item 68); the download is checked against the
      release asset's size and its sha256 digest from GitHub when the API gives one (recorded either way); an update
      history (from, to, when, result) in userData shown in the About/update panel. The new version marks itself
      healthy once its window has loaded; if it fails to get there twice, Operant offers to reinstall the previous
      release and restore the pre-update backup (never automatically).
- [ ] **70. Config versions and migrations:** `configVersion` in config.json and an ordered list of migrations run
      at load (after a backup), each tested from a fresh install, an old config and an interrupted migration; an
      unknown future version is left untouched and read as far as possible.
- [ ] **71. Every setting works:** a test walks every Settings control and every DEFAULT_CONFIG key: each one saves,
      loads back, and is read somewhere outside settings/defaults (a dead setting fails the test); fix what it finds.
- [ ] **72. 2.1 docs, release.**
