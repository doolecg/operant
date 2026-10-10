# Plain-English Claude Code

Makes Claude's replies plainer, and shows what the session is doing.

## What it does

- **Rules in the system prompt.** One short session section: simple words and
  short sentences; little narration of the work; all prose in one final block
  headed "Summary"; a "Next steps" section at the end.
- **Status line** under the prompt: `Working on: <first words of your prompt>`,
  then `(running <tool>)` while a tool runs. Cleared when the turn ends.
- **Haiku check after a turn.** When the main reply is at least 400 characters,
  one `haiku` completion (effort low, 40 tokens out, 15 s limit) checks the
  reply against the four rules and answers PASS or FAIL with the rule missed.
  The result shows in the band above the prompt as `Plain-English: ok` or
  `Plain-English: missed: <rule>`. A miss also raises a toast.
- The reply itself is never edited.

## Limits

- The check is a model's judgement, not a parser. It can miss a rule or flag a
  reply that is fine.
- At most 25 checks per session and 150,000 tokens of check usage. After that
  the band keeps the last verdict and no more checks run.
- Subagent turns are not checked, and their status is not shown.
- A reply that was aborted or ended on an error is not checked.
- The rules are not enforced: the model is asked, and this mod only reports.

## Load

    claude --plugin-dir F:\PROGRAMMING\REPOS\Operant2\plugin\mods\plainEnglish

Tests: `claude plugin test <this folder>`.
