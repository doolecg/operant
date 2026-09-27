// Turns subagent transcript entries into ANSI text for a read-only xterm,
// styled after Claude Code's own terminal output.

const AgentRender = (() => {
  const E = '\x1b[';
  const c = {
    reset: E + '0m', bold: E + '1m', dim: E + '2m', italic: E + '3m',
    purple: E + '38;2;227;178;122m', green: E + '38;2;156;184;138m', red: E + '38;2;224;108;90m',
    orange: E + '38;2;217;119;87m', cyan: E + '38;2;217;119;87m', grey: E + '38;2;156;151;139m',
    white: E + '38;2;240;238;230m',
  };
  const nl = s => String(s).replace(/\r?\n/g, '\r\n');

  function header(info) {
    return `${c.purple}${c.bold}◆ ${info.agentType}${c.reset}  ${c.white}${info.description}${c.reset}\r\n`
      + `${c.grey}${info.project.replace(/--/g, ':\\').replace(/-/g, ' ')} · agent ${info.agentId.slice(0, 8)}`
      + `${info.spawnDepth > 1 ? ` · depth ${info.spawnDepth}` : ''}${c.reset}\r\n\r\n`;
  }

  function toolSummary(name, input = {}) {
    const pick = input.command || input.file_path || input.path && input.pattern && `${input.pattern} in ${input.path}`
      || input.pattern || input.url || input.query || input.description || input.prompt || input.skill;
    let s = pick ? String(pick) : JSON.stringify(input);
    s = s.replace(/\s+/g, ' ');
    return s.length > 110 ? s.slice(0, 107) + '…' : s;
  }

  function preview(text, max = 4) {
    const lines = String(text).replace(/\s+$/, '').split(/\r?\n/);
    const shown = lines.slice(0, max).map(l => (l.length > 160 ? l.slice(0, 157) + '…' : l));
    const more = lines.length - shown.length;
    return { shown, more };
  }

  // state: { first: bool, tools: Map(id -> name) }
  function entry(e, state) {
    let out = '';
    for (const b of e.blocks) {
      if (e.role === 'user' && b.type === 'text') {
        if (state.first) {
          const { shown, more } = preview(b.text, 8);
          out += `${c.grey}▸ task${c.reset}\r\n${c.dim}${nl(shown.join('\n'))}${c.reset}`
            + (more > 0 ? `\r\n${c.grey}  … +${more} lines${c.reset}` : '') + '\r\n\r\n';
          state.first = false;
        } else if (!b.text.startsWith('<')) {
          out += `${c.cyan}» ${c.reset}${nl(b.text)}\r\n\r\n`;
        }
      } else if (b.type === 'text') {
        out += `${c.white}${nl(b.text.trim())}${c.reset}\r\n\r\n`;
      } else if (b.type === 'thinking') {
        const { shown, more } = preview(b.text, 3);
        out += `${c.grey}${c.italic}✻ ${nl(shown.join('\n'))}${more > 0 ? ' …' : ''}${c.reset}\r\n\r\n`;
      } else if (b.type === 'tool_use') {
        state.tools.set(b.id, b.name);
        out += `${c.green}●${c.reset} ${c.bold}${b.name}${c.reset}${c.grey}(${toolSummary(b.name, b.input)})${c.reset}\r\n`;
      } else if (b.type === 'tool_result') {
        const col = b.isError ? c.red : c.grey;
        const { shown, more } = preview(b.text || '(no output)', b.isError ? 6 : 3);
        out += shown.map((l, i) => `${c.grey}${i === 0 ? '  ⎿  ' : '     '}${col}${l}${c.reset}`).join('\r\n');
        out += (more > 0 ? `\r\n${c.grey}     … +${more} lines${c.reset}` : '') + '\r\n\r\n';
      }
    }
    return out;
  }

  return { header, entry };
})();
