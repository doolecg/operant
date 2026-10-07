// Discord settings e2e: add a bot, allowlist, project channel, connect, pairing approve, Test button, token replace
// and delete, with a fake gateway so nothing touches the network. Runs in the background with throwaway data.
// Usage: node e2e/discord.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-discord-'))
const project = mkdtempSync(join(tmpdir(), 'operant-discord-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-discord-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = {
  ...process.env,
  OPERANT_BACKGROUND: '1', OPERANT_E2E: '1',
  OPERANT_DATA_DIR: dataDir,
  CLAUDE_CONFIG_DIR: claudeDir,
  OPERANT_E2E_DISCORD_GATEWAY: resolve('e2e/fixtures/fake-discord-gateway.cjs'),
}

const TOKEN = 'fake-token-abc1234567890'
let app = null
let page = null
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const shot = async (name) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}
async function until(what, fn, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await page.waitForTimeout(150)
  }
  assert.fail(`timed out: ${what}`)
}

try {
  app = await electron.launch({ args: ['.'], env })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()

  const shop = await page.evaluate((folder) => window.operant.invoke('crews:create', { name: 'shop', folder }), project)

  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Discord', exact: true }).click()
  await page.getByText('No bots yet.').waitFor()
  await shot('settings-discord-before')

  // Add a bot: the token goes in write-only.
  await page.getByRole('button', { name: 'Add bot' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Bot name').fill('Front desk')
  await dialog.getByLabel('Bot token').fill(TOKEN)
  await dialog.getByLabel('Rules for the front desk').fill('Be brief. Never start a job without a PRJ number.')
  await dialog.getByLabel('Home channel ID').fill('111222333444')
  await dialog.getByLabel('General channel ID').fill('111222333555')
  await dialog.getByRole('button', { name: 'Add bot' }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByText('Token saved').first().waitFor()
  const [bot] = await inv('discord:list')
  assert.equal(bot.name, 'Front desk')
  assert.equal(bot.hasToken, true)
  assert.equal(bot.homeChannel, '111222333444')
  assert.equal(bot.mentionOnly, true)
  assert.ok(!JSON.stringify(bot).includes(TOKEN), 'the token must never come back from the app')
  assert.ok(!(await page.content()).includes(TOKEN), 'the token must never be in the page')

  // The edit dialog shows a saved token as saved, not its value.
  await page.getByRole('button', { name: 'Edit Front desk' }).click()
  await dialog.getByText('Token saved').waitFor()
  assert.equal(await dialog.getByLabel('Bot token').count(), 0)
  await dialog.getByLabel('Answer only when mentioned').click()
  await dialog.getByRole('button', { name: 'Save bot' }).click()
  await dialog.waitFor({ state: 'detached' })
  await until('mention-only saved', async () => (await inv('discord:list'))[0].mentionOnly === false)

  // Allowlist add and remove, applied live.
  const allow = page.getByLabel('Add to Allowlist (user IDs)', { exact: true })
  await allow.fill('123456789012345678')
  await allow.press('Enter')
  await until('allowlist saved', async () => (await inv('discord:list'))[0].allowlist.includes('123456789012345678'))
  await page.getByRole('button', { name: 'Remove 123456789012345678 from Allowlist (user IDs)' }).click()
  await until('allowlist removal saved', async () => (await inv('discord:list'))[0].allowlist.length === 0)
  await allow.fill('123456789012345678')
  await allow.press('Enter')
  await until('allowlist saved again', async () => (await inv('discord:list'))[0].allowlist.length === 1)

  // Per-project channel.
  const channels = page.getByLabel('Add to Discord channels for shop', { exact: true })
  await channels.fill('222333444555')
  await channels.press('Enter')
  await until('channel saved', async () => (await inv('crews:list')).find((c) => c.id === shop.id).discordChannels.includes('222333444555'))
  await page.getByRole('button', { name: 'Remove 222333444555 from Discord channels for shop' }).waitFor()

  // A refused channel id comes back as a plain error.
  await channels.fill('nope')
  await channels.press('Enter')
  await page.getByRole('alert').first().waitFor()
  await channels.fill('')

  // Connect: the health badge goes live, then the unknown user's direct message becomes a pairing request.
  await page.getByRole('switch', { name: 'Connect Front desk' }).click()
  await page.getByLabel('Front desk status: Connected').waitFor()
  await until('pairing waiting', async () => (await inv('discord:pairings', bot.id)).length === 1)
  await page.getByRole('button', { name: 'Refresh pairing requests for Front desk' }).click()
  await page.getByRole('button', { name: 'Approve newcomer' }).click()
  await until('pairing approved', async () => (await inv('discord:list'))[0].allowlist.includes('555'))
  await page.getByText('None waiting.').waitFor()

  // Test button: token validity and server membership.
  await page.getByRole('button', { name: 'Test Front desk' }).click()
  await page.getByText('valid (FrontDeskBot)').waitFor()
  await page.getByText('Test Server').waitFor()
  await shot('settings-discord')

  // Replacing the token with a refused one shows the refusal and a failed test.
  await page.getByRole('button', { name: 'Edit Front desk' }).click()
  await dialog.getByRole('button', { name: 'Replace token' }).click()
  await dialog.getByLabel('Bot token').fill('bad-token-0123456789abc')
  await dialog.getByRole('button', { name: 'Save bot' }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByLabel('Front desk status: Error').waitFor()
  await page.getByRole('button', { name: 'Test Front desk' }).click()
  await page.getByText('not valid').waitFor()

  // Delete asks first.
  await page.getByRole('button', { name: 'Delete Front desk' }).click()
  await page.getByRole('dialog').getByText(/token, allowlist and pairing requests are removed/).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  assert.equal((await inv('discord:list')).length, 1)
  await page.getByRole('button', { name: 'Delete Front desk' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete bot' }).click()
  await page.getByText('No bots yet.').waitFor()
  assert.equal((await inv('discord:list')).length, 0)
  console.log('discord e2e passed; screenshots in', outDir)
} catch (err) {
  await page?.screenshot({ path: join(outDir, 'fail-discord.png') }).catch(() => {})
  throw err
} finally {
  await app?.close().catch(() => {})
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}
