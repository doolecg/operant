// Auto-update from GitHub releases. electron-updater can't update MSI installs, so this
// does it directly: find a newer release, download the installer for this system, then hand
// it to a worker that installs it once we've quit and relaunches. Windows: the .msi via
// msiexec (a major upgrade over the installed version). macOS: the .dmg's app is swapped in
// for the running one. Linux: the AppImage is replaced in place, or the .deb goes in via pkexec.

const { app, net } = require('electron');
const { spawn, spawnSync } = require('child_process');
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

const EXT = { msi: 'msi', dmg: 'dmg', appimage: 'AppImage', deb: 'deb' };

// The installer this copy can apply to itself, or null (an unpacked or tarball run can't).
function installKind({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform === 'win32') return 'msi';
  if (platform === 'darwin') return 'dmg';
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : execPath.startsWith('/opt/Operant/') ? 'deb' : null;
  return null;
}

// The release asset to download (electron-builder's artifact names), or null. Windows takes the first
// .msi so `Operant-<v>.msi` and `Operant-<v>-windows-x64.msi` both match.
function pickAsset(assets, { platform, arch, kind }) {
  const find = (ext, tags) => assets.find(a => {
    const n = a.name.toLowerCase();
    return n.endsWith(ext) && (!tags || tags.some(t => n.includes(t)));
  }) || null;
  if (platform === 'win32') return find('.msi');
  if (platform === 'darwin') return find('.dmg', [`-mac-${arch}`]);
  if (platform === 'linux' && kind === 'appimage') return find('.appimage', { x64: ['x86_64'], arm64: ['arm64', 'aarch64'] }[arch] || []);
  if (platform === 'linux' && kind === 'deb') return find('.deb', { x64: ['amd64'], arm64: ['arm64'] }[arch] || []);
  return null;
}

// Reuse a finished download only if it's ours: os.tmpdir() is shared on Linux, and a same-sized file
// someone else left there would otherwise be installed (the .deb as root).
function downloaded(file, size) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size === size && (!process.getuid || st.uid === process.getuid());
  } catch { return false; }
}

// The macOS and Linux installs are /bin/sh workers. Each logs to a file, waits up to 60 s for Operant
// (pid) to exit, then swaps the new version in and, when asked, relaunches.
const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const workerHead = (pid, log) => [
  `exec >>${shQuote(log)} 2>&1`,
  `say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }`,
  `say "waiting for Operant (pid ${Number(pid)}) to exit"`,
  `n=0`,
  `while kill -0 ${Number(pid)} 2>/dev/null; do`,
  `  n=$((n+1))`,
  `  if [ "$n" -gt 60 ]; then say "Operant is still running, leaving the update for the next quit"; exit 1; fi`,
  `  sleep 1`,
  `done`,
];

function macInstallScript({ pid, dmg, bundle, log, relaunch }) {
  return [
    ...workerHead(pid, log),
    `dmg=${shQuote(dmg)}`,
    `bundle=${shQuote(bundle)}`,
    `mnt=$(mktemp -d) || exit 1`,
    // The new app is copied beside the old one first, so a failed copy leaves the old one alone and the swap is two renames.
    `swap() {`,
    `  rm -rf "$bundle.new" "$bundle.old"`,
    `  ditto "$mnt/Operant.app" "$bundle.new" || { rm -rf "$bundle.new"; return 1; }`,
    `  mv "$bundle" "$bundle.old" || { rm -rf "$bundle.new"; return 1; }`,
    `  mv "$bundle.new" "$bundle" || { mv "$bundle.old" "$bundle"; rm -rf "$bundle.new"; return 1; }`,
    `  rm -rf "$bundle.old"`,
    `}`,
    `ok=`,
    `say "mounting $dmg"`,
    `if hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg"; then`,
    `  if swap; then ok=1; say "replaced $bundle"; else say "update failed, the old app is still in place"; fi`,
    `  hdiutil detach "$mnt" || hdiutil detach -force "$mnt"`,
    `else`,
    `  say "could not mount $dmg"`,
    `fi`,
    `rmdir "$mnt"`,
    `if [ -n "$ok" ]; then xattr -dr com.apple.quarantine "$bundle"; fi`,
    ...(relaunch ? [`open "$bundle"`] : []),
    `say done`,
  ].join('\n');
}

function appImageInstallScript({ pid, appImage, target, log, relaunch }) {
  return [
    ...workerHead(pid, log),
    `src=${shQuote(appImage)}`,
    `target=${shQuote(target)}`,
    // Copy beside the target, then rename over it: the swap is atomic and a failed copy leaves the old AppImage alone.
    `if cp "$src" "$target.new" && chmod 755 "$target.new" && mv -f "$target.new" "$target"; then`,
    `  say "replaced $target"`,
    `else`,
    `  say "could not replace $target"; rm -f "$target.new"`,
    `fi`,
    ...(relaunch ? [`nohup "$target" >/dev/null 2>&1 &`] : []),
  ].join('\n');
}

