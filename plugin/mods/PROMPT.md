Build eight Claude Code mods. Use the plugin-authoring skill. Each mod has .claude-plugin/plugin.json, hooks/hooks.json pointing at ./register.tsx, a README with a Limits section, and tests runnable with `claude plugin test <folder>`. Each mod is independent, off by default, cross-platform (Windows, macOS, Linux), and never blocks or edits Claude's tool calls or replies unless stated. Plain language in all UI text, no emojis.

Target: the Claude desktop app (Code tab)
- Everything must work in Code tab sessions, not only a terminal.
  - Draw every band and pane for the `desktop` surface (and still for `terminal`); check `e.surface` and use `$.ui.resolve(e)` elements only.
  - Don't rely on `$.ui.notify` (it has no surface in the desktop app). Use toasts and the band.
  - Every command must work when typed in the Code tab prompt.
- Ship all eight mods in one marketplace (`.claude-plugin/marketplace.json`) in my skills repo doolecg/claude-skills (marketplace `doole-skills`), so each installs at user scope from a terminal and then loads in every desktop session:
  `/plugin install <mod> --marketplace doolecg/claude-skills`
  The README install section gives that line (the Code tab can't run /plugin itself). Use `--plugin-dir` only while developing.

Shared services (read their config, never hard-code hosts or keys)
- Skills: list every skill the session can use: ~/.claude/skills/*/SKILL.md, ~/.claude/operant-hub/skills, the project's .claude/skills, and every installed plugin's skills (from ~/.claude/plugins/installed_plugins.json and each plugin's skills folder). Mods 1 and 7 use this one list.
- Hindsight: my self-hosted server. Read the URL and the optional token from ~/.hindsight/coding-agent.json (`apiUrl`, `serverMode: self-hosted`). The bank is `coding-agent::<project folder name>`, the same one the hindsight MCP and hooks use, plus one global user bank. If the server doesn't answer within 5 s, skip it, say so in the band, and retry next run. Never use the claude.ai Hindsight connector.
- CodeGraph: the global `codegraph` CLI/MCP (user scope). Use it in any repo with a `.codegraph/` folder. Without one, skip it and say "CodeGraph: not indexed". Never index a repo yourself.

1. Prompt Enhancer
- `/enhance <rough prompt>` rewrites the given text. A prompt starting with `++ ` is held on Enter and rewritten instead of sent.
- The rewrite has four parts: the cleaned-up task; "Load these skills:" (picked from ~/.claude/skills/*/SKILL.md and the plugin skills listed in / commands); "Ask me first about:" (the big decisions); "Done when:" (what finished looks like).
- Show it in the band above the prompt with Use (send as my prompt), Edit (put it in the box) and Cancel (put my original text back). Nothing is sent without one of these.
- Haiku, 900-token reply cap, 30 s timeout, per-session cap of 20 rewrites or 120k tokens. If skills can't be read, say so in the list and carry on. On failure, put my text back where the engine allows and toast whether it was.

2. Design Picker
- Detect an AskUserQuestion call about looks: "design", "style", "theme", "aesthetic", "visual style", "look and feel", "color scheme" or "layout" in the question or header, or two or more options that name a known style.
- Write a self-contained gallery page to the OS temp folder (claude-design-picker.html, overwritten each time) and open it in the browser (`cmd /c start` on Windows, `open` / `xdg-open` elsewhere). Known styles (minimal, brutalist, glassmorphism, neumorphism, material, flat, skeuomorphic, dark, light, retro, editorial, bento, corporate) get a CSS-rendered sample; anything else gets a neutral card with its text.
- Show the options in the band above the prompt with a "Reopen preview" button. Pass the tool call on unchanged; never answer or delay it. Toast the file path if opening fails; toast if there is no temp folder. No commands, settings or model calls.

3. Idea Shelf
- `/idea <text>` parks an idea on the current project's shelf without starting a turn or reaching the model, even mid-turn. `/idea edit <n> <text>` replaces idea n, keeping its place.
- `/ideas` opens a pane with Send / Edit / Delete per idea. Send submits it as my prompt (queued if Claude is busy) and removes it once submitted. Edit uses an inline field with Save/Cancel (Enter saves; empty refused). On mobile surfaces, Edit is replaced by a note.
- Store ideas in the plugin store, one shelf per project folder (case-insensitive; a subfolder is its own shelf), kept across sessions. Max 2000 characters per idea.

