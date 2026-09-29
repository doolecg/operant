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

- [x] **67. Atomic state writes:** config.json, the board, outcomes, usage tags and memory stats are written to a
      temp file and renamed, so a crash or power cut mid-write never leaves a half file; a file that doesn't parse
      is kept as `.broken` (as config already is) and the last good backup is offered.
- [x] **68. Operant's own backups:** a snapshot of Operant's state (config, personal memory, board, usage tags,
      outcomes, memory stats) into userData/backups/<time>/ with a manifest of sha256 per file, read back and
      checked after writing. Daily and before every update; keeps the last 10 plus one a day for a week. Settings ›
      Backups lists them with *Back up now* and *Restore*; a restore takes a safety backup first.
- [x] **69. Updates you can undo:** before installing, a backup (item 68); the download is checked against the
      release asset's size and its sha256 digest from GitHub when the API gives one (recorded either way); an update
      history (from, to, when, result) in userData shown in the About/update panel. The new version marks itself
      healthy once its window has loaded; if it fails to get there twice, Operant offers to reinstall the previous
      release and restore the pre-update backup (never automatically).
- [x] **70. Config versions and migrations:** `configVersion` in config.json and an ordered list of migrations run
      at load (after a backup), each tested from a fresh install, an old config and an interrupted migration; an
      unknown future version is left untouched and read as far as possible.
- [x] **71. Every setting works:** a test walks every Settings control and every DEFAULT_CONFIG key: each one saves,
      loads back, and is read somewhere outside settings/defaults (a dead setting fails the test); fix what it finds.
- [ ] **72. 2.1 docs, release.**

## Operant 2.0 master spec: everything, and where it stands (mapped 29 Sept)
Two versions: `docs/operant-2.0-spec.md` (first, with UI/operations 84A-84S) and `docs/operant-2.0-master-prompt.md`
(revised). The first spec is `docs/operant-2.0-spec.md` (pasted 28 Sept; 2.0.0 was built from a short outline of it, so most
of it is still to do). Status: [x] done, [~] partly, [ ] not started. Numbers are the spec's sections.

**Model orchestration**
- [~] 12-15 Dynamic routing, escalation, downgrade: tiers by task type from outcomes, escalation on reject/budget/
      stuck, 1-in-10 cheaper try. Missing: routing on complexity, context size, remaining budget, latency, risk.
- [~] 16 Claude <-> OpenCode collaboration: `operant msg` shipped. Missing: measuring whether collaborating helped.
- [ ] 17 Local model as a utility (classify, summarise, compress, filter): parked (item 64).
- [~] 39 Task classification: type only. Missing: complexity, risk, repo size, language, verification need.
- [~] 43 Parallel agents: allowed by team mode. Missing: measuring speedup, extra tokens, duplicate work.
- [~] 42/44 Orchestration and token budgets: per-tier token budget only. Missing: max model calls, retries,
      provider calls, elapsed time; per-phase budget split (plan/context/implement/verify).
- [~] 91/92 Stop conditions, user intervention: `operant plan`/`ask`, budgets, stuck guard. Missing: stop on
      "negative expected value", a budget-likely-exceeded warning.

**Context and compression**
- [ ] 20 Context engine: intent -> which files, symbols, history, memories, tool output matter -> ranked, budgeted.
- [ ] 21-24 Context provider selection (CodeGraph vs grep vs memory vs git), provider benchmarks, provider
      usefulness rates feeding routing ("should I call CodeGraph / memory / verify?").
- [ ] 31/32 Tool-output compression (keep errors, paths, stack traces, exit codes) with a compression-worth check.
      Today: `operant wait --errors` and digests only.
- [ ] 30 Memory compression (benchmark Memor-AI / agentmemory first).
- [ ] 58/59 Code-intelligence interface (CodeGraph, Tessera, code-context-graph, grep fallback).
- [ ] 60 Project knowledge (languages, build/test system, commands, known failures) feeding routing.
- [~] 61/62 Git awareness, change-aware context: memory links files by hash. Missing: commits/branches, recent
      changes ranked higher.

