// Auto-update from GitHub releases. electron-updater can't update MSI installs, so this
// does it directly: find a newer release, download its .msi, then hand it to msiexec
// (a major upgrade over the installed version) and relaunch.

const { app, net } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'doolecg/operant';
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

function newer(a, b) { // is version a > b
  const pa = a.replace(/^v/, '').split(/[.-]/).map(Number), pb = b.replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function createUpdater({ send, onInstall, currentVersion = app.getVersion() }) {
  let ready = null;      // { version, file, notes }
  let busy = false;
  let installing = false;
  let status = null;     // the last thing reported, for the Settings › Updates tab
  const report = s => { status = { ...s, at: Date.now() }; send('update:status', status); };

  async function check() {
    if (busy || installing) return;
    busy = true;
    report({ state: 'checking' });
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'operant', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const rel = await res.json();
      const version = rel.tag_name.replace(/^v/, '');
      if (!newer(version, currentVersion)) { report({ state: 'current', version: currentVersion, notes: version === currentVersion ? rel.body || '' : '' }); return; }
      // Keep checking once one is downloaded: a stale ready update must not be installed over a newer release.
      if (ready && !newer(version, ready.version)) { report({ state: 'ready', version: ready.version, notes: ready.notes, url: ready.url }); return; }
      const asset = rel.assets.find(a => a.name.toLowerCase().endsWith('.msi'));
      if (!asset) { report({ state: 'error', message: `${version} has no installer yet, try again in a few minutes` }); return; }

      const file = path.join(os.tmpdir(), `Operant-${version}.msi`);
      if (!fs.existsSync(file) || fs.statSync(file).size !== asset.size) {
        report({ state: 'downloading', version, notes: rel.body || '' });
        const dl = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'operant' } });
        if (!dl.ok) throw new Error(`download ${dl.status}`);
        const tmp = file + '.part';
        await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp));
        if (fs.statSync(tmp).size !== asset.size) throw new Error('download size mismatch');
        fs.renameSync(tmp, file);
      }
      ready = { version, file, notes: rel.body || '', url: rel.html_url };
      report({ state: 'ready', version, notes: ready.notes, url: rel.html_url });
    } catch (e) {
      report({ state: 'error', message: String(e.message || e) });
    } finally {
      busy = false;
    }
  }

  // A worker PowerShell waits for us to close, runs msiexec, then optionally relaunches.
  // It must outlive us, and Node can't start it directly: with `detached` (DETACHED_PROCESS)
  // powershell.exe exits without running anything, and without it the child dies with us.
  // So a short-lived launcher starts the worker via Start-Process (its own console, not our
  // child), and we wait for the launcher before quitting.
  function install(relaunch) {
    if (!ready || installing) return false;
    const q = s => s.replace(/'/g, "''");
    const exe = process.execPath;
    const log = path.join(os.tmpdir(), `Operant-${ready.version}-install.log`);
    const worker = [
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      // Electron helpers and node-pty's console hosts can outlive the main process briefly.
      `$dir = '${q(path.dirname(exe))}\\'`,
      // msiexec over files still in use fails halfway through the upgrade and leaves the install
      // folder gutted, so if anything from it is still running, skip this time (the next quit retries).
      `$ours = { Get-Process | Where-Object { try { $_.Path -and $_.Path.StartsWith($dir, 'OrdinalIgnoreCase') } catch { $false } } }`,
      `& $ours | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue`,
      // 1618: another install is running. Wait for it rather than giving up.
      `if (-not (& $ours)) { for ($i = 0; $i -lt 40; $i++) {`,
      `  $p = Start-Process msiexec.exe -ArgumentList '/i "${q(ready.file)}" ${relaunch ? '/passive' : '/qn'} /norestart /l*v "${q(log)}"' -Wait -PassThru`,
      `  if ($p.ExitCode -ne 1618) { break }`,
      `  Start-Sleep -Seconds 15`,
      `} }`,
      relaunch ? `Start-Process -FilePath '${q(exe)}'` : '',
    ].join('\n');
    const encoded = Buffer.from(worker, 'utf16le').toString('base64');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    ], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
    if (r.status !== 0) {
      report({ state: 'error', message: `couldn't start the installer (${r.error ? r.error.message : `exit ${r.status}`})` });
      return false;
    }
    installing = true;
    onInstall?.();
    return true;
  }

  function start() {
    if ((!app.isPackaged || process.env.OPERANT_USER_DATA) && !process.env.OPERANT_UPDATE_TEST) return;
    setTimeout(check, 5000);
    setInterval(check, CHECK_EVERY_MS);
    // Like electron-updater's autoInstallOnAppQuit: a downloaded update goes in when the app closes.
    app.on('will-quit', () => { if (ready && !installing && app.isPackaged) install(false); });
  }

  return { start, check, install: () => install(true), get ready() { return ready; }, get status() { return status; } };
}

module.exports = { createUpdater, newer };
