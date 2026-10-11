// Shared setup for e2e runs that start the real `claude` CLI. The app forces the model to MODEL when OPERANT_E2E is set.
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export const MODEL = 'claude-haiku-5-5'

// A throwaway Claude config dir holding only the owner's login (its content is never read or printed here) and a global
// config that says onboarding is done and the given project folders are trusted, so the Terminal view does not stop on the
// first-run or "trust this folder" screens.
export function claudeHome(root, { trust = [] } = {}) {
  const dir = join(root, 'claude-config')
  mkdirSync(dir, { recursive: true })
  const creds = join(homedir(), '.claude', '.credentials.json')
  if (existsSync(creds)) copyFileSync(creds, join(dir, '.credentials.json'))
  const projects = {}
  for (const folder of trust) {
    for (const p of new Set([folder, realpathSync.native(folder)])) projects[p.replace(/\\/g, '/')] = { hasTrustDialogAccepted: true }
  }
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '9.9.9', theme: 'dark', projects }))
  return dir
}

// The app's environment: fixtures/bin first on PATH (the fake opencode lives there), the real claude further down.
export function e2eEnv({ dataDir, claudeDir, extra = {} }) {
  const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, ...extra }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + (env[pathKey] ?? '')
  return env
}