**Memory**
- [x] 25-29 Structured memory, confidence, dates, usefulness (used/wrong), staleness from file hashes, supersedes.
- [~] 26/28 Missing: contradiction flag, related commits/symbols, "ignored / caused a correction" signals,
      automatic memory capture.

**Analytics, learning, honesty**
- [ ] 33 Local analytics database (SQLite): sessions, tasks, models, providers, tool calls, tokens, cost, latency,
      failures, retries, escalations, compressions, memory/context retrieval, verification, cache.
- [~] 34 Analytics questions: tokens/cost by model/tier/task/project. Missing: which model wastes tokens, which
      provider fails, retry hot spots, justified escalations, unused integrations, orchestration overhead.
- [ ] 18/19/45 Token economy: tool-output, retrieval, routing, verification, retry, escalation tokens; gross vs
      NET savings; the cost of Operant itself.
- [x] 36/85 Exploration and INSUFFICIENT DATA.  [x] 78 unknown prices stay unknown.  [~] 77 exact / estimated /
      provider-reported marks on every figure.
- [~] 79/80 Learning data, explainable routing: one-line reason. Missing: a stored structured reason per decision.
- [ ] 37/38 Provider and model health: availability, latency, error/timeout/rate-limit rates, auth status;
      per-task-type model success, retry and escalation rates.
- [ ] 84 Local dashboard: overview, models, providers, tokens, cost, latency, failures, memory, compression,
      context, benchmarks, routing, integrations; net tokens saved, cost avoided, success/retry/escalation rates.
- [ ] 84M System health strip: version, update, backup, database, provider/model/local-model health, memory,
      CodeGraph, MCP, analytics status.

**Providers and ecosystem**
- [ ] 10 Component registry (installed/available/healthy/capabilities/last checked), informational, no installs.
- [ ] 11/12/55/56 Provider interfaces, model profiles by capability, provider discovery, capability routing:
      parked (item 63).
- [~] 54 Graceful degradation: tier fallbacks when a CLI/model is missing. Missing: CodeGraph -> grep, memory
      down -> continue, provider outage -> fallback model.
- [ ] 57 MCP as a provider boundary (discover tools, rate them on cost/latency/relevance/health).
- [~] 48/49 Open-source evaluation records: done once in research (memor-ai, agentmemory, AgentMeter, opencode-x,
      Tessera, code-context-graph). Missing: a kept, updatable record and security checks per component.
- [~] 50/53 User control and config: team, tiers, budgets, messaging, verification settings. Missing: max cost,
      max parallel agents, auto-escalation/downgrade toggles, compression/analytics toggles, provider switches.
- [x] 51/52 Offline-first, privacy: all local, nothing uploaded.

**Verification and reliability**
- [~] 40 Verification: tests/build before review, diff size. Missing: type check, lint, second-model review, by risk.
- [~] 41 Failure detection: same command/error, no edits, tool loops. Missing: unchanged patches, contradictory
      instructions, context overflow, provider failures.
- [~] 46/47 Baseline and A/B: eval baseline (no Operant), two-arm compare. Missing: a replayable task set per
      category, routing-strategy comparisons, results stored in the app.
- [~] 75/76 Tests: unit tests throughout. Missing: failure tests (timeout, bad credentials, rate limit, malformed
      response, corrupt memory, database failure, MCP failure, network failure).

**UI and operations (84A-84S)**
- [x] 84A/84R Keep the existing UI.  [~] 84B/84C Every control works (item 71 running).
- [~] 84E/84F Updates: auto-check, Check button, notes (shipped); backup before update, digest check, history,
      health check and rollback offer (item 69 running). Missing: update channel (stable/beta), check-frequency
      setting, disk-space check.
