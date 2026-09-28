// Builds an OpenCode theme (https://opencode.ai/theme.json) from Operant's current theme, so
// OpenCode tiles match the app instead of showing their own default. Backgrounds are 'none' so
// the tile's own glass background shows through, like every other terminal in Operant.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { THEMES } = require('./renderer/themes');

const THEME_PATH = path.join(os.homedir(), '.config', 'opencode', 'themes', 'operant.json');
// A standalone tui.json OPENCODE_TUI_CONFIG points OpenCode tiles at, selecting the theme above
// without touching the user's own ~/.config/opencode/tui.json.
const TUI_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'operant-tui.json');
const TUI_CONFIG = JSON.stringify({ theme: 'operant' }, null, 2);

// Same fallback ANSI as renderer.js's termOptions, for themes without their own `ansi` overrides.
const ANSI_DEFAULT = {
  red: '#e06c5a', green: '#9cb88a', yellow: '#e3b27a', blue: '#8fa9c7', magenta: '#c89ab8', cyan: '#8dbab3',
  brightRed: '#f08a78', brightGreen: '#b4cfa3', brightYellow: '#f0c995', brightBlue: '#abc2dc',
  brightMagenta: '#dcb4ce', brightCyan: '#a9d0ca',
};

function themeFor(themeId, accent) {
  const t = THEMES[themeId] || THEMES.obsidian;
  const a = { ...ANSI_DEFAULT, ...(t.ansi || {}) };
  const primary = accent || t.accent;
  return {
    $schema: 'https://opencode.ai/theme.json',
    defs: {},
    theme: {
      primary, secondary: t.agent, accent: primary,
      error: a.red, warning: a.yellow, success: t.done || a.green, info: a.blue,
      text: t.text, textMuted: t.dim,
      background: 'none', backgroundPanel: 'none', backgroundElement: 'none',
      border: t.termBlack, borderActive: primary, borderSubtle: t.termBlack,
      diffAdded: a.green, diffRemoved: a.red, diffContext: t.dim,
      diffHighlightAdded: a.brightGreen, diffHighlightRemoved: a.brightRed,
      diffAddedBg: 'none', diffRemovedBg: 'none', diffContextBg: 'none',
      diffLineNumber: t.dim, diffAddedLineNumberBg: 'none', diffRemovedLineNumberBg: 'none',
      markdownText: t.text, markdownHeading: primary, markdownLink: a.blue, markdownLinkText: a.cyan,
      markdownCode: a.green, markdownBlockQuote: t.dim, markdownEmph: t.text, markdownStrong: t.text,
      markdownHorizontalRule: t.dim, markdownListItem: primary, markdownListEnumeration: a.yellow,
      markdownImage: a.magenta, markdownImageText: a.cyan, markdownCodeBlock: t.text,
      syntaxComment: t.dim, syntaxKeyword: a.magenta, syntaxFunction: a.blue, syntaxVariable: t.text,
      syntaxString: a.green, syntaxNumber: a.yellow, syntaxType: a.cyan, syntaxOperator: t.text,
      syntaxPunctuation: t.dim,
    },
  };
}

// Writes ~/.config/opencode/themes/operant.json when its content changed. Never throws: OpenCode
// theming is a nice-to-have, not something that should break tile launches.
function writeTheme(config) {
  try {
    const json = JSON.stringify(themeFor(config.theme, config.accent), null, 2);
    let existing = null;
    try { existing = fs.readFileSync(THEME_PATH, 'utf8'); } catch {}
    if (existing !== json) {
      fs.mkdirSync(path.dirname(THEME_PATH), { recursive: true });
      fs.writeFileSync(THEME_PATH, json);
    }
    let existingTui = null;
    try { existingTui = fs.readFileSync(TUI_CONFIG_PATH, 'utf8'); } catch {}
    if (existingTui !== TUI_CONFIG) fs.writeFileSync(TUI_CONFIG_PATH, TUI_CONFIG);
  } catch (e) { console.error('opencode theme write failed', e.message); }
}

module.exports = { themeFor, writeTheme, TUI_CONFIG_PATH };
