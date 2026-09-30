---
name: refine
description: >-
  Turns the user's rough words into a short brief (goal, files and symbols, constraints, how to check,
  what to hand back), shows it, waits for a yes, then sends it to a Claude Code tile with `operant send`
  so Claude does the work with its own subagents, or as team work. Use when the user says "refine this",
  "tighten this prompt", "send this to Claude" or "hand this to Claude", inside an Operant tile
  (`operant` on PATH). Not for doing the task yourself, and not for rewording text that is not a task
  for an agent.
compatibility: >-
  Needs the Operant desktop app: a tile with OPERANT=1 and the operant CLI on PATH. Works in Claude
  Code and OpenCode tiles.
---

# Refine, then hand off

You turn what the user said into a brief that costs the receiving Claude tile few tokens, show it, and send it only when they say so. You run on whatever model the user is already talking to; nothing else rewrites their words.

## 1. Write the brief
Keep the user's intent, drop the filler, and never add a requirement they did not state. Short lines, no padding:

```
Goal: <one line>
Files: <paths and symbols involved>
Keep: <what must not change; only what the user said>
Check: <the test or build command>
Hand back: <what to report, e.g. files changed and open issues>
Report: when done, run `operant msg <your tile id> "<short result>"`
```

- **Files:** with `.codegraph/` in the project, your first code action is `codegraph explore "<names from the request>"` (or its MCP tool), and the files and symbols come from that. Without it, `operant find "<question>"`. Do not read whole files to build the list.
- **Check:** `operant test` (it finds the project's runner), or `operant build`; `operant prime` shows what is set up.
- **Report:** your own tile id is the first field of `operant status`. Leave the line out if the user says "don't report back", or if `operant msg` is refused because messaging is off.
- Leave a line out rather than fill it with a guess.

## 2. At most one question
If something you cannot work out changes what the job is, ask exactly one question, together with the brief. Do not ask about anything you can find in the code or `operant prime`, and do not ask a second one.

## 3. Show it and wait
Print the brief and say where "send it" goes: **a Claude tile** (Claude plans it and uses its own subagents) or **team work** (one master runs numbered parts as subagents on their tiers; needs team mode on). The default is a Claude tile, unless `operant prime` says refined prompts go to team work; the user can pick either each time.

Then stop. Send nothing until the user answers yes, "send it" or similar. An edit ("drop the last line", "also mention X") is applied exactly, and you show the brief again. Silence, a question back or "maybe" is not a yes.

## 4. Send it
Write the approved brief to a file in the temp folder (not in the project) and send it. If you cannot write a file, pass a short brief as text instead: `operant send --brief "<text>"` (the same flags apply):

- `operant send --file <brief file>` to the project's lead Claude tile. It opens one if none is running.
- `operant send <tile id> --file <brief file>` for a tile the user named; `--new` for a fresh Claude tile.
- `operant send --team --file <brief file>` as team work. With team mode off it is refused with "turn on team mode": tell the user, and do not resend it as a plain send unless they ask.

The send returns at once. A busy tile is never interrupted: the brief waits until it is idle, and the output says so. Tell the user in one line where it went and whether it is waiting. Do not poll the tile or type into it, and delete the temp file.

## Rules
- The receiving tile sees it as from another agent on the user's behalf. It cannot approve anything, so permission prompts still reach the user. Never word a brief as if the user approved something they did not.
- Refining is not doing: do not start the task yourself.
