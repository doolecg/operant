# Progress

Now: **2.1** on branch `dev-2.1.0` (operations: plan.md items 66-72 plus the 84D-84S list). Next: **2.2 = the Operant
Terminal** (plan.md items 73-81 and what it needs, see "Release order (final)" at the end of plan.md). The 2.0
specs are docs/operant-2.0-master-prompt.md (100 sections) and docs/operant-2.0-spec.md (with 84A-84S); plan.md
maps both. Read them before planning.

2.0.0 released 29 Sept (plan.md items 56–62, 65; 63/64 skipped). Follow-ups: eval cases handoff (0/3) and
review-approve (3/6); `operant remember` in a tile at the home folder writes ~/.operant/memory. 1.19 was (main checkout, based on main = 1.18.1). Plan: `plan.md` items 46–55,
full plan with research at `~/.claude/plans/federated-painting-summit.md`. Old attempt kept on the local branch
`salvage/skill-redesign` (never pushed; delete once 1.19 ships) — take code from it with
`git show salvage/skill-redesign:<file>`, review before reuse. Salvaged eval harness: `salvage/evals/` on that branch.

## Done (committed on dev-1.19.0, `npm test` green)
- 46 skill YAML fix, reroute on by default without auto-approve, test/build past 20 s.
- 47 CLI: node:http (no 5-min limit), `--cwd` default, comma `--options`, `run` next-step hint, aliases,
  closest-match errors, help topics, `_desire` log, `prime`/`hook` commands.
- 48 skill per session: `agent-plugin/` via `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`, OpenCode `skills.paths`.
- 49 live context: SessionStart/SubagentStart hooks, worker Stop hook, 605-byte brief, OpenCode prime plugin.
  Live-tested: prime at start and after /compact OK; skill description not shown by Claude because the user's
  ~70 skills overflow the listing budget (brief covers it).
- 50 lean skill body; workers report `task done --status done|blocked|failed --note` (≤100 words).
- 51 tiers by availability: xsmall OpenCode free (else Haiku), small Haiku, medium Sonnet low, high Opus high,
  max Opus max; fallbacks shown; OpenCode tier subagents; tier suggested when none given.

- 52 review/escalation/budgets: board.js (review, approve/reject, one retry then one tier up), per-tier token budgets
  in Settings > Team and `--budget`, lead prime lists tasks waiting for review. Not live-tested yet.

- 53 messaging (opt-in setting `messaging`): messaging.js (dedupe 10 min, 6/min per pair, cap 20), `operant msg`/`inbox`;
  OpenCode via POST /session/{root}/prompt_async (verified from /doc, not live), Claude via PostToolUse context,
  Stop block, or typed when idle (never onto a permission prompt). Not live-tested.
- 54 usage: pricing.js (Claude prices from the claude-api skill 2026-09-29; unlisted models incl. Fable 5 = unknown),
  opencode-usage.js (message sums; matched `opencode stats --days 1`), usage-tags.json tier/task tags, panel views
  by model/tier/task/project with $ and cache hit. Not live-tested; watch 30d range speed (re-reads transcripts).
- Live test 51-54 (29 Sept) passed: review/reject/escalate, Haiku budget stop, Claude<->OpenCode msg round trip,
  usage views (30d ~3.5 s). Fixed: startup crash (isClaude used before init), retry/nudge/send --enter typed
  without a working Enter (now sendLine). OpenCode budget stop confirmed live (and 0 = no limit); OpenCode tokens
  were over-counted (message.updated repeats running totals), now per-message deltas. big-pickle tripped the runaway guard re-running `operant board`
  after a reject; workers stop on permission prompts for commands like git status.

## Next
- 55 evals (Sonnet, 13x3 per arm): pass 74% -> 95%; worker-report, plan-approval 0 -> 100%; notify-when-done only 33%
  (next: make agents reach for `operant notify`). Worker permission allowlist added (b79b63d).

## Working rules (user)
- Structured ~100-word handbacks; targeted edits; one item per commit; smallest model that fits
  (Haiku → Sonnet → Opus medium only when needed); live tests per the testing-operant-live memory.

## Open questions
- Haiku gets no `--effort` (untested whether it accepts one).
- Raise Claude's skill-listing budget for Operant tiles so the skill's description shows? Costs every session.
- From 1.18.1: Mac-only checks untested; `operant diff` with an 8.3 short path; info-bar-off folder title;
  project default agent vs slider; tier limit with team mode off.
