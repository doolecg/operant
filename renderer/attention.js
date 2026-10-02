(function () {
// What an agent tile's screen says: its last message, whether that message asks the user something, and a short form of it.
// Claude Code prints assistant messages as blocks starting with ● or ⏺ above an input box; other CLIs just print paragraphs.
const MARK = /^\s*[●⏺✦]\s/;
const TOOL = /^\s*[●⏺]\s+[A-Za-z][\w.:-]*\(.*\)?\s*$|\(ctrl\+o to expand\)/;
const RULE = /^\s*[╭╰]?[─━═]{3,}[╮╯]?\s*$/;
const HINT = /\? for shortcuts|context left|esc to interrupt|accept edits|bypass permissions|shift\+tab|ctrl\+[a-z] to|\/help for help/i;
const PROMPT = /^\s*[>❯›$#]\s*$/;
const SPINNER = /^\s*[✻✽✢✳✶]\s/;
const PICKER_HINT = /Enter to select|↑\/↓ to navigate|↑↓ to navigate/;
const OPTION = /^\s*(?:❯\s*)?\d+\.\s+\S/;
const PERMISSION = /Do you want to\b/i;
const clean = t => String(t).replace(/[╭╮╰╯│┃─━═⎿]/g, ' ').replace(/^\s*[●⏺✦]\s*/, '').replace(/\s+/g, ' ').trim();

const hasPermission = lines => {
  const s = lines.join('\n');
  return PERMISSION.test(s) && /\b1\.\s*Yes\b/i.test(s) && /\b\d\.\s*No\b/i.test(s);
};
const pickerAt = lines => {
  if (hasPermission(lines)) return -1;
  let f = -1;
  lines.forEach((l, i) => { if (PICKER_HINT.test(l)) f = i; });
  return f !== -1 && lines.slice(0, f).some(l => OPTION.test(l)) ? f : -1;
};

// The question a choice picker is showing: the text above its first numbered option, under the tab header.
function pickerQuestion(lines, f) {
  let j = f;
  while (j >= 0 && !/^\s*(?:❯\s*)?1\.\s/.test(lines[j])) j--;
  if (j < 0) return '';
  let i = j - 1;
  const skip = l => !l.trim() || RULE.test(l) || /^\s*[☐☒✔←→]/.test(l);
  while (i >= 0 && skip(lines[i])) i--;
  const out = [];
  for (; i >= 0 && lines[i].trim() && !RULE.test(lines[i]); i--) out.unshift(lines[i]);
  return clean(out.join(' '));
}

function lastMessage(lines) {
  lines = (lines || []).map(l => String(l).replace(/\s+$/, ''));
  const f = pickerAt(lines);
  if (f !== -1) { const q = pickerQuestion(lines, f); if (q) return q; }
  const rules = [];
  lines.forEach((l, i) => { if (RULE.test(l)) rules.push(i); });
  let end = lines.length;
  if (rules.length) { end = rules[rules.length - 1]; if (rules.length > 1 && end - rules[rules.length - 2] <= 8) end = rules[rules.length - 2]; }
  const body = lines.slice(0, end);
  while (body.length && (!body[body.length - 1].trim() || HINT.test(body[body.length - 1]) || PROMPT.test(body[body.length - 1]) || SPINNER.test(body[body.length - 1]))) body.pop();
  if (!body.length) return '';
  const marks = [];
  body.forEach((l, i) => { if (MARK.test(l)) marks.push(i); });
  if (marks.length) {
    for (let k = marks.length - 1; k >= 0; k--) {
      const block = body.slice(marks[k], marks[k + 1] ?? body.length);
      if (k > 0 && (TOOL.test(block[0]) || block.some(l => /^\s*⎿/.test(l)))) continue;
      return clean(block.join(' '));
    }
  }
  let s = body.length - 1;
  while (s > 0 && body[s - 1].trim()) s--;
  return clean(body.slice(s).join(' '));
}

// The last sentence of the message: what the agent is asking.
const sentences = t => clean(t).split(/(?<=[.!?])\s+/).filter(Boolean);
const lastSentence = t => sentences(t).pop() || '';

function isQuestion(text, lines) {
  lines = lines || [];
  if (pickerAt(lines) !== -1) return true;
  if (hasPermission(lines)) return false;
  return /\?[\s"'`)\]*_]*$/.test(lastSentence(text));
}

function summary(text, n = 140) {
  const all = sentences(text);
  if (!all.length) return '';
  let out = '';
  for (const s of all) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > n) break;
    out = next;
  }
  if (!out) out = all[0];
  return out.length > n ? out.slice(0, n - 1).trimEnd() + '…' : out;
}

const api = { lastMessage, isQuestion, summary, lastSentence };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Attention = api;
})();
