// Stands in for OpenCode in e2e runs: `opencode models` (OPENCODE_FAKE_MODELS ids, default 300, like a big provider list) and `opencode mcp list|add`, against the config file named by OPENCODE_CONFIG,
// in the real `<mark> <name>  <status>` format. A name with "bad" fails.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === 'models') {
  const n = Number(process.env.OPENCODE_FAKE_MODELS ?? 300)
  for (let i = 0; i < n; i++) process.stdout.write(`provider-${i % 12}/model-${String(i).padStart(3, '0')}-instruct
`)
  process.exit(0)
}
if (args[0] !== 'mcp') process.exit(1)
const file = process.env.OPENCODE_CONFIG
const cfg = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const servers = ((cfg.mcp ??= {}).servers ??= {})
if (args[1] === 'list') {
  for (const [name, v] of Object.entries(servers)) {
    process.stdout.write(
      v.disabled
        ? `○ ${name}  disabled\r\n`
        : name.includes('bad')
          ? `✗ ${name}  failed: spawn ENOENT\r\n`
          : name.includes('auth')
            ? `⚠ ${name}  needs authentication\r\n`
            : name.includes('wait')
              ? `○ ${name}  pending\r\n`
              : `✓ ${name}  connected\r\n`,
    )
  }
} else if (args[1] === 'add') {
  const dash = args.indexOf('--')
  const head = dash >= 0 ? args.slice(2, dash) : args.slice(2)
  const name = head.filter((a, i) => !a.startsWith('-') && !['--url', '--header', '--env'].includes(head[i - 1]))[0]
  const url = head[head.indexOf('--url') + 1]
  servers[name] = dash >= 0 ? { type: 'local', command: args.slice(dash + 1) } : { type: 'remote', url }
  writeFileSync(file, JSON.stringify(cfg))
}
process.exit(0)
