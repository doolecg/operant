# Idea Shelf

Park ideas while Claude works, without pulling it off the task. Each project has its own shelf. Ideas are saved in the plugin store, so they stay after you close Claude Code.

Commands:
- `/idea <text>` parks an idea on the current project's shelf. It does not start a turn and is not sent to the model. It runs during a turn too.
- `/idea edit <n> <text>` replaces idea number n (the order in `/ideas`). The idea keeps its place.
- `/ideas` opens the Idea Shelf pane. Each idea has Send, Edit and Delete buttons.
- Send submits the idea as your own prompt, as if you had typed it. If Claude is working, the prompt is queued and runs when the session is idle. The idea leaves the shelf once it is submitted.
- Edit shows the idea in a text field with Save and Cancel. Enter also saves. Save with empty text is refused.
- Delete removes the idea.

Limits:
- Ideas are kept per project folder, matched case-insensitively, and a subfolder has its own shelf.
- Ideas are stored in the plugin store, which is shared by all sessions on this machine. The pane refreshes when this session draws it.
- The edit field is not available on mobile surfaces; there Edit is replaced by a note.
- `/idea edit ...` is read as an edit, so an idea whose text begins with "edit <number>" must be parked another way.
- Each idea is up to 2000 characters.
