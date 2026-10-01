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
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const REPO = 'doolecg/operant';
const DEFAULT_CHECK_HOURS = 3;

// updateCheckHours: whole hours 1-24 between checks; 0 = only at startup and by hand. Anything else is the default.
function checkIntervalMs(hours) {
  const h = Number(hours);
  if (hours === '' || hours == null || !Number.isFinite(h)) return DEFAULT_CHECK_HOURS * 3600000;
  return Math.min(24, Math.max(0, Math.round(h))) * 3600000;
}

function newer(a, b) { // is version a > b
  const pa = a.replace(/^v/, '').split(/[.-]/).map(Number), pb = b.replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// The release to offer from GitHub's release list. stable: the newest non-prerelease; beta: the highest version, prereleases
// included. Drafts never count; on a tie the earlier entry (GitHub lists newest first) wins.
function pickRelease(releases, channel) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || typeof r.tag_name !== 'string') continue;
    if (channel !== 'beta' && r.prerelease) continue;
    if (!best || newer(r.tag_name, best.tag_name)) best = r;
  }
  return best;
}

const EXT = { msi: 'msi', dmg: 'dmg', appimage: 'AppImage', deb: 'deb' };

// Downloads come from GitHub only: the release page host, and the hosts its asset links redirect to.
function allowedDownloadUrl(url) {
  return /^https:\/\/(github\.com|objects\.githubusercontent\.com|github-releases\.githubusercontent\.com)\//.test(String(url));
}

// Where a system package puts the app: /opt/Operant, /usr/lib/operant, /usr/share/operant (any letter case).
const SYSTEM_DIR = /^\/(opt|usr\/lib|usr\/share)\/operant\//i;
// Which package manager owns this file: 'rpm' | 'deb' | null (neither tool exists, or neither knows it: a tar.gz unpacked there).
function packageOwner(file) {
  const owns = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'ignore' }); return !r.error && r.status === 0; };
  const has = cmd => { const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return r.status === 0; };
  if (has('rpm') && owns('rpm', ['-qf', file])) return 'rpm';
  if (has('dpkg') && owns('dpkg', ['-S', file])) return 'deb';
  return null;
}

// The installer this copy can apply to itself, or null (an unpacked run can't). 'rpm' and 'tar' installs are
// announced only: the release link is shown and the update is left to the package manager or the user.
function installKind({ platform = process.platform, env = process.env, execPath = process.execPath, owner = packageOwner } = {}) {
  if (platform === 'win32') return 'msi';
  if (platform === 'darwin') return 'dmg';
  if (platform === 'linux') {
    if (env.APPIMAGE) return 'appimage';
    if (!SYSTEM_DIR.test(execPath)) return null;
    const o = owner(execPath);
    if (o === 'rpm') return 'rpm';
    return o === 'deb' ? 'deb' : 'tar'; // no package owns it: a tar.gz unpacked into a system folder
  }
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

// The command to give the user when pkexec is missing or fails (apt reads a path as a file, and resolves dependencies).
const debInstallCommand = deb => `sudo apt install ${/^[\w@%+=:,./-]+$/.test(deb) ? deb : shQuote(deb)}`;

// sha256: the digest GitHub listed, checked again right before pkexec (the file sat on disk since the download).
function debInstallScript({ pid, deb, exe, log, relaunch, sha256 }) {
  return [
    ...workerHead(pid, log),
    `deb=${shQuote(deb)}`,
    `exe=${shQuote(exe)}`,
    ...(sha256 ? [
      `got=$(sha256sum "$deb" 2>/dev/null | cut -d' ' -f1)`,
      `if [ "$got" != ${shQuote(String(sha256).toLowerCase())} ]; then say "the downloaded file changed, not installing it"; exit 1; fi`,
    ] : []),
    `say "installing $deb"`,
    `pkexec dpkg -i "$deb"`,
    `rc=$?`,
    `say "dpkg exited with $rc"`,
    `if [ "$rc" -ne 0 ]; then say ${shQuote(`To install it yourself, run: ${debInstallCommand(deb)}`)}; fi`,
    ...(relaunch ? [`nohup "$exe" >/dev/null 2>&1 &`] : []),
  ].join('\n');
}

// GitHub's asset JSON may carry `digest: "sha256:<hex>"`. Resolves true when the file matches it, false when there is
// nothing to check (no digest, or an algorithm other than sha256), and throws when the file differs.
async function verifyDigest(file, digest) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''));
  if (!m) return false;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', resolve));
  if (hash.digest('hex') !== m[1].toLowerCase()) throw new Error('download digest mismatch');
  return true;
}

