// Compresses long command output for agents: keeps error and warning lines, stack traces, file:line
// paths and exit codes (with a line of context), collapses runs of repeated lines and drops the
// rest as "... N lines omitted". Only applied when it is worth it; otherwise the original comes back.
const MIN_CHARS = 3000;
const MIN_LINES = 60;
const MIN_SAVED = 0.3;
const HEAD = 5;
const TAIL = 15;

const IMPORTANT = /\b(error|errors|fail|failed|failure|failing|exception|traceback|panic|fatal|warn|warning|denied|cannot|can't|unable|not found|undefined|timeout|timed out|segfault|abort(?:ed)?)\b|npm ERR|\bERR!|✗|✖|✘|\bFAIL\b|exit(?:ed)?(?: with)?(?: code| status)?[ :=]+-?\d+|exit code|status code|Caused by|^\s+at .+[(:]|File ".+", line \d+|[\w./\-]+\.\w{1,6}:\d+(?::\d+)?/i;

const isImportant = l => IMPORTANT.test(l);
const shape = l => l.replace(/\d+/g, '#').trim();

function compress(text, opts) {
  if (typeof text !== 'string') return text;
  const o = Object.assign({ minChars: MIN_CHARS, minLines: MIN_LINES, minSaved: MIN_SAVED }, opts);
  const lines = text.split('\n');
  if (text.length < o.minChars || lines.length < o.minLines) return text;

  const imp = lines.map(isImportant);
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (i < HEAD || i >= lines.length - TAIL) keep[i] = true;
    if (imp[i]) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) keep[j] = true;
  }

  const out = [];
  let omitted = 0;
  const flush = () => { if (omitted) { out.push(`... ${omitted} lines omitted`); omitted = 0; } };
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) { if (lines[i].trim()) omitted++; continue; }
    flush();
    // Collapse a run of lines that differ only in numbers.
    let n = 1;
    const s = shape(lines[i]);
    while (i + n < lines.length && keep[i + n] && s && shape(lines[i + n]) === s) n++;
    out.push(lines[i]);
    if (n > 1) { out.push(`... (${n - 1} more like it)`); i += n - 1; }
  }
  flush();

  const result = out.join('\n');
  if (result.length > text.length * (1 - o.minSaved)) return text;
  // Every important line must survive (repeats collapse to one, so compare distinct lines).
  const kept = new Set(result.split('\n').map(shape));
  for (let i = 0; i < lines.length; i++) if (imp[i] && !kept.has(shape(lines[i]))) return text;
  return result;
}

module.exports = { compress, isImportant, MIN_CHARS, MIN_LINES, MIN_SAVED };
