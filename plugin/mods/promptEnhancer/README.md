# Prompt Enhancer

Rewrites a rough prompt in the prompt bar before Claude runs it.

Commands and marks:
- `/enhance <rough prompt>` rewrites the text you give it.
- Start a prompt with `++ ` and press Enter. The prompt is held, rewritten, and shown in the band above the prompt.

The rewrite has three parts: the cleaned task, `Load these skills:` (from `~/.claude/skills/*/SKILL.md` and the plugin skills listed by `/` commands), `Ask me first about:` (the big decisions), and `Done when:` (what the finished result looks like).

Review in the band: Use sends the rewrite as your prompt, Edit puts it in the box for changes, Cancel puts your original text back in the box. Nothing is sent without one of these.

Limits:
- Uses the Haiku model with a 900-token reply cap and a 30 s timeout. Each session stops after 20 rewrites or 120k tokens.
- Only prompts marked with `++ ` or sent through `/enhance` are rewritten.
- If `~/.claude/skills` cannot be read the rewrite says so in its skills list and continues.
- If the rewrite fails, your text is put back in the box where the engine allows it, and a toast says whether it was.
- Rewrites are not cached between sessions.
