// Token prices: USD per million tokens by model id. A model that isn't in the table prices as
// unknown (usd: null), never a guess. OpenCode records its own cost per message and that wins when it's above 0.

const SOURCE = 'Anthropic pricing (claude-api skill)';
const DATE = '2026-09-29';

// Cache writes are the 5-minute rate (1.25x input); cache reads are 0.1x input, except Fable 5.1's published $0.25.
// Fable 5 isn't listed: its cache read price isn't published there, so it stays unknown.
const row = (input, output, cacheRead, cacheWrite = input * 1.25) => ({ input, output, cacheWrite, cacheRead, source: SOURCE, date: DATE });
const TABLE = [
  [/^claude-fable-5-1$/, row(10, 50, 0.25)],
  [/^claude-opus-5-5$/, row(4, 20, 0.2)],
  [/^claude-opus-(5|4-8|4-7|4-6)$/, row(5, 25, 0.5)],
  [/^claude-sonnet-(5-5|5)$/, row(2, 10, 0.2)],
  [/^claude-sonnet-4-6$/, row(3, 15, 0.3)],
  [/^claude-haiku-4-5$/, row(1, 5, 0.1)],
];

const FREE_SOURCE = 'OpenCode Zen free';
const OC_SOURCE = 'OpenCode recorded cost';

// "anthropic/claude-opus-4.8[1m]", "anthropic.claude-haiku-4-5-20251001" -> "claude-opus-4-8", "claude-haiku-4-5"
const normalize = id => String(id || '').toLowerCase().replace(/\[.*\]$/, '').replace(/^.*[/]/, '').replace(/^anthropic\./, '').replace(/\./g, '-').replace(/-\d{8}$/, '');
const isFreeModel = id => { const n = normalize(id); return n === 'big-pickle' || /-free$/.test(n) || /^ollama\//i.test(String(id || '')); };

function tableRow(model) {
  const n = normalize(model);
  const hit = TABLE.find(([re]) => re.test(n));
  return hit ? hit[1] : null;
}

// tokens: { input, output, cacheWrite, cacheRead }; recordedCost: OpenCode's own USD for the message, when there is one.
// -> { usd: number | null, source }
function priceOf(model, tokens, recordedCost) {
  if (recordedCost > 0) return { usd: recordedCost, source: OC_SOURCE };
  if (isFreeModel(model)) return { usd: 0, source: FREE_SOURCE };
  const p = tableRow(model);
  if (!p) return { usd: null, source: 'unknown model' };
  const t = tokens || {};
  const usd = ((t.input || 0) * p.input + (t.output || 0) * p.output + (t.cacheWrite || 0) * p.cacheWrite + (t.cacheRead || 0) * p.cacheRead) / 1e6;
  return { usd, source: p.source };
}

const info = { source: SOURCE, date: DATE };

module.exports = { priceOf, isFreeModel, normalize, info, TABLE };