function debInstallScript({ pid, deb, exe, log, relaunch }) {
  return [
    ...workerHead(pid, log),
    `deb=${shQuote(deb)}`,
    `exe=${shQuote(exe)}`,
    `say "installing $deb"`,
    `pkexec dpkg -i "$deb"`,
    `say "dpkg exited with $?"`,
    ...(relaunch ? [`nohup "$exe" >/dev/null 2>&1 &`] : []),
  ].join('\n');
}

function createUpdater({ send, onInstall, currentVersion = app.getVersion() }) {
  let ready = null;      // { version, file, notes, url, kind }
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
      const kind = installKind();
      if (!kind) { report({ state: 'error', message: `${version} is out, get it from the releases page` }); return; }
      // Keep checking once one is downloaded: a stale ready update must not be installed over a newer release.
      // The download is fetched again if the temp folder lost it (macOS clears it after a few days).
      if (ready && !newer(version, ready.version) && fs.existsSync(ready.file)) { report({ state: 'ready', version: ready.version, notes: ready.notes, url: ready.url }); return; }
      const asset = pickAsset(rel.assets, { platform: process.platform, arch: process.arch, kind });
      if (!asset) { report({ state: 'error', message: `${version} has no installer for this system yet, try again in a few minutes` }); return; }

      const file = path.join(os.tmpdir(), `Operant-${version}.${EXT[kind]}`);
      if (!downloaded(file, asset.size)) {
        report({ state: 'downloading', version, notes: rel.body || '' });
        const dl = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'operant' } });
        if (!dl.ok) throw new Error(`download ${dl.status}`);
        const tmp = file + '.part';
        await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp));
        if (fs.statSync(tmp).size !== asset.size) throw new Error('download size mismatch');
        fs.renameSync(tmp, file);
      }
      ready = { version, file, notes: rel.body || '', url: rel.html_url, kind };
      report({ state: 'ready', version, notes: ready.notes, url: rel.html_url });
    } catch (e) {
      report({ state: 'error', message: String(e.message || e) });
    } finally {
      busy = false;
    }
  }

  // macOS and Linux: a detached /bin/sh worker (the *InstallScript builders) outlives us, waits for us
  // to exit, puts the new version in place and relaunches. Anything that can't be replaced in place is
  // reported before we quit, so the user isn't left with a restart that changed nothing.
  function installUnix(relaunch) {
    const { kind, version, file } = ready;
    const fail = message => { report({ state: 'error', message }); return false; };
    const writable = dir => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
    const log = path.join(os.tmpdir(), `Operant-${version}-install.log`);
    let script;
    if (kind === 'dmg') {
      const bundle = path.resolve(process.execPath, '../../..');
      // From the mounted dmg, or Gatekeeper's read-only translocated copy, there is nothing to replace in place.
      if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return fail('Move Operant to Applications, then update');
      if (!writable(path.dirname(bundle))) return fail(`Can't write to ${path.dirname(bundle)}, move Operant to a folder you can write to, then update`);
      script = macInstallScript({ pid: process.pid, dmg: file, bundle, log, relaunch });
    } else if (kind === 'appimage') {
      const target = path.resolve(process.env.APPIMAGE);
      if (!writable(path.dirname(target))) return fail(`Can't write to ${path.dirname(target)}, move the AppImage to a folder you can write to, then update`);
      script = appImageInstallScript({ pid: process.pid, appImage: file, target, log, relaunch });
    } else {
      if (!relaunch) return false; // dpkg needs a password, which mustn't be asked for after the app has gone
      if (spawnSync('/bin/sh', ['-c', 'command -v pkexec'], { stdio: 'ignore' }).status !== 0) return fail(`pkexec not found, install ${file} with your package manager`);
      script = debInstallScript({ pid: process.pid, deb: file, exe: process.execPath, log, relaunch });
    }
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
    child.on('error', e => report({ state: 'error', message: `couldn't start the installer (${e.message})` }));
    child.unref();
    if (!child.pid) return false;
    installing = true;
    onInstall?.();
    return true;
  }

  // A worker PowerShell waits for us to close, runs msiexec, then optionally relaunches.
  // It must outlive us, and Node can't start it directly: with `detached` (DETACHED_PROCESS)
  // powershell.exe exits without running anything, and without it the child dies with us.
  // So a short-lived launcher starts the worker via Start-Process (its own console, not our
  // child), and we wait for the launcher before quitting.
  function install(relaunch) {
    if (!ready || installing) return false;
    if (ready.kind !== 'msi') return installUnix(relaunch);
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
    // Never a deb: its install asks for a password.
    app.on('will-quit', () => { if (ready && ready.kind !== 'deb' && !installing && app.isPackaged) install(false); });
  }

  return { start, check, install: () => install(true), get ready() { return ready; }, get status() { return status; } };
}

module.exports = { createUpdater, newer, pickAsset, installKind, shQuote, macInstallScript, appImageInstallScript, debInstallScript };
