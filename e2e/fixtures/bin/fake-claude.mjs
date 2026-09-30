// Stands in for Claude Code in e2e runs: writes a transcript for --session-id in the
// real format under CLAUDE_CONFIG_DIR, so usage tracking can be tested without spending tokens.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionId = args[args.indexOf('--session-id') + 1]
const model = args[args.indexOf('--model') + 1] === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(dir, { recursive: true })

const line = (id, input, output, cacheRead) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } },
  }) + '\n'

appendFileSync(join(dir, `${sessionId}.jsonl`), line('msg_1', 20_000, 4_000, 60_000) + line('msg_2', 5_000, 12_000, 150_000))
console.log(`fake claude ready (${process.env.OPERANT_OPERATOR})`)