4. Same-Folder Tracker
- Each session writes only its own entry to the plugin store, keyed by folder: phase (working / waiting on permission / idle / done, from hook events), last update time and up to 50 paths it edited via Edit, Write or NotebookEdit. Never store file contents.
- While another live session shares the folder, show a band above the prompt: "Other session: <phase> — editing <file> (n files)", up to three sessions.
- Toast once per file per session when I'm about to edit a file another session already edited. Never block the edit.
- A session with no end event drops out 30 minutes after its last update. Folders match case-insensitively; a subfolder is separate.

5. Plain-English Claude Code
- Add one short system-prompt section: simple words and short sentences; little narration of the work; all prose in one final block headed "Summary"; a "Next steps" section at the end.
- Status line under the prompt: "Working on: <first words of my prompt>", plus "(running <tool>)" while a tool runs; cleared when the turn ends.
- After a main-agent turn with a reply of at least 400 characters (not aborted or errored), run one haiku check (low effort, 40 tokens out, 15 s limit) that answers PASS or FAIL with the rule missed. Show "Plain-English: ok" or "Plain-English: missed: <rule>" in the band; toast on a miss. Never edit the reply. Cap at 25 checks or 150k tokens per session, then keep the last verdict. Skip subagent turns.

6. Agents Panel (Right Now, Memory status, sub-agents, Status)
A pane opened with /agents-panel (and a one-line summary in the band above the prompt: headline · branch · memory line). Observation only: it never starts, stops or changes anything. Built only from hook events, transcripts and git; nothing is guessed, and unknown values show "—".

a) Right Now card
- Headline, from top-level tool calls only (subagent calls don't count):
  - Question or permission pending: "Waiting for you" plus what it asks.
  - Read / NotebookRead / Grep / Glob / LS: "Claude is reading <file>", then "in <folder>".
  - Edit / MultiEdit / Write / NotebookEdit: "Claude is editing <file>", then "in <folder>".
  - Bash / PowerShell: "Claude is running a command" plus the command.
  - Any other tool: "Claude is working". Mid-turn with no tool: "Claude is thinking".
  - Turn ended with edits: "Claude edited N files", then the last file and green +added / red −removed when the diff is known.
  - Otherwise "Claude is idle". The subline is "last: <file>", or "no files touched yet".
- Git row: branch name in mono bold, then "N changed" in amber or "clean, nothing changed". Hidden outside a repo.
- Memory row with a brain icon:
  - While a memory save runs: "Learning from this session…" with a spinner.
  - After it: "Learned N lessons: M saved, K to review".
  - Nothing yet: "Memory: nothing learned yet".
  - On error: "Memory: <error>".
  - Source: mod 7's last run when it is installed, otherwise writes to CLAUDE.md, the auto-memory folder and MEMORY.md during the session. File names only, never contents.
- Colour key: purple "Claude read", orange "Claude edited", yellow "Not committed".
- Files list: every file read or edited, most recent first. Edited wins over read. A yellow dot marks uncommitted files. Show 5, then "+N more".

b) Summary cards: Cost (≈$0.01), Tokens (73.6k), Time (0:04), summed over the known values of the visible agents. Time runs from the first start to now while any agent runs, else to the last end.

c) Sub-agents
- "Running · N" and "Finished · N" groups, each collapsible. A Collapse/Expand-all link, and "Clear finished" (disabled when none).
- Each finished row has an X on hover that clears it. Cleared rows are hidden for this session only and remembered.
- Each row shows:
  - A 12x12 pixel critter. One of eight hats (cap, hardhat, beanie, chef, headphones, flag, bow, crown) and one of three tints (coral, peach, butter), picked by an FNV-1a hash of the agent id so it never changes. It bobs while running.
  - The description in bold, with a status mark: pulsing dot for running, amber dot for waiting, green check for done, red X for failed, grey dot for stopped.
  - A stable friendly name from the same hash, plus "· <agent type>".
  - The effort word (coloured) plus the short model name ("Haiku 5.5" from claude-haiku-5-5).
  - A metrics line: "ctx 18% · 36.8k ≈$0.001 0:02", leaving unknown parts out.
  - A 3px bar: TodoWrite done/total if the agent made todos, otherwise context fill (hidden when unknown).
- Clicking a row opens that agent's conversation in the pane, live while it runs and from its transcript after: its prompt as a bubble, then tools and replies, with a context bar and "< Agents" to go back. It keeps scrolling to the bottom unless I scroll up.
- Empty states: "No agents in this session yet." and "All agents cleared."

d) Status (collapsible, open state remembered; a red dot on the header when collapsed and a server failed)
- MCP grid, summary "MCP · 10 connected · 2 needs sign-in" (zero counts left out). One tile per server: a "claude.ai" prefix line for connectors, the short name, then the state in its colour. Green connected, amber needs sign-in, red failed, grey otherwise. Amber and red tiles are tinted, and the reason shows in the tooltip.
- Skills grid, "Skills · N loaded": one tile per skill the Skill tool loaded, newest first, each skill once. "plugin:skill" names split into prefix and name.
- Session: the SessionStart hook messages, each with its origin.
- "Nothing to report." when all three are empty.

