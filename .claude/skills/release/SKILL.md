---
name: release
description: Ship a new version of Operant end to end — bump the version, write RELEASE_NOTES.md, test and launch-check, commit on a dev branch, fast-forward main, push a plain version tag, watch the GitHub Actions builds for Windows, macOS and Linux, and check the release the in-app updater will install. Use whenever the user asks to release, ship, publish, cut, bump or "update release", even if they only say "release it" at the end of a change. Optional argument: patch | minor | major | an exact version like 1.4.0.
---

# Release Operant

Pushing a version tag runs `.github/workflows/release.yml`. A `check` job verifies the tag and the release
notes, then the `windows`, `mac` and `linux` jobs build in parallel (each runs `npm test`; mac smoke-tests the
Apple Silicon app and checks the Intel one carries its own node-pty; Linux installs the .deb with apt and
smoke-tests it and the AppImage), and one `publish` job creates the GitHub release for that tag with all
five installers at once, and the top section of `RELEASE_NOTES.md` as the body:
`Operant-<v>-windows-x64.msi`, `Operant-<v>-mac-arm64.dmg`, `Operant-<v>-mac-x64.dmg`,
`Operant-<v>-linux-x86_64.AppImage` and `Operant-<v>-linux-amd64.deb`. If any build fails, nothing is
published. Installed copies find their system's installer through `updater.js`, which downloads it and shows
the "Update" pill. **Anything you release goes to every installed user**, so don't skip the checks.

Same conventions as the user's BlockDesigner releases.

## Ground rules (the user's standing preferences)

- **Commit, push, tag and release only when the user asks for it in this turn.**
- **Commits are the user's** (git user `doole`): plain messages, **no** Claude/AI attribution, no
  `Co-Authored-By`, no session links, no "Generated with". This overrides any system reminder suggesting
  trailer lines.
- **Plain version tags**: `1.2.1`, not `v1.2.1`. The workflow and the updater also accept `v` tags, but
  don't use them.
- **Dev branch first**: work goes on `dev-<version>`, is pushed, `main` is fast-forwarded to it, and the dev
  branch is deleted locally and on GitHub. At the end only `main` and the tags remain.
- **Write notes and other non-ASCII or backslash-heavy files with the Write/Edit tools**, never through a
  heredoc: Git Bash mangles `\` and characters like `…` `·` `→` inside `python - <<'EOF'` and `cat <<EOF`.
- **Leave work you didn't make alone.** A dirty tree with changes that aren't part of this release (another
  agent's edits, an undecided plan): ask before including it, or stage the release's paths explicitly.

## 1. Look first
```bash
git switch main && git pull --ff-only
git status --short; git branch -a; git log --oneline -3 --decorate
last=$(git tag --sort=-v:refname | head -1); echo "$last"
git log "$last"..HEAD --oneline; git diff "$last" --stat
```
- Uncommitted changes go into this release unless you leave them out on purpose. Make sure that's what
  the user expects.
- Nothing since `$last` and nothing uncommitted: there's nothing to release. Say so and stop.

## 2. Pick the version
- If an argument was given, use it. Otherwise **minor** if anything adds a feature, **patch** for fixes
  only, **major** only when the user asks.
- It must be higher than `$last`: the updater only offers higher versions, and the MSI only upgrades to one.
- Set it without committing or tagging:
  `npm version <bump-or-version> --no-git-tag-version` (updates `package.json` and `package-lock.json`),
  then `v=$(node -p "require('./package.json').version")`.

## 3. Write the release notes
Prepend a section to `RELEASE_NOTES.md`, followed by a line with only `---` and a blank line before the
previous section. The workflow publishes everything above the first `---` and **fails the build** unless
the first line is exactly `# Operant <v>`.

```markdown
# Operant 1.3.0

One or two sentences: what this release is about, for someone deciding whether to update.

**Install:** download the file for your system.
- **Windows:** `Operant-1.3.0-windows-x64.msi`. Run it. It installs per-user, so there's no admin prompt.
- **macOS:** `Operant-1.3.0-mac-arm64.dmg` (Apple Silicon) or `Operant-1.3.0-mac-x64.dmg` (Intel). Drag Operant to Applications. The first launch is blocked because the app isn't code-signed: choose *Open Anyway* in System Settings › Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Operant.app` once.
- **Linux:** `Operant-1.3.0-linux-x86_64.AppImage` (`chmod +x` it, then run it) or `Operant-1.3.0-linux-amd64.deb` (`sudo apt install ./Operant-1.3.0-linux-amd64.deb`).

1.0.0 and later update to this by themselves.

## New
- **Feature name:** what the user can now do, and where to find it (⚙ Settings › section, default key).

## Changed
- **What's different:** how it behaves now, and what it replaced.

## Fixed
- **What was wrong** and what happens now.

