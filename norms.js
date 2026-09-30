// Team norms (2.7): a per-project working style, stored as <project>/.operant/norms.json. Plain data; the callers that pick
// verification thresholds and default tiers read the profile. The default, "trust but verify", is what Operant always did.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_PRESET = 'trust-but-verify';
const PROFILES = {
  exploratory: { id: 'exploratory', label: 'Exploratory', preferCheap: true, extraChecks: false, independentReview: false,
    text: 'Looser verification (the test or build command only) and the free or xsmall tier where it fits.' },
  'trust-but-verify': { id: 'trust-but-verify', label: 'Trust but verify', preferCheap: false, extraChecks: true, independentReview: true,
    text: 'Full verification, and an independent review advised on high-risk tasks.' },
};
const PRESETS = Object.keys(PROFILES);

// Accepts "Trust but verify", "trust_but_verify" and the like; anything unknown is null.
function normalize(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PROFILES[k] ? k : null;
}
const fileOf = dir => path.join(dir, '.operant', 'norms.json');
// The project's preset, else the fallback (the Settings default), else "trust but verify".
function load(dir, fallback) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')); } catch {}
  return normalize(raw && raw.preset) || normalize(fallback) || DEFAULT_PRESET;
}
function save(dir, preset) {
  const p = normalize(preset);
  if (!p) throw new Error(`unknown preset "${preset}" (${PRESETS.join(', ')})`);
  fs.mkdirSync(path.join(dir, '.operant'), { recursive: true });
  writeFileAtomic(fileOf(dir), JSON.stringify({ schema: 1, preset: p }, null, 2));
  return p;
}
const profile = preset => PROFILES[normalize(preset) || DEFAULT_PRESET];

module.exports = { DEFAULT_PRESET, PROFILES, PRESETS, normalize, load, save, profile, fileOf };