- [~] 84G-84J Backups: daily, validated, restore with a safety backup (item 68). Missing: backup location,
      frequency and count settings, backup before migration, periodic restore validation, last-backup status.
- [x] 84K Config migrations (item 70).  [ ] Schema migrations for future databases (with 2.2).
- [~] 84L Fresh vs existing install: config merge preserves data. Missing: explicit first-run detection.
- [~] 84N Actionable errors. Missing: a pass over error messages (what happened, is data safe, next step).
- [~] 84O/84P Settings and update/backup test matrices: round trip + used (item 71). Missing: invalid, boundary and
      reset tests; failed-download, corrupt-backup and failed-restore tests.
- [ ] 84C Reset-to-default per setting.
- [ ] 93 Docs: architecture, providers, routing, memory, analytics, configuration, security, privacy,
      troubleshooting.

**Order (first spec; superseded by the revised order below)**
- 2.1 (in progress) also takes the ops gaps: update channel and check frequency, disk-space check, backup
  location/frequency/count, backup before migration, restore validation, reset-to-default, failure tests.
- 2.2 Measure everything: SQLite analytics (33), token economy with net savings and orchestration cost (18/19/45),
  provider and model health (37/38), stored routing reasons (79), the dashboard (84), the system-health strip (84M).
- 2.3 Context and compression: context engine (20-24), tool-output compression with a worth check (31/32), project
  knowledge (60), change-aware git context (61/62), budgets per phase (42/44).
- 2.4 Providers: interfaces and capability routing (11/12/55/56, item 63), component registry (10), MCP (57),
  graceful degradation (54), Tessera / code-context-graph benchmarks (58), the settings for them (50/53).
- 2.5 Smarter decisions: classification by complexity/risk (39), verification by risk incl. type check, lint and a
  second model (40), collaboration and parallel measurement (16/43), replay benchmarks (47), stop conditions (91),
  optional local model (17, item 64, ask first), docs (93).

**Added by the revised master prompt (`docs/operant-2.0-master-prompt.md`, uploaded 29 Sept; its section numbers)**
- [ ] 8 Routing by expected utility: P(success) x value minus model, context, orchestration, verification,
      expected-retry and latency costs (today: pass-rate threshold only).
- [~] 9 Learning from history with EMAs / time decay / rolling windows / confidence intervals, per task type and
      per project: today a 30-day window, last 20 per type x tier, no decay, no per-project split, no interval.
      Also record verification result, human intervention, context size, compression/memory/context provider used.
- [~] 10 Bounded exploration: 1-in-10 cheaper try. Missing: bounded by budget, user setting and task risk (never
      explore on high-risk work).
- [~] 11 Collaboration with explicit roles: planner -> implementer, implementer -> reviewer, dual reasoning with a
      compare step, a local mediator. Today: free-form `operant msg` only.
- [ ] 20 Context overflow recovery: detect pressure early, drop low-value context, compress, split the task,
      checkpoint, switch to a larger-context model (today: auto compact at a threshold).
- [~] 21 Doom loops: missing reverting-and-reapplying the same change, endless test/fix cycles, repeated retrieval
      with nothing new, and "classify the failure, change strategy" before escalating.
- [~] 22 Verification by risk tiers (low: syntax/type/targeted test; medium: broader tests, static analysis, diff
      review; high: full tests, independent review, security, possibly a second model).
- [~] 23 Budgets: money, time, model-call, retry, parallel-agent and verification budgets (today: tokens only).
- [ ] 26 Versioned local database: tasks, task_runs, model_runs, provider_calls, token_events,
      routing_decisions, context_events, memory_events, tool_calls, verification_runs, failures, benchmarks,
      provider_health, component_registry; migrations, retention, project scoping, correlation ids.
- [~] 27 Explainable routing with evidence (success rate over N tasks, expected cost and latency, the rejected
      alternative); conservative defaults when evidence is thin.
