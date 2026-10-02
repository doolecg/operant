(function () {
// Installing CodeGraph: the shell command (npm global install, then `codegraph install` to connect it to the agents)
// and the start-up decision of whether to install it now. Used by the Settings button and by main.js at startup.
const PACKAGE = '@colbymchenry/codegraph@latest';

// The install command for a shell: 'sh' (bash/zsh) or PowerShell. `after` is run only when both steps succeed.
function installCommand(sh, after) {
  const npm = `npm i -g ${PACKAGE}`;
  if (sh) return `${npm} && codegraph install${after ? ` && ${after}` : ''}`;
  return `${npm}; if ($?) { codegraph install${after ? `; if ($?) { ${after} }` : ''} }`;
}

// -> 'install' (run the install now) | 'no-npm' (tell the user once) | null (do nothing).
// `tried` is the last attempt ({ version, npm }): it is not repeated until Operant's version changes, except that an
// attempt that found no npm is made again once npm shows up.
function decide({ enabled, installed, npm, tried, version }) {
  if (!enabled || installed) return null;
  if (tried && tried.version === version && !(tried.npm === false && npm)) return null;
  return npm ? 'install' : 'no-npm';
}

const api = { installCommand, decide, PACKAGE };
if (typeof module !== 'undefined') module.exports = api; else globalThis.CodegraphInstall = api;
})();
