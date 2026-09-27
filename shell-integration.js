// Explorer right-click entry: "Open in Operant" on folders, folder backgrounds
// and drives. Written to HKCU (no admin) on every packaged start so the command always
// points at the current install. The key name sorts right after Windows' "Powershell"
// entry, which puts it directly under "Open PowerShell window here".

const { execFile } = require('child_process');

const KEY_NAME = 'PowershellOperant';
const LABEL = 'Open in Operant';
const ROOTS = [
  ['Directory\\Background\\shell', '%V'],
  ['Directory\\shell', '%1'],
  ['Drive\\shell', '%1'],
];

const reg = args => new Promise(resolve => execFile('reg.exe', args, { windowsHide: true }, err => resolve(!err)));

async function register(exePath) {
  for (const [root, arg] of ROOTS) {
    const key = `HKCU\\Software\\Classes\\${root}\\${KEY_NAME}`;
    await reg(['add', key, '/ve', '/d', LABEL, '/f']);
    await reg(['add', key, '/v', 'Icon', '/d', `"${exePath}",0`, '/f']);
    await reg(['add', `${key}\\command`, '/ve', '/d', `"${exePath}" "${arg}"`, '/f']);
  }
}

async function unregister() {
  for (const [root] of ROOTS) await reg(['delete', `HKCU\\Software\\Classes\\${root}\\${KEY_NAME}`, '/f']);
}

module.exports = { register, unregister, LABEL };