// userData/update-history.json: one entry per install, {from, to, at, asset, digestChecked, backup, result, attempts},
// newest last, the last HISTORY_MAX kept. result: 'installing' until the new version has started properly.
const HISTORY_MAX = 50;
const trimHistory = list => (Array.isArray(list) ? list : []).slice(-HISTORY_MAX);
function historyStore(file) {
  const read = () => { try { return trimHistory(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return []; } };
  const write = list => writeFileAtomic(file, JSON.stringify(trimHistory(list), null, 2));
  return {
    read,
    add(entry) { const list = read(); list.push(entry); write(list); return entry; },
    // Change the newest entry (the install in flight).
    updateLast(fn) { const list = read(); if (!list.length) return null; fn(list[list.length - 1]); write(list); return list[list.length - 1]; },
  };
}

// What to do at launch: 'none', 'check' (the new version's first tries: it must reach a healthy start), or
// 'offer-rollback' (it already failed to get there twice).
function healthState(history, version) {
  const e = Array.isArray(history) && history[history.length - 1];
  if (!e || e.result !== 'installing' || e.to !== version) return 'none';
  return (e.attempts || 0) >= 2 ? 'offer-rollback' : 'check';
}

// getSettings() -> { updateChannel, updateCheckHours }. fetch, downloadDir, statfs and target are injection points for tests.
function createUpdater({ send, onInstall, beforeInstall, log = () => {}, historyFile, currentVersion = app.getVersion(), getSettings = () => ({}),
  fetch = (url, ...a) => {
    // Only GitHub's API and download hosts are ever contacted.
    if (!allowedDownloadUrl(url) && !/^https:\/\/api\.github\.com\//.test(String(url))) return Promise.reject(new Error(`refusing to download from ${url}`));
    return net.fetch(url, ...a);
  }, downloadDir = null, statfs = fs.statfsSync, target = null }) {
  const history = historyStore(historyFile || path.join(app.getPath('userData'), 'update-history.json'));
  let ready = null;      // { version, file, notes, url, kind }
  let busy = false;
  let installing = false;
  let status = null;     // the last thing reported, for the Settings › General › Updates tab
  let info = {};         // { checkedAt, latest, channel } of the last check, carried on every status
  let timer = null, started = false;
  const report = s => { status = { ...info, ...s, at: Date.now() }; send('update:status', status); };
  const targetNow = () => target || { platform: process.platform, arch: process.arch, kind: installKind() };

  // Needs twice the download free in its folder (the file, then room to install from). Skipped when the OS can't say.
  function checkDiskSpace(dir, size, version) {
    if (typeof statfs !== 'function') return;
    let free;
    try { const st = statfs(dir); free = Number(st.bavail) * Number(st.bsize); } catch { return; }
    if (!Number.isFinite(free) || free >= size * 2) return;
    const mb = n => Math.ceil(n / 1048576);
    throw new Error(`Not enough disk space to download Operant ${version} (needs ${mb(size * 2)} MB, ${Math.floor(free / 1048576)} MB free in ${dir}). Nothing was changed.`);
  }

  // Downloads an asset to the temp folder (reusing a finished copy of ours), checks its size and, when GitHub
  // lists one, its sha256; a bad file is deleted.
  // A .deb is installed as root, so it goes in a private folder (0700) under userData, not the shared temp folder.
  function dirFor(kind) {
    if (downloadDir) return downloadDir;
    if (kind !== 'deb') return os.tmpdir();
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  }

  async function fetchAsset(asset, version, kind, onDownload) {
    // Nothing is installed that GitHub did not publish a checksum for.
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || ''))) throw new Error(`${asset.name} has no sha256 checksum on its GitHub release, so Operant won't install it automatically. Download it from the releases page instead.`);
    const dir = dirFor(kind);
    const file = path.join(dir, `Operant-${version}.${EXT[kind]}`);
    if (!downloaded(file, asset.size)) {
      checkDiskSpace(dir, asset.size, version);
      onDownload?.();
      const tmp = file + '.part';
      try {
        const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'operant' } });
        if (!dl.ok) throw new Error(`download ${dl.status}`);
        if (dl.url && !allowedDownloadUrl(dl.url)) throw new Error('the download was redirected away from GitHub');
        await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(tmp));
        if (fs.statSync(tmp).size !== asset.size) throw new Error('download size mismatch');
        fs.renameSync(tmp, file);
      } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    }
    try { return { file, digestChecked: await verifyDigest(file, asset.digest) }; } catch (e) {
      try { fs.unlinkSync(file); } catch {}
      throw e;
    }
  }

  async function check() {
    if (busy || installing) return;
    busy = true;
    report({ state: 'checking' });
    try {
      const channel = getSettings().updateChannel === 'beta' ? 'beta' : 'stable';
      info = { ...info, checkedAt: Date.now(), channel };
      // stable is GitHub's own "latest" (no prereleases); beta is the newest of the recent releases, prereleases included.
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases${channel === 'beta' ? '?per_page=10' : '/latest'}`, {
        headers: { 'User-Agent': 'operant', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const body = await res.json();
      const rel = channel === 'beta' ? pickRelease(body, 'beta') : body;
      if (!rel) throw new Error('no releases found');
      const version = rel.tag_name.replace(/^v/, '');
      info = { ...info, latest: version };
      if (!newer(version, currentVersion)) { report({ state: 'current', version: currentVersion, notes: version === currentVersion ? rel.body || '' : '' }); return; }
      const { platform, arch, kind } = targetNow();
      if (!kind) { report({ state: 'error', message: `${version} is out, get it from the releases page` }); return; }
      // An rpm or tar.gz install is updated by its owner, not by Operant: announce the release and link it.
      if (kind === 'rpm' || kind === 'tar') {
        report({ state: 'error', url: rel.html_url, message: `${version} is out. ${kind === 'rpm' ? 'Update with your package manager (for example sudo dnf install the new .rpm)' : 'Download the new .tar.gz and unpack it over this install'}: ${rel.html_url}` });
        return;
      }
      // Keep checking once one is downloaded: a stale ready update must not be installed over a newer release.
      // The download is fetched again if the temp folder lost it (macOS clears it after a few days).
      if (ready && !newer(version, ready.version) && fs.existsSync(ready.file)) { report({ state: 'ready', version: ready.version, notes: ready.notes, url: ready.url }); return; }
      const asset = pickAsset(rel.assets, { platform, arch, kind });
      if (!asset) { report({ state: 'error', message: `${version} has no installer for this system yet, try again in a few minutes` }); return; }

      const { file, digestChecked } = await fetchAsset(asset, version, kind, () => report({ state: 'downloading', version, notes: rel.body || '' }));
      ready = { version, file, notes: rel.body || '', url: rel.html_url, kind, asset: asset.name, digestChecked, digest: asset.digest };
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
      if (spawnSync('/bin/sh', ['-c', 'command -v pkexec'], { stdio: 'ignore' }).status !== 0) return fail(`pkexec not found. Install it yourself by running: ${debInstallCommand(file)}`);
      // Right now, too: a file that no longer matches is deleted and not offered again.
      const want = /^sha256:([0-9a-f]{64})$/i.exec(String(ready.digest || ''))?.[1];
      if (!want || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want.toLowerCase()) {
        try { fs.unlinkSync(file); } catch {}
        ready = null;
        return fail('The downloaded update no longer matches its checksum, so it was deleted. Check for updates again');
      }
      script = debInstallScript({ pid: process.pid, deb: file, exe: process.execPath, log, relaunch, sha256: want });
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
  function installNow(relaunch) {
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

  // Every install goes through here: a state backup first (a failed one is logged and recorded but doesn't stop
  // the update), then the installer, then a history entry the next launch completes.
  function install(relaunch, { skipBackup = false, from = currentVersion } = {}) {
    if (!ready || installing) return false;
    let backup = 'none';
    if (!skipBackup && beforeInstall) {
      try { backup = beforeInstall() || 'none'; } catch (e) { backup = `error: ${e.message || e}`; log(`backup before update failed: ${e.message || e}`); }
    }
    if (!installNow(relaunch)) return false;
    try {
      history.add({ from, to: ready.version, at: new Date().toISOString(), asset: ready.asset || path.basename(ready.file), digestChecked: !!ready.digestChecked, backup, result: 'installing', attempts: 0 });
    } catch (e) { log(`update history not saved: ${e.message || e}`); }
    return true;
  }

  // The user asked to go back: the `from` release's installer is downloaded, restore() puts the settings from before
  // the update back, and it installs like an update. Nothing changes until the download has passed its checks.
  async function rollback({ from, to }, restore) {
    if (busy || installing) return { ok: false, error: 'An update is in progress' };
    busy = true;
    try {
      const kind = installKind();
      if (!kind || kind === 'rpm' || kind === 'tar') throw new Error(`${from} has to be reinstalled from the releases page`);
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/tags/${from}`, { headers: { 'User-Agent': 'operant', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const rel = await res.json();
      const asset = pickAsset(rel.assets, { platform: process.platform, arch: process.arch, kind });
      if (!asset) throw new Error(`${from} has no installer for this system`);
      const { file, digestChecked } = await fetchAsset(asset, from, kind);
      ready = { version: from, file, notes: rel.body || '', url: rel.html_url, kind, asset: asset.name, digestChecked, digest: asset.digest };
      restore?.();
      if (!install(true, { skipBackup: true, from: to })) throw new Error('could not start the installer');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      busy = false;
    }
  }

  // Every updateCheckHours (0 = never on a timer); called again when the setting changes.
  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    const ms = checkIntervalMs(getSettings().updateCheckHours);
    if (ms > 0) timer = setInterval(check, ms);
  }

  function reschedule() { if (started) schedule(); }

  function start() {
    if ((!app.isPackaged || process.env.OPERANT_USER_DATA) && !process.env.OPERANT_UPDATE_TEST) return;
    started = true;
    setTimeout(check, 5000);
    schedule();
    // Like electron-updater's autoInstallOnAppQuit: a downloaded update goes in when the app closes.
    // Never a deb: its install asks for a password.
    app.on('will-quit', () => { if (ready && ready.kind !== 'deb' && !installing && app.isPackaged) install(false); });
  }

  return { start, check, reschedule, rollback, history, install: () => install(true), get ready() { return ready; }, get status() { return status; } };
}

module.exports = { createUpdater, pickRelease, checkIntervalMs, DEFAULT_CHECK_HOURS, verifyDigest, historyStore, trimHistory, healthState, HISTORY_MAX, newer, pickAsset, installKind, shQuote, macInstallScript, appImageInstallScript, debInstallScript, debInstallCommand, allowedDownloadUrl, packageOwner };
