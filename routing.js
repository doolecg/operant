(function () {
// Routing from outcomes (item 59): pick the cheapest tier whose recorded results for this kind of task hold up.
// Pure; stats is outcomes.summarize() over the recent window, tiers run cheap to expensive and are already capped.
const MIN_N = 5, MIN_RATE = 0.8, EXPLORE_EVERY = 10;
const classify = p => (typeof TaskType !== 'undefined' ? TaskType : require('./task-type')).classifyTask(p);

function route({ prompt, tiers, stats, counter, fallback }) {
  const type = classify(prompt);
  const cells = tiers.map(name => {
    const c = stats?.[type]?.[name];
    const n = c ? c.passed + c.failed + c.escalated : 0;
    return { name, c, n, rate: n ? c.passed / n : 0 };
  });
  const usd = c => (c.avgUsd == null ? 'unknown' : '$' + c.avgUsd.toFixed(2));
  const proven = cells.findIndex(x => x.n >= MIN_N && x.rate >= MIN_RATE);
  if (proven >= 0) {
    const p = cells[proven];
    if (proven > 0 && (counter | 0) % EXPLORE_EVERY === EXPLORE_EVERY - 1) {
      return { tier: cells[proven - 1].name, basis: 'exploration', reason: `trying ${cells[proven - 1].name} (1 in 10, so a cheaper tier can earn its way back; ${p.name} is proven)` };
    }
    return { tier: p.name, basis: 'outcomes', reason: `${p.name}: ${p.c.passed}/${p.n} ${type} tasks passed, ${usd(p.c)} avg` };
  }
  let failing = -1;
  cells.forEach((x, i) => { if (x.n >= MIN_N) failing = i; });
  if (failing >= 0) {
    const f = cells[failing], next = cells[Math.min(failing + 1, cells.length - 1)];
    return { tier: next.name, basis: 'outcomes', reason: `${next.name}: ${f.name} passed only ${f.c.passed}/${f.n} ${type} tasks` };
  }
  const k = cells.reduce((s, x) => s + x.n, 0);
  return { tier: fallback?.tier ?? tiers[0], basis: 'insufficient data', reason: `insufficient data for ${type} tasks (${k} recorded); ${fallback?.reason ?? 'no keyword match'}` };
}

const api = { route };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Routing = api;
})();
