// The first-run tour: a few short cards explaining Operant. `k(action)` gives the keybind chip for an action.
const Tour = (() => {
  const steps = k => [
    { title: 'Welcome to Operant', body: `<p>Operant is a tiling window manager for terminal AI agents. Run Claude Code, Codex, OpenCode, Gemini or any command-line agent side by side, each in its own tile.</p>
      <p>This tour takes under a minute. You can skip it now and open it again any time from the ⚙ menu.</p>` },
    { title: 'Tiles and workspaces', body: `<p>Every agent or shell lives in a tile. Tiles arrange themselves, and you have nine workspaces to spread them over.</p>
      <ul><li>${k('newAgent')} opens your default agent, ${k('pickAgent')} lets you choose one</li>
      <li><kbd>Alt+1…9</kbd> jumps to a workspace</li>
      <li>${k('focusLeft')} ${k('focusRight')} move between tiles, ${k('toggleLayout')} switches the layout</li>
      <li>${k('fullscreen')} zooms a tile, ${k('close')} closes it</li></ul>` },
    { title: 'You don\'t have to watch', body: `<p>When an agent finishes or asks you something, Operant sends a Windows notification. Click it to land on that tile.</p>
      <p>Claude Code subagents open in their own tiles as soon as they start, so you can see what each one is doing. The 🔔 in the top bar keeps a list of what you missed.</p>` },
    { title: 'Save tokens', body: `<p>Long commands (tests, builds, installs) run in their own tile with <code>operant run</code>, and the agent reads back only the part it needs. The Operant skill installs itself for agents, so this happens without you asking.</p>
      <p>Each tile shows its context size, so you can see when it's time to compact or start fresh. The token pill in the top bar tracks your usage.</p>` },
    { title: 'The top bar and sidebar', body: `<ul><li><b>Sidebar</b> (${k('toggleSidebar')}): pinned projects and a folder tree; ＋ opens an agent in a folder</li>
      <li><b>Tasks</b>: work handed to background agents</li>
      <li><b>Tidy agents</b> ✦: skills, rules and memory across your agents</li>
      <li><b>⚙</b>: team sliders, shortcuts, and Settings</li></ul>` },
    { title: 'Make it yours', body: `<p>${k('help')} shows every keybind, and you can rebind any of them. ${k('settings')} opens Settings: themes, layouts, agents, notifications and more, all applied live.</p>
      <p>${k('commandPalette')} is the command palette, and ${k('quickOpen')} opens files.</p><p>That's it. Pick an agent and go.</p>` },
  ];

  function render(el, i, k) {
    const s = steps(k), last = i === s.length - 1;
    el.querySelector('.card-head h2 span.t').textContent = s[i].title;
    el.querySelector('.card-head .sub').textContent = `${i + 1} of ${s.length}`;
    el.querySelector('.card-body').innerHTML = `<div class="tour-step">${s[i].body}</div>
      <div class="tour-dots">${s.map((_, j) => `<i class="${j === i ? 'on' : ''}" data-j="${j}"></i>`).join('')}</div>`;
    el.querySelector('#tour-back').disabled = i === 0;
    el.querySelector('#tour-next').textContent = last ? 'Get started' : 'Next';
    el.querySelector('#tour-skip').classList.toggle('hidden', last);
    return s.length;
  }
  return { render };
})();
