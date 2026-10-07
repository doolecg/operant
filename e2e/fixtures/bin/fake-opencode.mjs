// Stands in for OpenCode in e2e runs: `opencode models` (OPENCODE_FAKE_MODELS ids, default 300, like a big provider list) and `opencode mcp list|add`, against the config file named by OPENCODE_CONFIG,
// in the real `<mark> <name>  <status>` format. A name with "bad" fails.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
// OPENCODE_FAKE_MODELS=multi: a few real providers (OpenAI is listed but not signed in), and `auth list` shows only Z.AI.
const MULTI = [
  'openai/gpt-5',
  'opencode/big-pickle',
  'opencode/exo-free',
  'ollama/gemma4:e4b',
  'ollama/llamacpp:a3d2b95350da03ff9b1943a753bb6617c49a3ee462b632a758518ec817743986',
  'zai-coding-plan/glm-4.7',
  'zai-coding-plan/glm-5.2',
  'zai-coding-plan/glm-5.3-flash',
]
if (args[0] === 'auth' && args[1] === 'list') {
  if (process.env.OPENCODE_FAKE_MODELS !== 'multi') process.exit(1)
  process.stdout.write('Z.AI Coding Plan  Z.AI Coding Plan            stored\r\n')
  process.exit(0)
}
if (args[0] === 'models' && process.env.OPENCODE_FAKE_MODELS === 'multi') {
  process.stdout.write(MULTI.join('\n') + '\n')
  process.exit(0)
}
if (args[0] === 'models') {
  const n = Number(process.env.OPENCODE_FAKE_MODELS ?? 300)
  for (let i = 0; i < n; i++) process.stdout.write(`provider-${i % 12}/model-${String(i).padStart(3, '0')}-instruct
`)
  process.exit(0)
}
if (args[0] === 'run') {
  // The learn step: answer with CLAUDE_CONFIG_DIR/learn-response.json (like the fake claude) and note the arguments.
  const dir = process.env.CLAUDE_CONFIG_DIR
  const answer = dir && existsSync(`${dir}/learn-response.json`) ? readFileSync(`${dir}/learn-response.json`, 'utf8') : '[]'
  if (dir) writeFileSync(`${dir}/opencode-run-args.json`, JSON.stringify(args))
  process.stdout.write(answer)
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
