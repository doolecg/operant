// Pure parts of the GitHub-releases updater (ported from Operant 1's updater.js):
// version comparison, release and asset picking, and the install worker scripts.
// electron-updater can't update MSI installs, so updates are applied by these workers.
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync } from 'node:fs'

export const UPDATE_REPO = 'doolecg/operant2'
export const APP_BUNDLE = 'Operant 3.app'
// Copies installed before the rename keep the old bundle and folder names until an update replaces them.
export const APP_BUNDLES = [APP_BUNDLE, 'Operant 2.app']
export const DEB_DIRS = ['/opt/Operant 3/', '/opt/Operant 2/']
export const DEFAULT_CHECK_HOURS = 3

export type InstallKind = 'msi' | 'dmg' | 'appimage' | 'deb'
export type UpdateChannel = 'stable' | 'beta'

export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

export interface Release {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  body?: string | null
  html_url?: string
  assets: ReleaseAsset[]
}

export const EXT: Record<InstallKind, string> = { msi: 'msi', dmg: 'dmg', appimage: 'AppImage', deb: 'deb' }

// Whole hours 0-24 between checks; 0 = only at startup and by hand. Anything invalid is the default.
export function checkIntervalMs(hours: unknown): number {
  const h = Number(hours)
  if (hours === '' || hours == null || !Number.isFinite(h)) return DEFAULT_CHECK_HOURS * 3_600_000
  return Math.min(24, Math.max(0, Math.round(h))) * 3_600_000
}

// Is version a newer than b? Compares major.minor.patch; a leading "v" is ignored. A pre-release (3.0.4-dev.7) is older
// than its release (3.0.4) and newer than the dev build before it (3.0.4-dev.6).
export function newer(a: string, b: string): boolean {
  const split = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(Number), pre: pre === undefined ? null : Number(pre.split('.').pop()) || 0 }
  }
  const pa = split(a)
  const pb = split(b)
  for (let i = 0; i < 3; i++) if ((pa.nums[i] || 0) !== (pb.nums[i] || 0)) return (pa.nums[i] || 0) > (pb.nums[i] || 0)
  if (pa.pre === null || pb.pre === null) return pa.pre === null && pb.pre !== null
  return pa.pre > pb.pre
}

// stable: the newest non-prerelease; beta: the highest version, prereleases included. Drafts never count.
export function pickRelease(releases: unknown, channel: UpdateChannel): Release | null {
  let best: Release | null = null
  for (const r of Array.isArray(releases) ? (releases as Release[]) : []) {
    if (!r || r.draft || typeof r.tag_name !== 'string') continue
    if (channel !== 'beta' && r.prerelease) continue
    if (!best || newer(r.tag_name, best.tag_name)) best = r
  }
  return best
}

// The installer this copy can apply to itself, or null (an unpacked or tarball run can't).
export function installKind({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
}: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; execPath?: string } = {}): InstallKind | null {
  if (platform === 'win32') return 'msi'
  if (platform === 'darwin') return 'dmg'
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : DEB_DIRS.some((d) => execPath.startsWith(d)) ? 'deb' : null
  return null
}

const ARCH_TAGS: Record<string, string[]> = { x64: ['x64', 'x86_64', 'amd64'], arm64: ['arm64', 'aarch64'] }

// The release asset for this system, matched on extension and (except Windows) architecture.
export function pickAsset(
  assets: ReleaseAsset[],
  { platform, arch, kind }: { platform: NodeJS.Platform; arch: string; kind: InstallKind | null },
): ReleaseAsset | null {
  const find = (ext: string, tags?: string[]) =>
    assets.find((a) => {
      const n = a.name.toLowerCase()
      return n.endsWith(ext) && (!tags || tags.some((t) => n.includes(t)))
    }) ?? null
  const tags = ARCH_TAGS[arch] ?? [arch]
  if (platform === 'win32') return find('.msi')
  if (platform === 'darwin') return find('.dmg', tags.map((t) => `-mac-${t}`))
  if (platform === 'linux' && kind === 'appimage') return find('.appimage', tags)
  if (platform === 'linux' && kind === 'deb') return find('.deb', tags)
  return null
}

// Reuse a finished download only if it's ours: the temp folder is shared on Linux, and a same-sized
// file someone else left there would otherwise be installed (the .deb as root).
export function downloaded(file: string, size: number): boolean {
  try {
    const st = lstatSync(file)
    return st.isFile() && st.size === size && (!process.getuid || st.uid === process.getuid())
  } catch {
    return false
  }
}

// GitHub's asset JSON may carry `digest: "sha256:<hex>"`. Resolves true when the file matches,
// false when there is nothing to check, and throws when the file differs.
export async function verifyDigest(file: string, digest: string | null | undefined): Promise<boolean> {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? ''))
  if (!m) return false
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) =>
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve()),
  )
  if (hash.digest('hex') !== m[1]!.toLowerCase()) throw new Error('download digest mismatch')
  return true
}

