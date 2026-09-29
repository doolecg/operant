// Linux only: where browsers and IDEs install when their command isn't on PATH (Flatpak, Snap,
// JetBrains Toolbox).

const fs = require('fs');
const os = require('os');
const path = require('path');
const unix = require('./unix');

const home = os.homedir();
const flatpak = id => ['/var/lib/flatpak/exports/bin', path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin')].map(d => path.join(d, id));

// [id, name, commands, Flatpak app id]. Ids match the Windows list, so a saved choice carries over.
const BROWSERS = [
  ['zen', 'Zen', ['zen', 'zen-browser'], 'app.zen_browser.zen'], ['firefox', 'Firefox', ['firefox'], 'org.mozilla.firefox'],
  ['chrome', 'Chrome', ['google-chrome', 'google-chrome-stable'], 'com.google.Chrome'],
  ['chromium', 'Chromium', ['chromium', 'chromium-browser'], 'org.chromium.Chromium'],
  ['edge', 'Edge', ['microsoft-edge', 'microsoft-edge-stable'], 'com.microsoft.Edge'],
  ['brave', 'Brave', ['brave-browser', 'brave'], 'com.brave.Browser'], ['vivaldi', 'Vivaldi', ['vivaldi', 'vivaldi-stable'], 'com.vivaldi.Vivaldi'],
  ['opera', 'Opera', ['opera'], 'com.opera.Opera'], ['floorp', 'Floorp', ['floorp'], 'one.ablaze.floorp'],
  ['librewolf', 'LibreWolf', ['librewolf'], 'io.gitlab.librewolf-community'],
];
async function detectBrowsers(env) {
  const found = [];
  for (const [id, name, cmds, fp] of BROWSERS) {
    let exe = null;
    for (const c of cmds) if (!exe) exe = await unix.which(c, env);
    exe ??= flatpak(fp).find(p => fs.existsSync(p));
    if (exe) found.push({ id, name, exe });
  }
  return found;
}

const toolbox = name => path.join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts', name);
const IDE_PATHS = {
  code: () => ['/usr/share/code/bin/code', '/snap/bin/code', ...flatpak('com.visualstudio.code')],
  cursor: () => ['/usr/share/cursor/bin/cursor', '/opt/cursor/cursor', '/opt/Cursor/cursor'],
  windsurf: () => ['/usr/share/windsurf/bin/windsurf'],
  zed: () => [path.join(home, '.local', 'bin', 'zed'), ...flatpak('dev.zed.Zed')],
  idea: () => [toolbox('idea'), '/snap/bin/intellij-idea-ultimate', '/snap/bin/intellij-idea-community', ...flatpak('com.jetbrains.IntelliJ-IDEA-Community')],
  rider: () => [toolbox('rider'), '/snap/bin/rider'],
  subl: () => ['/opt/sublime_text/sublime_text', '/snap/bin/subl', ...flatpak('com.sublimetext.three')],
};

module.exports = { detectBrowsers, IDE_PATHS };
