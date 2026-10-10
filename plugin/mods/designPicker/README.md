# Design Picker

When Claude asks you to choose a design style (an AskUserQuestion call whose
question or options are about looks), this mod:

- writes a self-contained gallery page to the OS temp folder
  (`claude-design-picker.html`, overwritten each time) and opens it in your
  browser. Known styles (minimal, brutalist, glassmorphism, neumorphism,
  material, flat, skeuomorphic, dark, light, retro, editorial, bento,
  corporate) get a CSS-rendered sample; any other option gets a neutral card
  with its text.
- shows the options in the band above the prompt, with a "Reopen preview"
  button.

It never answers the question and never delays it: the tool call is passed
on unchanged. Pick in Claude's question as usual.

## Limits

- Detection is by words: "design", "style", "theme", "aesthetic", "visual
  style", "look and feel", "color scheme", "layout" in the question or header,
  or two or more options that name a known style.
- Opening uses `cmd /c start` on Windows and `open` / `xdg-open` elsewhere. If
  the opener fails, a toast gives the file path.
- Needs a temp folder (`TEMP` or `TMPDIR`). Without one there is no preview,
  and a toast says so.
- No commands, no settings, no model calls.

## Load

    claude --plugin-dir F:\PROGRAMMING\REPOS\Operant2\plugin\mods\designPicker

Tests: `claude plugin test <this folder>`.