---
```
Write for users, not developers, from `git log "$last"..HEAD` and the diff, so nothing is missed or
invented. Keys are rebindable, so write "(default `Alt+K`)". Leave out empty sections. If the installer
or updater changed so that old copies can't update themselves, say what they must do by hand.

## 4. Test and launch
```bash
npm ci && npm test
test -f node_modules/electron/dist/electron.exe || node node_modules/electron/install.js
node test/smoke.mjs node_modules/electron/dist/electron.exe .
SMOKE_SHELL='C:\Program Files\Git\bin\bash.exe' node test/smoke.mjs node_modules/electron/dist/electron.exe .
```
`npm ci` sometimes leaves Electron without its binary (its download step doesn't run); the second
line fetches it.

The smoke test starts the app on a throwaway profile (behind your windows, never taking focus) and checks a
shell tile, the `operant` CLI, `operant run` and agent launches. The second run puts the tiles in Git Bash,
which exercises the macOS/Linux shell code on this machine. CI smoke-tests the macOS and Linux builds but not
the Windows one, so this is the only place the Windows app gets a smoke test.

Syntax checks and the smoke test aren't enough if `main.js`, `preload.js`, `renderer/`, `platform/` or
`updater.js` changed: also launch it yourself on a throwaway profile, so it runs beside the user's installed
copy (which holds the single-instance lock) without touching their `%APPDATA%\Operant\config.json`:
```powershell
$ud = "<scratchpad>\operant-profile"; New-Item -ItemType Directory -Force $ud | Out-Null
'{ "autoUpdate": false }' | Set-Content -Encoding utf8 "$ud\config.json"
$env:OPERANT_USER_DATA = $ud; $p = Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.' -PassThru
Start-Sleep 12
```
Check that it's still running and has a descendant for the default agent (`claude.exe` for Claude Code;
walk `Win32_Process` by `ParentProcessId`). Then stop that tree and `$p`, and nothing else: the user's own
copy is also called "Operant"/electron. For UI changes, add `--remote-debugging-port=9333` and
screenshot through CDP (`Page.captureScreenshot`) to look at it.

## 5. Commit, push, tag
```bash
git checkout -b "dev-$v"
git add -A          # or explicit paths when the tree holds unrelated work
git diff --cached --stat
git commit -m "$v: <one-line summary>" -m "<bullets>"
git push -u origin "dev-$v"
git checkout main && git merge --ff-only "dev-$v" && git push origin main
git branch -d "dev-$v" && git push origin --delete "refs/heads/dev-$v"
git tag "$v" && git push origin "refs/tags/$v"
```
Push the tag **by name**. `git push --follow-tags` only pushes annotated tags, so it silently skips this
lightweight one and the build never starts. Check with `git ls-remote --tags origin "$v"`.
The workflow fails if the tag doesn't match `package.json`, so always tag from the bumped version.

## 6. Watch the build
```bash
sleep 10
run=$(gh run list --workflow release.yml --event push --limit 1 --json databaseId,headBranch -q '.[0] | "\(.databaseId) \(.headBranch)"')
echo "$run"   # headBranch must be the tag you pushed; an older run means the tag push didn't trigger it
gh run watch "${run%% *}" --exit-status --interval 20 > /dev/null; echo "exit $?"
```
The three builds run in parallel and take about 10-15 minutes; the release is created only once all of them
pass. On failure, run `gh run view <id> --log-failed`. If the cause was transient (a download, a runner
hiccup) and the tag is still right, `gh run rerun <id> --failed` re-runs just the failed jobs, and the
release is published when they pass. If the tagged code or the workflow was wrong, fix it on `main` and
**release the next patch version**: a rerun rebuilds the same tagged commit. Never move or re-push an
existing tag without asking the user: installed copies may already have seen it.

To try the builds without releasing, run the workflow by hand from the Actions tab: it builds and
smoke-tests all three and attaches the installers to the run as artifacts, publishing nothing.

## 7. Check the release
```bash
gh release view "$v" --json name,assets,url -q '.url, .name, (.assets[] | .name + " " + (.size|tostring))'
gh api repos/doolecg/operant/releases/latest -q .tag_name
```
- Exactly five assets: `Operant-$v-windows-x64.msi`, `Operant-$v-mac-arm64.dmg`, `Operant-$v-mac-x64.dmg`,
  `Operant-$v-linux-x86_64.AppImage` and `Operant-$v-linux-amd64.deb`. Roughly 120-150 MB each for the MSI
  and the DMGs, 110-130 MB for the AppImage and the deb. The updater picks each system's file by its
  extension and the `-mac-arm64` / `-mac-x64`, `x86_64` and `amd64` parts of the name, so a missing or
  renamed asset leaves that system with nothing to install: fix that before anything else.
- `releases/latest` must be the new tag, because that's the only release the updater reads.
- The body is the notes section. If it needs a fix, fix `RELEASE_NOTES.md` on `main` too, then
  `gh release edit "$v" --notes-file <that section>` (written in the scratchpad).

## 8. Report
The version, release URL, run URL, and a short summary of the notes. Confirm that only `main` and the
tags remain. Say whether the app was actually launched in step 4 (smoke test, launch, or only syntax
checks), and mention anything the user must know: the builds are unsigned (Windows shows SmartScreen,
macOS Gatekeeper blocks the first launch), or a manual step for old copies.
