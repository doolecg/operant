// OpenCode usage from its database (item 54): one event per assistant message. Only assistant messages
// count; their step-finish parts repeat the same numbers. Opened read-only and closed again.

const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// since: ms epoch; project: a directory's base name to keep, or null for all. Never throws.
function readOpenCodeUsage({ dbPath = DB_PATH, since = 0, project = null } = {}) {
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const sessions = new Map();
    for (const s of db.prepare('select id, parent_id, directory from session').all()) sessions.set(s.id, s);
    const rootOf = id => {
      let s = sessions.get(id);
      for (let i = 0; s && s.parent_id && sessions.has(s.parent_id) && i < 50; i++) s = sessions.get(s.parent_id);
      return s ? s.id : id;
    };
    const out = [];
    const rows = db.prepare(`select session_id, data from message where json_extract(data, '$.role') = 'assistant'
      and json_extract(data, '$.time.created') >= ?`).all(since);
    for (const r of rows) {
      let d;
      try { d = JSON.parse(r.data); } catch { continue; }
      const s = sessions.get(r.session_id);
      const directory = s?.directory || '';
      if (project && path.basename(directory) !== project) continue;
      const tk = d.tokens || {};
      out.push({
        at: d.time?.created || 0, model: d.modelID || null, provider: d.providerID || null,
        sessionId: r.session_id, rootSessionId: rootOf(r.session_id), directory,
        input: tk.input || 0, output: tk.output || 0, reasoning: tk.reasoning || 0,
        cacheRead: tk.cache?.read || 0, cacheWrite: tk.cache?.write || 0, cost: +d.cost || 0,
      });
    }
    return out;
  } catch { return []; }
  finally { try { db?.close(); } catch {} }
}

module.exports = { readOpenCodeUsage, DB_PATH };
