# Progress

Working on **1.19** on branch `dev-1.19.0` (main checkout, based on main = 1.18.1). Plan: `plan.md` items 46–55,
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

## Next
- 53 messaging bus (opt-in): `operant msg <tile> "<text>"`, `operant inbox`; OpenCode via its HTTP API,
  Claude via PostToolUse additionalContext / Stop block / idle typing; loop limits.
- 54 token and cost tracking: opencode.db via node:sqlite, tags model/tier/task, pricing table with source
  (unknown stays unknown), cache hit rate; cross-check with `opencode stats --days 1`.
- 55 evals (move salvage harness to `evals/`, back-to-back before/after when weekly usage allows), docs,
  RELEASE_NOTES, plugin.json version bump at release.
- One batched live test for 51–53 (renderer loads team-tiers.js/board.js; review/escalation; msg round trip).

## Working rules (user)
- Structured ~100-word handbacks; targeted edits; one item per commit; smallest model that fits
  (Haiku → Sonnet → Opus medium only when needed); live tests per the testing-operant-live memory.

## Open questions
- Haiku gets no `--effort` (untested whether it accepts one).
- Raise Claude's skill-listing budget for Operant tiles so the skill's description shows? Costs every session.
- From 1.18.1: Mac-only checks untested; `operant diff` with an 8.3 short path; info-bar-off folder title;
  project default agent vs slider; tier limit with team mode off.
