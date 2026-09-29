# Operant agent-use evals

Measures how a Claude Code agent inside an Operant tile uses the `operant` skill and CLI, so a redesign of the brief, skill or CLI can be compared with what ships today. `claude plugin eval` is not usable here (no sandbox on native Windows), so `run.mjs` drives `claude -p` itself.

Per run it records: did the agent load the skill (`Skill` tool), did it send long commands (tests, builds, installs, dev servers) through `operant test|build|run` instead of running them raw, did it use `operant plan|ask|notify|agent|task` when they fit, did it leave them alone for trivial requests, and did a worker report back with `operant task done`. Plus turns, tokens, cost and duration.

## Run

```
node run.mjs --arm before --brief-ref 1.18.0 --runs 3 --model sonnet
node run.mjs --arm after --brief-file <worktree>/agent-brief.js --plugin-dir <plugin folder>
node run.mjs --arm smoke --brief-ref 1.18.0 --cases slow-suite,git-status --runs 1 --model haiku -j 2
node run.mjs --arm x --brief-ref 1.18.0 --dry-run     # prints command lines, cwd and env, starts nothing
node selftest.mjs                                      # offline check of the grader and env rules
```

`--brief-ref` loads `agent-brief.js` from a git ref of the Operant repo (`--repo` or `OPERANT_EVAL_REPO`, default `F:\PROGRAMMING\REPOS\Operant`), `briefFor('claude')` if it exports one, else `BRIEF`. `--brief-file` takes a `.js` module the same way, or any other file as the brief text. No brief flag means no brief. `--plugin-dir` may repeat. `OPERANT_EVAL_CLAUDE` overrides which `claude` is used, `OPERANT_EVAL_TIMEOUT_MS` the 6 minute per-run timeout.

Results go to `results/<timestamp>-<arm>/`: `summary.md` (printed at the end), `summary.json`, `runs.jsonl` (one record per run), `raw/` (each session's stream-json) and `stub/` (each run's stub call log, scenario and state). Compare arms by their `summary.md`.

## Cost

Every run is a real Claude session on your subscription. 13 cases x 3 runs = 39 sessions (haiku runs were $0.02-0.06 at list price, `fan-out` about $0.27 because its subagents' work counts; sonnet costs more, and each session carries ~25k tokens of your own CLAUDE.md, skills and plugins). Check `/usage` first: the run stops starting sessions when the plan says no, and `summary.md` shows the plan usage seen while it ran.

## Safety

The harness may itself be running inside a live Operant tile; the child `claude` must never reach it. Per run the child env drops every `OPERANT*` variable, `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDECODE` and the other session variables, drops every PATH folder that offers a real `operant`, then sets `OPERANT_API=http://127.0.0.1:9` (nothing listens there), `OPERANT_TOKEN=eval`, `OPERANT_TILE=7` and puts `stub/` first on PATH. A case cannot override the API or token. Each run gets a fresh copy of `fixtures/node-app` in the OS temp folder (removed afterwards, along with the empty `~/.claude/projects/<workspace>` folder claude creates for it; `--keep` keeps both). Only the `claude` processes it starts are killed, by PID, after a 6 minute timeout or Ctrl-C. The Operant repo is only read (`git show`).

## How it works

- `stub/operant-stub.js` is a fake `operant` (`operant` for sh, `operant.cmd` for Windows). It logs every call as `{t, argv, cwd, worker}` to `OPERANT_EVAL_LOG` and prints canned output shaped like the real CLI's (parser and formatters copied from `bin/operant-cli.js` 1.18.0; `help.json` is a snapshot of the real help, regenerate it with `node stub/make-help.mjs [--repo <path>]`). The canned project state is the fixture: the suite fails 2 of 5 until `src/sum.js` loses its off-by-one. Scenario data (`team`, `planAnswer`, `askAnswer`, `tasks`, `prime`) comes from the case's `scenario`; `prime` is what `operant prime` / `operant hook session-start` hand back.
- The child runs with `--permission-mode dontAsk` and an allowlist (operant, git, read-only file tools, `node -e`, plus the case's `extraTools`), so a raw `npm test` is denied without running and still shows up as a raw long-command attempt. `--strict-mcp-config` keeps your MCP servers out of both arms.
- `cases/*.json`: `name`, `kind` (`use`, `negative`, `behaviour`), `prompt` (sent on stdin), `scenario`, `env`, `extraTools`, `maxTurns`, `expect`. Supported `expect` keys: `routed` (an operant test/build/run call before any raw long command), `delegated` (`Agent` tool, `operant agent` or `operant task add`), `operant` (argv prefixes that must appear, e.g. `"task done 12"`), `noOperant` (subcommands that must not appear, counting attempts that never reached the stub). Team mode is off in every case except `fan-out`; with it on, the current brief itself tells the agent to hand lookups to a tier.
- Adding a case: drop a JSON file in `cases/`. Changing what counts as a raw long command: `LONG` in `run.mjs`, then `node selftest.mjs`.
