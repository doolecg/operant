(function () {
// Quiet hours: is `date` inside the daily window from..to ('HH:MM', 24h)? A window may cross midnight (22:00 to 07:00).
const mins = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };

function inQuietHours(from, to, date = new Date()) {
  const a = mins(from), b = mins(to);
  if (a == null || b == null || a === b) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return a < b ? now >= a && now < b : now >= a || now < b;
}

const api = { inQuietHours };
if (typeof module !== 'undefined') module.exports = api; else globalThis.QuietHours = api;
})();