Style: rounded cards (14px card, 12px tiles), muted labels, tabular numbers, no emojis. Every control has an accessible label.

7. Session Learner (mod + skill) — learns when a session is done, and tunes skills over time

When it runs (tied to the Claude app's completed flag)
- Never mid-session, and never on idle or on a turn ending. It runs once when the session is marked done.
- The mod API has no event for the sidebar's "Mark as completed" or archive, so the mod catches done in three ways:
  1. `/done` (optional note: `/done <what was achieved>`): marks it done and learns.
  2. A `tool.call` hook on the sidebar's mark-completed tool (`mcp__ccd_sidebar__mark_completed`, when Claude marks the session completed because I asked): learn after it succeeds.
  3. `session.end` with a reason that means the app stopped or archived the session (not `clear` or `resume`): learn, but only if the session had at least one edit or a `/done` note. Closing a chat that did nothing learns nothing.
- `session.end` has a 1.5 s budget, so it only writes a job file (session id, folder, transcript path, start HEAD) and starts a detached learner process with `$.process.run`. All the real work happens in that process, with a hidden window.
- A `session.start` hook picks up any job file left unfinished (the machine slept, the process died) and runs it once.
- If the app later exposes a completed or archived event (or a SessionEnd reason for it), use that as the main trigger and keep `/done`.
- `/learn-now` runs it by hand on the current session. `/learn-off` turns it off for this session.

Gate (in code, before any model call)
- Skip sessions with fewer than 2 user turns, under 2000 tokens of transcript, or no git diff and no corrections.
- Record why a session was skipped.

What it reads (the evidence)
1. The transcript tail: user prompts, Claude's final replies, tool calls and failures, interrupts, and the next prompt after each reply (that's where corrections live).
2. The git diff against the session's starting HEAD: changed files, plus added declarations and hunk function names.
3. CodeGraph (only if .codegraph/ exists): `codegraph explore` on the touched symbols, to get callers and blast radius. Each lesson is tied to real files and symbols, never invented ones.
4. Hindsight: search the project bank for lessons on the same files, symbols and topic, so known lessons are merged instead of duplicated and contradictions are spotted.

What it learns (one Haiku call, low effort, JSON out; anything malformed is dropped)
- Lessons, each with a kind:
  - convention: how this project does X.
  - pitfall: X broke because Y.
  - correction: I corrected Claude.
  - procedure: steps that worked, repeated.
- Each lesson has scope (project or user), files, symbols and the source session.
- Corrections that point at a skill Claude loaded name that skill.
- At most 8 lessons per session. One sentence each, no secrets, no file contents.

Where it writes
- Hindsight: project lessons to the project bank, facts about me to one global user bank.
- Project memory: one line each in the auto-memory folder plus a MEMORY.md pointer, deduplicated.
- CodeGraph: tag lessons on the symbols they mention, if CodeGraph supports notes; otherwise skip and say so.
- A store that fails is skipped and named in the run's record. It never breaks the session.

Review modes (setting, default suggest)
- off: nothing runs.
- suggest: everything waits in /learn for me to approve, edit or reject.
- controlled: low-risk lessons apply themselves. Anything naming a command, a URL, "always" or "never" still waits.
- advanced: skill drafts that pass validation apply themselves too.
- Every automatic change is recorded with before/after text and can be rolled back from /learn.

Staleness
- Each run, mark active lessons stale when all their files are gone or their symbols no longer exist (checked with CodeGraph).
- Stale lessons leave memory so they stop steering sessions.

Skill optimising (the self-learning loop)
- Scorecard per skill, from PostToolUse on the Skill tool, kept in the plugin store:
  - times loaded;
  - sessions where it was loaded and I then corrected Claude on that topic;
  - interrupts after it loaded;
  - tool failures in the same turn;
  - turns from loading to /done.
- New skill: a procedure lesson seen in 2 or more sessions (similar ones grouped) becomes a pending skill draft (SKILL.md with name and description). Never a duplicate of an installed skill or an earlier draft.
- Fix: a correction that names a skill becomes a pending fix draft: the skill's text plus a "## Learned correction" bullet.
- Rewrite: when a skill's correction rate is at least 30% over its last 5 loads, draft a rewrite with Sonnet. Fold in the learned corrections, tighten the description so it triggers at the right times, and keep it under the original length + 20%.
- Validation before a draft can apply (or be offered as passing):
  - frontmatter parses;
  - the name is unique;
  - no secrets;
  - the description is under 1024 characters;
  - the body doesn't drop any rule the old one had unless a correction contradicts it.
