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
- [x] **72. 2.1 docs, release.**

## Operant Terminal: one prompt box per project that plans, dispatches and reports (asked 29 Sept)
The user's words: "a Single Operant Terminal, look and act like Claude but cooler. It takes a prompt from me and
edits it, cleans it, makes it efficient using either free OpenCode or local Gemma. This then gets processed, sent to
the relevant agents, then receives the answers back of what the agents did. This is for each project."
It is the front door for the spec's core flow (first spec 90; master prompt 7/8/27/53/81): request -> refine ->
classify -> route -> run -> verify -> report. Built into the existing tiled UI (84A), not a separate app. User decisions (29 Sept): build it as the headline of 2.2,
after 2.1 ships; the cleaned prompt is shown for review and Enter sends it (auto-send is a per-project setting).
What it needs from later milestones is pulled into 2.2: see "Release order (final)" at the end of this file.

**2.2 design (29 Sept): how the Terminal is built**
- Pieces: `refiner.js` (main: builds the brief, calls a refiner provider, validates its JSON), `terminal-store.js`
  (main: per-project conversation, userData/terminal/<project-key>.jsonl, atomic, in backups), `renderer/terminal.js`
  (the tile UI, a new tile kind `operant`, one per project), dispatch and results wiring in renderer.js (board).
