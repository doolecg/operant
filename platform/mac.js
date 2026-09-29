// macOS only: the app menu, the Dock menu, where browsers and IDEs install, and Claude Code's login
// in the Keychain.

const { app, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Without an Edit menu, Cmd+C/V/X/A do nothing in text boxes, and without the app menu there's no Cmd+Q.
function setAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}
function setDockMenu(newWindow) {
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: newWindow }]));
}

const appDirs = ['/Applications', path.join(os.homedir(), 'Applications')];
const inApps = (...rel) => appDirs.map(d => path.join(d, ...rel));

// [id, name, bundle names]. Ids match the Windows list, so a saved choice carries over.
const BROWSERS = [
  ['zen', 'Zen', ['Zen.app', 'Zen Browser.app']], ['firefox', 'Firefox', ['Firefox.app']],
  ['chrome', 'Chrome', ['Google Chrome.app']], ['edge', 'Edge', ['Microsoft Edge.app']],
  ['brave', 'Brave', ['Brave Browser.app']], ['vivaldi', 'Vivaldi', ['Vivaldi.app']], ['opera', 'Opera', ['Opera.app']],
  ['floorp', 'Floorp', ['Floorp.app']], ['librewolf', 'LibreWolf', ['LibreWolf.app']], ['safari', 'Safari', ['Safari.app']],
];
// The .app bundle is the "exe": main.js opens links in it with `open -a`.
async function detectBrowsers() {
  const found = [];
  for (const [id, name, bundles] of BROWSERS) {
    const exe = bundles.flatMap(b => inApps(b)).find(p => fs.existsSync(p));
    if (exe) found.push({ id, name, exe });
  }
  return found;
}

// The command-line launchers inside each IDE's bundle, for when its shell command isn't installed.
const toolbox = name => path.join(os.homedir(), 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts', name);
const IDE_PATHS = {
  code: () => inApps('Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
  cursor: () => inApps('Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor'),
  windsurf: () => inApps('Windsurf.app', 'Contents', 'Resources', 'app', 'bin', 'windsurf'),
  zed: () => inApps('Zed.app', 'Contents', 'MacOS', 'cli'),
  idea: () => [toolbox('idea'), ...['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'].flatMap(a => inApps(a, 'Contents', 'MacOS', 'idea'))],
  rider: () => [toolbox('rider'), ...inApps('Rider.app', 'Contents', 'MacOS', 'rider')],
  subl: () => inApps('Sublime Text.app', 'Contents', 'SharedSupport', 'bin', 'subl'),
};

// Claude Code keeps its login in the Keychain on macOS. Reading it shows macOS's own prompt once
// ("Always Allow" ends that); a refusal isn't asked again until the usage pill is clicked.
let keychainRefused = false;
function claudeToken(force) {
  if (keychainRefused && !force) return Promise.resolve({ refused: true });
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 60000 }, (err, stdout) => {
      // 44: no such item, so not signed in (not a refusal).
      if (err) { keychainRefused = err.code !== 44; return resolve(keychainRefused ? { refused: true } : {}); }
      keychainRefused = false;
      try { resolve({ token: JSON.parse(stdout).claudeAiOauth?.accessToken }); } catch { resolve({}); }
    });
  });
}

module.exports = { setAppMenu, setDockMenu, detectBrowsers, IDE_PATHS, claudeToken };