- After a change: the next 5 sessions that load the skill are compared with the 5 before. If corrections or interrupts went up, show "Skill X got worse after the change — roll back?" in /learn. Never roll back silently.
- Approval installs: new skills go to ~/.claude/skills; fixes rewrite the installed file and keep the old text for rollback. Skills from plugins or marketplaces are never edited; offer a local override instead.

Next session (closing the loop)
- SessionStart injects a short brief: up to 6 active lessons relevant to this folder (from Hindsight, ranked by files touched recently), plus "Skills changed since last time: ...".
- Under 1500 characters.

Budgets (settings, applied live)
- Max model calls per run (default 4).
- Max tokens per run (default 60k).
- Max changes per run (default 5).
- Daily spend cap in USD (default $0.50; 0 = no cap).
- Hitting one stops the run and says which.

UI
- Band line: "Learned N lessons: M saved, K to review", or "Memory: nothing learned yet", or "Memory: <error>".
- /learn pane, with tabs:
  - Lessons: filter by kind, store or search; edit, merge, move between stores, delete.
  - Drafts: show the diff; Approve, Edit or Reject.
  - Skills: the scorecard with trends.
  - Changes: the history, with Roll back.
  - Runs: each run's counts, skips and errors.
- A Test button sends one tiny call to the learn model and stores nothing.
- Deletes confirm and show counts.
- Never log secrets; scrub transcript text before any model call.

8. Context View (like the /context demo)
A live picture of the context window, drawn the way `/context` draws it, as a pane opened with `/ctx` and as a meter in the band.
- Data: `$.session.usage({ breakdown, columns })`. Its `context.breakdown` has the grid, the categories, memory files, MCP tools, agents, skills and slash commands. Never estimate numbers of my own; show what the engine reports.
- Updates are pushed, not polled: refresh on `session.measure` (after each main-thread turn), on `session.compact` and when the pane opens. Use the `summary` breakdown by default (it's free). A "Count exactly" button asks for one `full` breakdown and says that it costs token-count calls.
- Pane layout:
  - The grid as /context draws it: 10 by 10 squares (20 by 10 for a window of a million or more, 5 wide when narrow), each coloured by its category's theme colour, filled or empty. Map the theme colour keys to the surface's own theme so it reads in light and dark.
  - Beside the grid: the model, "73.6k / 200k tokens (37%)", then one row per category (System prompt, System tools, MCP tools, Custom agents, Memory files, Skills, Messages, Free space, Autocompact buffer) with its square colour, tokens and percent. Order the rows by `kind`, not by name; deferred tool schemas go in their own muted row "loaded on demand, not in the window".
  - Under it, collapsible lists, each sorted biggest first with tokens: Memory files (path), MCP tools (grouped by server, with a server total), Custom agents, Skills, Slash commands.
  - Footer: "Auto-compact at <threshold> (<n>% left)", or "Auto-compact off". The last response's token counts (input, cache write, cache read, output) come from `apiUsage`.
  - Before the first response: "No context reported yet" and an empty grid. Never invent numbers.
- Band: a thin meter "ctx 37% · 73.6k / 200k" that turns amber at 70% and red at 85% of the auto-compact threshold (of the window when auto-compact is off). One toast the first time it crosses 85% in a session.
- Clicking a category row highlights its squares in the grid. Clicking a memory file or skill shows its path. Read-only: it never compacts or changes anything (suggest `/compact` in the red state).
- Works on the `desktop` surface (the Code tab) and in the terminal. The grid is built from the surface's own elements, not ANSI text.

Testing (all mods)
- For each mod, write tests for its pure logic and its hook wiring:
  - 1–5: detection, storage, rules and parsing.
  - 6: headline rules, file list, critter hash, metrics, summaries and MCP/skill tiles.
  - 7: the gate, lesson parsing, dedupe and merge, staleness, scorecard maths, draft validation, the before/after comparison, rollback and budgets.
  - 8: grid and row mapping from a recorded breakdown, ordering by kind, thresholds, the empty state, and refresh on session.measure.
- Run the tests, then load each mod in a real session in the Claude desktop app's Code tab to check it works there (the band, panes and commands on the desktop surface). Then check it in a terminal session too. For mod 7, do one real run on a short real session with claude-haiku-5-5, showing the band line and /learn.
- Max 3 test-and-fix passes per mod, then stop and report.
- When done, list for each mod what was verified and how to load it.
