// The OS this window runs on (preload's process.platform), shared by every renderer script.
const PLATFORM = operant.platform, IS_WIN = PLATFORM === 'win32', IS_MAC = PLATFORM === 'darwin';
// Separator for the paths built here. Paths from main come in the OS's own form; git's are relative and use '/'.
const SEP = IS_WIN ? '\\' : '/';
// Cmd on macOS, Ctrl elsewhere: the modifier for app shortcuts that aren't terminal keys.
const MOD = IS_MAC ? 'Cmd' : 'Ctrl';
const ctrlOrCmd = e => e.ctrlKey || (IS_MAC && e.metaKey);
document.body.classList.add('os-' + PLATFORM);