- [~] 28 Human override: force provider/model (--tier/--agent/--model exist). Missing: switch off automatic
      routing, memory, third-party integrations, cloud providers, local models; privacy choices; inspect routing
      decisions; clear local history; retention setting; trigger benchmarks from the app.
- [ ] 29 Component registry with decision + reason + security notes per component.
- [~] 30 Graceful degradation chains: code graph -> semantic search -> ripgrep -> manual; premium model -> other
      hosted -> local -> user-chosen.
- [ ] 31 Security: treat tools, MCP servers, plugins and tool output as untrusted (prompt injection, secrets never
      exposed to models/tools unnecessarily).
- [ ] 33/34 CLI for operations: `operant doctor` (providers, credentials, optional deps, versions, MCP, local models,
      database, context providers), `providers`, `models`, `route explain`, `stats`, `benchmark`, `components`,
      `context`.
- [~] 35-37 Benchmarks by category (simple/medium/complex coding, debugging, refactor, architecture, exploration,
      docs, tests, failure recovery) with human-intervention counts; baseline vs Operant with gross/net token, cost,
      success, latency, retry deltas; replay of past tasks with synthetic fixtures.
- [~] 38 Caching economics: cached vs uncached tokens and cost (hit rate shipped in 1.19; cache-aware cost and
      latency per decision missing).
- [~] 39/40/45 Git awareness and adaptive context: branch, staged/changed files, recent commits, conflicts; widen
      context only on evidence; link memory to symbols and commits (today: file hashes).
- [ ] 41 Model handoffs: pass structured task state (decisions, constraints, needed files, verification state),
      measured, skipped when it costs more than it saves (today: a two-line failure note on escalation).
- [ ] 42 Failure classification: model, provider, tool, context, retrieval, memory, environment, ambiguity, bug,
      test failure, timeout, rate limit, auth; fed back into routing.
- [~] 43 Retries must change something (model, provider, context, strategy, tool, prompt, verification) or stop
      and classify (today: one same-tile retry with the reject note, then a tier up).
- [~] 44 Escalation/downgrade signals: low confidence, high risk, big dependency graph, ambiguity, failed
      verification, context insufficiency; downgrade on simplicity, low risk, small context.
- [ ] 52 Measure Operant's own latency: routing, retrieval, compression, database, model start-up, MCP/tool.
- [~] 54/56 Settings and backups: credentials handled securely and never backed up in plain form (check what
      config.json and backups hold); settings included in backups (done).
- [~] 55 Auto-updates opt-in and explicitly configurable (check the default), validate the environment first.
- [x] 16/17/18 Memory metadata, staleness by file hash, usefulness from used/wrong (1.19-2.0).
- Note: section 1 says "Do not build a dashboard around Claude/OpenCode. Build the system that coordinates them",
  so the dashboard (first spec, 84) is a window onto the analytics, not the product.

**Order, revised with both specs**
- 2.1 (in progress): operations, plus secure handling of credentials in config and backups, auto-update opt-in check.
- 2.2 Measure everything: the versioned local database (26), token/cost/latency/cache events incl. Operant's own
      overhead (12/38/52), failure classification (42), stored routing decisions with evidence (27), provider and
      model health, `operant doctor` / `stats` / `route explain` (33/34), then the dashboard and health strip.
- 2.3 Decide better: expected-utility routing with decayed, per-project stats and intervals (8/9), risk-bounded
      exploration (10), retries that change something (43), escalation/downgrade signals (44), verification by
      risk tier (22), budgets beyond tokens (23), human-override switches and clear-history/retention (28).
- 2.4 Context: context engine and adaptive context (13/40), git awareness (39), overflow recovery (20), tool-output
      compression with a worth check (12/19), structured model handoffs (41), memory linked to symbols/commits (45).
- 2.5 Providers and collaboration: provider interfaces and capability routing (5/6), component registry (29),
      degradation chains (30), MCP, security for tools and tool output (31), collaboration roles (11), benchmarks
      by category with replay (35-37), optional local model (ask first), docs.