// The macOS and Linux installs are /bin/sh workers. Each logs to a file, waits up to 60 s for the
// app (pid) to exit, then swaps the new version in and, when asked, relaunches.
export const shQuote = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

const workerHead = (pid: number, log: string) => [
  `exec >>${shQuote(log)} 2>&1`,
  `say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }`,
  `say "waiting for Operant 3 (pid ${Number(pid)}) to exit"`,
  `n=0`,
  `while kill -0 ${Number(pid)} 2>/dev/null; do`,
  `  n=$((n+1))`,
  `  if [ "$n" -gt 60 ]; then say "Operant 3 is still running, leaving the update for the next quit"; exit 1; fi`,
  `  sleep 1`,
  `done`,
]

export function macInstallScript(o: { pid: number; dmg: string; bundle: string; log: string; relaunch: boolean }): string {
  return [
    ...workerHead(o.pid, o.log),
    `dmg=${shQuote(o.dmg)}`,
    `bundle=${shQuote(o.bundle)}`,
    `mnt=$(mktemp -d) || exit 1`,
    // The new app is copied beside the old one first, so a failed copy leaves the old one alone.
    `swap() {`,
    `  rm -rf "$bundle.new" "$bundle.old"`,
    `  ditto "$mnt/${APP_BUNDLE}" "$bundle.new" || { rm -rf "$bundle.new"; return 1; }`,
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
    ...(o.relaunch ? [`open "$bundle"`] : []),
    `say done`,
  ].join('\n')
}

export function appImageInstallScript(o: { pid: number; appImage: string; target: string; log: string; relaunch: boolean }): string {
  return [
    ...workerHead(o.pid, o.log),
    `src=${shQuote(o.appImage)}`,
    `target=${shQuote(o.target)}`,
    // Copy beside the target, then rename over it: the swap is atomic and a failed copy leaves the old AppImage alone.
    `if cp "$src" "$target.new" && chmod 755 "$target.new" && mv -f "$target.new" "$target"; then`,
    `  say "replaced $target"`,
    `else`,
    `  say "could not replace $target"; rm -f "$target.new"`,
    `fi`,
    ...(o.relaunch ? [`nohup "$target" >/dev/null 2>&1 &`] : []),
  ].join('\n')
}

export function debInstallScript(o: { pid: number; deb: string; exe: string; log: string; relaunch: boolean }): string {
  return [
    ...workerHead(o.pid, o.log),
    `deb=${shQuote(o.deb)}`,
    `exe=${shQuote(o.exe)}`,
    `say "installing $deb"`,
    `pkexec dpkg -i "$deb"`,
    `say "dpkg exited with $?"`,
    ...(o.relaunch ? [`nohup "$exe" >/dev/null 2>&1 &`] : []),
  ].join('\n')
}

// Windows: a hidden PowerShell worker waits for the app to close, runs msiexec (retrying while another
// install holds the lock, 1618), then optionally relaunches.
export function msiWorkerScript(o: { pid: number; exe: string; installDir: string; msi: string; log: string; relaunch: boolean }): string {
  const q = (s: string) => s.replace(/'/g, "''")
  return [
    `Wait-Process -Id ${Number(o.pid)} -Timeout 60 -ErrorAction SilentlyContinue`,
    // Electron helpers and node-pty's console hosts can outlive the main process briefly.
    `$dir = '${q(o.installDir)}\\'`,
    // msiexec over files still in use fails halfway and leaves the install folder gutted,
    // so if anything from it is still running, skip this time (the next quit retries).
    `$ours = { Get-Process | Where-Object { try { $_.Path -and $_.Path.StartsWith($dir, 'OrdinalIgnoreCase') } catch { $false } } }`,
    `& $ours | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue`,
    `if (-not (& $ours)) { for ($i = 0; $i -lt 40; $i++) {`,
    `  $p = Start-Process msiexec.exe -ArgumentList '/i "${q(o.msi)}" ${o.relaunch ? '/passive' : '/qn'} /norestart /l*v "${q(o.log)}"' -Wait -PassThru`,
    `  if ($p.ExitCode -ne 1618) { break }`,
    `  Start-Sleep -Seconds 15`,
    `} }`,
    // The new package can skip the main exe when the old one is still there at costing time, and the old package's
    // removal then deletes it, so reinstall every file if it is gone.
    `if (-not (Test-Path -LiteralPath '${q(o.exe)}')) {`,
    `  Start-Process msiexec.exe -ArgumentList '/i "${q(o.msi)}" REINSTALL=ALL REINSTALLMODE=vomus /qn /norestart /l*v "${q(o.log)}.repair.log"' -Wait`,
    `}`,
    o.relaunch ? `Start-Process -FilePath '${q(o.exe)}'` : '',
  ].join('\n')
}