- Refiner providers: `opencode` = `opencode run` headless with the free model, run in an empty temp folder with the
  brief inside the prompt (so it can't touch the project, and its tools have nothing to act on); `local` = an
  OpenAI-compatible `/v1/chat/completions` URL (Ollama, LM Studio, llama.cpp); `off` = pass-through. Timeout 60 s,
  then pass-through with a note.
- The refiner is given: your prompt, the project brief (branch, changed files, last 5 commits, known test/build
  commands, top 5 memory facts, redacted), and the real options (each active tier's agent, model, effort, price per
  million tokens, free or not, and the allowed top tier). It must answer with JSON only:
  `{ question?: string, summary: string, cleaned: string,
     tasks: [{ title, prompt, type, complexity: low|medium|high, risk: low|medium|high, files: [],
               agent, model, effort, tier, why }] }`
  Validation: unknown agent/model/tier -> replaced by routing's pick with the reason; above the top tier -> capped;
  more tasks than max workers -> merged or queued; a `question` means ask the user before anything else.
- IPC: `terminal:refine {project, prompt}` -> `{ requestId, original, refined | null, question?, tasks, brief (token
  count only), refiner: {provider, model, tokens: {input, output}, ms, usd|null}, error? }`;
  `terminal:history {project}`, `terminal:append {project, entry}`; dispatch goes through the renderer's existing
  `agent` control path with `{ agent, model, effort, tier, requestId }`.
- Correlation: every task and outcome carries `requestId`; the Terminal shows cards by requestId and updates them on
  board changes (status, hand-back note, checks, diff size, tokens, cost).
- Accounting: the refiner's tokens are recorded as an orchestration event with the requestId; the card footer shows
  "refiner used N tokens; the refined prompt is M tokens shorter" (net figure, only from real counts).

- [x] **73. The Operant tile:** a new tile kind, one per project (opened from the projects sidebar, a key, or
      `operant terminal`). Looks and behaves like Claude Code: transcript above, a multi-line prompt box below,
      streaming text, collapsible tool/agent cards, slash commands, history with up/down, Esc to interrupt, paste
      images. "Cooler": the Operant themes, live agent cards with their tier dot, tokens and cost as they run, a
      one-line "what Operant decided and why" under each step. The conversation is saved per project
      (userData/terminal/<project>.jsonl, atomic, included in backups) and comes back after a restart.
- [x] **74. Prompt refiner:** (built: `opencode run -m opencode/big-pickle --format json --pure` in an empty temp dir, ~17 s,
      ~14k input tokens of OpenCode's own prompt per call, all free; savings must be shown as paid vs free tokens). Now a lazy `opencode serve` with a lean config: ~4 s, ~3.5k input
      tokens; refiner eval 7/8 (the miss: a high-risk task on the cheapest tier, now always raised a tier). your prompt plus a small project brief (from prime: branch, recent changes, project
      memory, known commands) goes to a refiner model that returns a cleaned, efficient prompt, split into
      independent tasks, and for each task picks the agent (Claude Code or OpenCode), the model and the effort,
      aiming for the cheapest that can do it well (free OpenCode models and Haiku first, low effort by default), plus
      the type and the files it expects to touch. Providers: OpenCode's free
      model (`opencode run` headless, no tools, in the project folder) by default; a local model (Ollama / LM Studio
      / llama.cpp OpenAI-compatible URL) when configured; off = pass through unchanged. If the refiner is down, the
      original prompt goes through (graceful degradation). Its tokens are counted as orchestration cost, so the
      terminal can show net savings honestly (spec 19/45).
- [x] **75. Review before sending:** the refined prompt is shown against your original (what changed and why, the
      task split with each task's agent, model and effort, estimated tokens and cost before/after); Enter sends it, E edits it, O sends your original instead. An
      "auto-send" setting skips the review for trusted projects.
- [x] **76. Dispatch:** the refiner's pick (agent, model, effort) is checked against the outcome history before it
      runs: routing keeps it unless the record shows that choice failing for this kind of task (then the cheapest
      proven one), never above the top tier allowed, and never a model that isn't available; the review (75) shows
      the pick and why, and you can change it. Each task then goes to a worker tile on the board,
      or to the project's lead agent when it's one conversational job; independent tasks run in parallel up to the
      worker limit; Claude or OpenCode per the tier. Nothing new about how workers run: board, budgets, stuck
      detection, checks before review all apply.
- [x] **77. Results back:** each task reports into the terminal as a card: status, the worker's hand-back note,
      files changed, checks and diff size, tokens and cost; approve / reject (with a note) / open the tile /
      message the worker, right in the card. When everything is in, a short summary of what was done and what's
      left, and a notification if you're away.
- [x] **78. Follow-ups in context:** replying in the terminal continues the same job (a follow-up goes to the worker
      that did the task, or becomes a new task), without resending the whole history to anyone.
- [x] **79. Settings (Settings › Terminal):** refiner provider and model, auto-send, max workers per request,
      show savings, where it opens. All real, saved, validated (84B-84E).
- [x] **82. Per-project agent choice (asked 29 Sept):** each project can be set to Claude and OpenCode (default), Claude
      only, or OpenCode only, from the project's menu in the sidebar and Settings › Operant Terminal. It limits
      everything for that project: the tiers the refiner may pick from, routing and escalation (tier fallbacks stay
      inside that CLI, e.g. Claude only = Haiku -> Sonnet -> Opus; OpenCode only = its free and paid models), worker
      launches, `operant agent` without a tier, and the Terminal's review (shows the mode). A tier the mode rules out
      is skipped, not faked; if nothing is left (e.g. OpenCode only but it isn't installed) the Terminal says so.
      The refiner's own model stays its own setting (free OpenCode, local, or off), with a note when it differs.
**Terminal parity with Claude Code (asked 29 Sept, after 2.2.0; on dev-2.3.0)**
- [x] Handed-out work goes to one master worker per CLI (Claude, OpenCode) that runs the parts as parallel
      subagents up to the subagent limit; worker notes start with a TL;DR.
- [x] **83. Questions and closing:** a Terminal worker's `operant ask` shows in the Terminal as a question card
      (option buttons, or type an answer), not a system dialog; a blocked worker's note is answerable the same way.
      Each card: Stop (stops the worker, task stays open), Close (stops it and closes the task) and Close with
      reason (the reason is saved on the board task, shown on the card, and not counted as a model failure);
      Stop all for a request.
- [x] **84. Slash commands:** `/` opens a menu (arrows, Tab completes, Enter runs): /help /clear /stop /close
      /retry /approve /reject /tasks /cost /status /tier <name> /auto /original /diff /settings; `#n` picks a card.
- [x] **85. Claude-style input:** `!cmd` runs a shell command in a tile and shows the result card; `#text` saves a
      project memory; `@` completes file paths; Ctrl+R searches history; Esc Esc clears the box; pasted images are
      saved to the project's temp folder and passed to the worker as file paths.
- [x] **86. Live worker activity:** each running card has a collapsible feed of what its worker is doing (its tool
      calls and its subagents', named), from the same tool events the runaway guard uses. Not yet: the worker's
      last message text.

- [x] **87. Operant as the default agent:** Settings › Agents › Default agent offers Claude Code, OpenCode and Operant
      (the Operant Terminal). With Operant, Alt+Enter, the master tile, the sidebar's "New … here" and Explorer's
      "Open in Operant" open that folder's Operant Terminal; the first-run launcher offers it too. Agents that must be a
      CLI (workers, `operant agent`, "share your main agent's setup") use the first Claude Code agent then.
- [x] **88. Simpler settings:** 21 tabs become 8 (General, Look, Agents, Tiles, Projects, Usage, Data, Keybinds), each
      in headed groups with the everyday settings first and the rest under a collapsed "Advanced (n)". Nothing is
      removed; search finds everything; old tab names (links, health actions, hints) still open the right place.

- [ ] **80. Local Gemma (was item 64; ask first, ~3 GB):** one-click install of llama.cpp `llama-server` + a
      small Gemma build as the refiner, only after an explicit yes; until then OpenCode's free model or a URL the
      user supplies.
- [x] **81. Measure it:** evals for the refiner (does the refined prompt keep success while cutting tokens? net of
      the refiner's own cost), a live test per project, and the terminal's numbers shown only when measured.

## Operant 2.0 master spec: everything, and where it stands (mapped 29 Sept)
Kept private (29 Sept): `docs/` is git-ignored and stays on this PC, with copies in ~/.claude/plans/operant-2.0-specs.
Two versions: `docs/operant-2.0-spec.md` (first, with UI/operations 84A-84S) and `docs/operant-2.0-master-prompt.md`
(the full 100-section edition). The first spec is `docs/operant-2.0-spec.md` (pasted 28 Sept; 2.0.0 was built from a short outline of it, so most
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

**Order (first spec; superseded by the final release order below)**
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

**Sections 1-59 of the full master prompt (`docs/operant-2.0-master-prompt.md`, 100-section edition, uploaded 29 Sept)**
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

**Order, revised with both specs (superseded by the final release order below)**
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

**Sections 60-100 of the full 100-section master prompt (`docs/operant-2.0-master-prompt.md`)**
- [~] 60 Repository reconnaissance (done informally each milestone; no kept map).
- [ ] 61 Architecture boundary map (UI, orchestration, providers, persistence, analytics, memory, context, external).
- [ ] 62 Dependency inventory: direct and transitive, required vs optional, duplicates.
- [x] 63 Runtime compatibility: Windows, macOS, Linux, PowerShell/zsh/bash, missing CLIs fall back.
- [x] 64 Configuration compatibility: config versions and migrations (item 70).
- [ ] 65 Secrets management: keep keys and tokens out of logs, analytics, prompts, backups and model-visible
      context; redact at telemetry boundaries. (Check config.json, session.json, logs and backups now, in 2.1.)
- [~] 66 Prompt-injection resistance: agent messages are framed "not the user, can't approve". Missing: tool output,
      retrieved docs, MCP responses and repository content treated as data that can't override policy.
- [~] 67 Tool permission model: worker allowlist for read-only commands. Missing: explicit per-tool permissions shown
      and controllable; installed != allowed.
- [ ] 68 Execution sandboxing: limit filesystem, process, network and credential access per task and policy.
- [~] 69 Cancellation: stop a tile, OpenCode abort, budget stop. Missing: cancelling a task stops its downstream
      work (verification, escalation) and keeps useful state.
- [~] 70 Resumability: tiles and Claude sessions come back after a restart. Missing: task checkpoints so an
      interrupted task resumes without replaying context.
- [~] 71 Task state machine: board statuses todo/doing/verifying/review/done/failed/blocked. Missing: planning,
      waiting, recovery and cancelled states, and transitions enforced in one place.
- [ ] 72 Idempotency: retries and resumes never repeat destructive actions.
- [~] 73 Concurrency control: max workers. Missing: limits per model, provider, tool and project.
- [ ] 74 Rate-limit awareness: back off, switch provider or model, queue; no retries against a known-down route
      (today: plan-limit alerts only).
- [ ] 75 Cost guardrails: estimate cost before an expensive step and ask when it would exceed the budget.
- [ ] 76 Latency guardrails: latency budgets in routing.
- [~] 77 Quality guardrails: checks before review. Missing: configurable quality thresholds, escalate verification
      when the result is uncertain or high-risk.
- [~] 78 Task classification: type only. Missing: complexity, risk, capabilities, likely context size, verification
      need; deterministic or local-model.
- [~] 79 Task decomposition: skill guidance to hand off independent parts. Missing: decompose only when it lowers
      risk, context pressure or time, measured.
- [~] 80 Plan validation: `operant plan` asks the user. Missing: automatic checks for missing constraints,
      contradictions, excess scope before implementation.
- [ ] 81 Execution strategy selection: direct, staged, parallel, collaboration, retrieval-first or clarify, by
      expected benefit.
- [~] 82 Clarification gate: `operant ask`. Missing: a rule for when to ask (material to correctness, cost, or a
      destructive action) enforced in the brief/skill.
- [~] 83 Decision trace: outcomes.jsonl records results. Missing: inputs, alternatives considered and the chosen
      strategy per decision, without prompt contents.
- [~] 84 Routing policy engine: routing.js is pure and tested. Missing: policies configurable without code changes.
- [ ] 85 Routing overrides with explicit scope (temporary / persistent, project / global).
- [ ] 86 Model capability registry: normalised capabilities per discovered model plus provider metadata.
- [ ] 87 Provider health scoring that decays, so an old outage doesn't poison routing.
- [~] 88 Model performance profiles: per task type, min 5 samples. Missing: per project, uncertainty-aware estimates.
- [x] 89 Cold-start routing: "insufficient data" falls back to the keyword suggestion.
- [~] 90 Routing explanation API: one-line reason in the CLI. Missing: structured explanation in the UI and CLI.
- [ ] 91 Context budgeting: allocate before retrieval, keep headroom for output and tool results.
- [ ] 92 Context deduplication: repeated file content, duplicated tool output, overlapping retrieval, summaries.
- [ ] 93 Context provenance: where each piece came from, traceable after compression.
- [~] 94 Context freshness: memory marked stale when its file changes. Missing: the same for any cached context.
- [ ] 95 Retrieval evaluation: precision, recall proxies, tokens, latency, downstream usefulness.
- [ ] 96 Compression evaluation: compressed vs uncompressed on representative tasks, net saving without loss.
- [~] 97 Memory lifecycle: create, verify (used/wrong), decay in ranking, supersede. Missing: promotion, archival and
      deletion rules.
- [~] 98 Memory provenance: created date, about links. Missing: source (which session/agent/evidence).
- [x] 99 Memory isolation: project vs personal memory, nothing written outside a project (2.1).
- [~] 100 Memory conflicts: supersedes chain. Missing: detect conflicts, prefer newer verified evidence, keep the
      conflict record.

**Release order (final, 29 Sept: all three documents plus the Operant Terminal)**
- 2.1 Operations (in progress): 84A-84S full edition, 54-57, 64; secrets kept out of logs, backups and prompts (65);
      settings validation, effective values, restart notices and reset (84C-84E); first-run / upgrade / recovery
      detection (84O); restore that migrates, validates and health-checks (84M/84N); backup metadata (84L); the
      status and health strip with real states (84P); actionable errors (84Q); auto-update opt-in check (55); a UI
      regression pass and live test before release (84S).
- 2.2 The Operant Terminal (items 73-81) and what it needs to work properly, pulled forward from later milestones:
    - a small provider seam for the refiner and utility calls: OpenCode free model, a local OpenAI-compatible URL,
      later Gemma (5/6/17, item 80 asks first);
    - task classification by type, complexity, risk, likely files and verification need (78/39), so the refiner's
      split and routing agree;
    - structured routing explanations shared by the CLI and the Terminal cards (27/90) and a stored decision trace
      (83) with correlation ids linking request -> refined prompt -> tasks -> workers -> results;
    - honest accounting for the Terminal: refiner tokens as orchestration cost, gross vs net savings, cache-aware
      cost (1.2/12/19/38/45) - kept in the outcomes/usage files for now, moved into the database in 2.3;
    - a project brief for the refiner from project knowledge (60) and git state (39): branch, changed files, recent
      commits, known commands, top memory facts;
    - prompt-injection and secret safety for the refiner path (65/66): the brief is data, not instructions; no keys
      or tokens in what's sent;
    - structured handoffs for follow-ups (41): a follow-up carries task state, decisions and files, not the whole
      conversation;
    - clarification gate (82): the refiner can come back with one question instead of guessing;
    - evals for the refiner (does it keep success while cutting tokens, net of its own cost).
- Moved from 2.2 to the start of 2.3 (user, 29 Sept: release the Terminal first): the stored decision trace with
      correlation ids (83), structured routing explanations shared by the CLI and Terminal cards (27/90),
      deterministic complexity/risk classification alongside the refiner's (78/39), a gross-vs-net savings figure
      from real comparisons (81), and the local Gemma refiner (item 80, ask first). Known edge: a project opened
      through a Windows short path (8.3) isn't matched to its per-project settings.
- 2.3 Measure and decide: versioned local database with migrations and retention (26/84N), token/latency/failure
      events incl. Operant's own overhead (12/52), failure classification (42), provider health with decay (87),
      model profiles per task type and project with uncertainty (88/9), expected-utility routing as a configurable
      policy engine with scoped overrides (8/84/85), risk-bounded exploration (10), retries that change something
      (43), escalation/downgrade signals (44), verification by risk (22/77), budgets and guardrails for cost, time,
      retries, latency (23/75/76), rate limits (74), concurrency limits (73), task state machine with cancellation,
      checkpoints and idempotent retries (69-72), plan validation and strategy selection (79-81), `operant doctor` /
      `stats` / `route explain` (33/34), and the analytics dashboard (first spec 84), whose numbers also show in
      the Terminal.
- 2.4 Context: context engine with budgets, dedup, provenance, freshness (13/40/91-94), overflow recovery (20),
      tool-output compression with a worth check (19/31/32), retrieval and compression evaluation (95/96), memory
      linked to symbols and commits, lifecycle, provenance and conflicts (45/97/98/100).
- 2.5 Providers and safety: full provider interfaces and capability routing (5/6/56, item 63), model capability
      registry (86), component registry (29), degradation chains (30), MCP (57), tool permissions and sandboxing
      (67/68), collaboration roles incl. planner -> implementer and implementer -> reviewer, run from the Terminal
      (11), benchmarks by category with replay (35-37), architecture map and dependency inventory (61/62), docs (93).

**UI and operations, full edition (84A-84S of `docs/operant-2.0-spec.md`, uploaded 29 Sept) - what it adds for 2.1**
- [~] 84D Settings show the current effective value, apply at the right time, and never look live when they need a
      restart. Known gap: `autoUpdate` only takes effect after a restart and doesn't say so. Also: one observable
      precedence (defaults, config file, env, user settings, runtime overrides, provider config).
- [ ] 84E Settings validation: missing, out-of-range, bad paths/URLs/provider or model ids, conflicting settings;
      the error says what, where and what's expected; a failed save keeps the last valid config.
- [~] 84F Persistence both ways: UI change -> runtime config, and config change -> reload -> UI shows it (item 71
      covers save/reload/used; the UI round trip isn't tested).
- [~] 84G/84H/84I Updates: automatic download and automatic install as separate choices; migrations and a health
      check after install; rollback status and last update result shown in the UI (history exists).
- [~] 84J/84K Backups: say which data is required, optional or rebuildable cache; backup before restore
      (done), before update and migration (in progress); never uploaded.
- [~] 84L Backup metadata: add backup-format version, schema versions and an installation id to the manifest;
      check schema compatibility on restore.
- [~] 84M Restore flow: validate, safety backup, restore, run migrations, validate restored state, start, health
      check, confirm (today: validate, safety backup, restore, relaunch).
- [~] 84N Migrations for backup formats and future databases too, tested from fresh, old, several versions back,
      interrupted, failed, rollback.
- [ ] 84O First install vs existing vs upgrade vs reinstall vs recovery detected explicitly; defaults only fill
      missing values.
- [ ] 84P Status and health with real states: healthy / available / degraded / unavailable / not configured /
      unknown, for version, update, backup, database, providers, models, local model, memory, CodeGraph, MCP.
- [~] 84Q Actionable errors: operation, cause, component, current state, whether data changed, next step, whether
      a retry is safe; a pass over existing error messages.
- [~] 84R Tests: invalid release metadata, installation and migration failure, health-check failure, incompatible
      backup, post-restore health check, UI reload/restart round trips.
- [ ] 84S A UI regression pass before release: launch, navigation, settings, providers, models, analytics, memory,
      integrations, error / loading / empty states.
