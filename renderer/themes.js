// Color themes. Shared by the renderer (applies them) and main (window background color).
// A mix of warm Claude-style darks, well-known editor/terminal palettes and a few originals.
// Themes with an `ansi` object supply their own 16 terminal colors (black comes from termBlack);
// themes without one fall back to the renderer's built-in terminal palette.

const THEMES = {
  obsidian: {
    name: 'Obsidian', note: 'Near-black, warm',
    bg: '#0f0e0d', glow: '#2a1b12', bar: '17, 16, 15', glass: '24, 23, 21', card: '22, 21, 20',
    ink: '240, 238, 230', text: '#f0eee6', dim: '#948f84', inactive: 'rgba(176, 168, 152, .13)',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#262522',
  },
  void: {
    name: 'Void', note: 'Pure black (OLED)',
    bg: '#000000', glow: '#1f130c', bar: '0, 0, 0', glass: '8, 8, 7', card: '12, 12, 11',
    ink: '240, 238, 230', text: '#f0eee6', dim: '#8a857b', inactive: 'rgba(240, 238, 230, .08)',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#1e1d1b',
  },
  ember: {
    name: 'Ember', note: 'Black with a hotter glow',
    bg: '#0d0907', glow: '#3d1a0c', bar: '18, 13, 11', glass: '25, 18, 15', card: '26, 19, 16',
    ink: '243, 236, 228', text: '#f3ece4', dim: '#9d8f84', inactive: 'rgba(224, 106, 63, .14)',
    accent: '#e06a3f', agent: '#eab176', done: '#a3bd8f', termBlack: '#2a1f1a',
  },
  graphite: {
    name: 'Graphite', note: 'Cool neutral dark',
    bg: '#101113', glow: '#221a17', bar: '20, 21, 23', glass: '27, 28, 31', card: '27, 28, 31',
    ink: '236, 236, 236', text: '#ececec', dim: '#8e9096', inactive: 'rgba(160, 165, 175, .15)',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#2a2b2f',
  },
  claude: {
    name: 'Claude', note: 'Classic warm charcoal',
    bg: '#1a1918', glow: '#2e2219', bar: '31, 30, 29', glass: '38, 38, 36', card: '38, 38, 36',
    ink: '240, 238, 230', text: '#f0eee6', dim: '#9c978b', inactive: 'rgba(176, 168, 152, .18)',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#2b2a27',
  },

  midnight: {
    name: 'Midnight', note: 'Deep navy blue',
    bg: '#0b1020', glow: '#14234a', bar: '15, 21, 40', glass: '21, 29, 54', card: '19, 27, 50',
    ink: '230, 235, 245', text: '#e6ebf5', dim: '#8391ad', inactive: 'rgba(120, 150, 210, .15)',
    accent: '#5b9cff', agent: '#a78bfa', done: '#6fd3a0', termBlack: '#1b2340',
    ansi: {
      red: '#ff6b7f', green: '#6fd3a0', yellow: '#f5c76b', blue: '#5b9cff',
      magenta: '#c38bfa', cyan: '#5fd4e6', white: '#c9d2e3',
      brightBlack: '#4a5677', brightRed: '#ff8b9b', brightGreen: '#8fe3b8', brightYellow: '#ffd98c',
      brightBlue: '#86b6ff', brightMagenta: '#d6aaff', brightCyan: '#86e3f0', brightWhite: '#f2f5fb',
    },
  },
  terminal: {
    name: 'Terminal', note: 'Green phosphor CRT',
    bg: '#030a05', glow: '#0b2a12', bar: '6, 15, 9', glass: '10, 22, 13', card: '11, 23, 14',
    ink: '168, 240, 180', text: '#a8f0b4', dim: '#5f9a6a', inactive: 'rgba(51, 255, 102, .12)',
    accent: '#33ff66', agent: '#ffb000', done: '#7dff9b', termBlack: '#0f1f13',
    ansi: {
      red: '#ff5f56', green: '#33ff66', yellow: '#d4e157', blue: '#4fc3f7',
      magenta: '#c77dff', cyan: '#5ff5d0', white: '#a8f0b4',
      brightBlack: '#3b6b45', brightRed: '#ff8a80', brightGreen: '#7dff9b', brightYellow: '#eeff8a',
      brightBlue: '#81d4fa', brightMagenta: '#dcaaff', brightCyan: '#9ffbe6', brightWhite: '#e0ffe6',
    },
  },
  nord: {
    name: 'Nord', note: 'Arctic blue-grey',
    bg: '#2e3440', glow: '#2f4556', bar: '50, 56, 69', glass: '59, 66, 82', card: '56, 62, 77',
    ink: '236, 239, 244', text: '#eceff4', dim: '#9aa3b5', inactive: 'rgba(136, 192, 208, .15)',
    accent: '#88c0d0', agent: '#b48ead', done: '#a3be8c', termBlack: '#3b4252',
    ansi: {
      red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1',
      magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  dracula: {
    name: 'Dracula', note: 'Purple vampire dark',
    bg: '#282a36', glow: '#3a2f55', bar: '44, 46, 59', glass: '52, 55, 70', card: '49, 51, 66',
    ink: '248, 248, 242', text: '#f8f8f2', dim: '#8e96bd', inactive: 'rgba(189, 147, 249, .15)',
    accent: '#bd93f9', agent: '#ff79c6', done: '#50fa7b', termBlack: '#343746',
    ansi: {
      red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9',
      magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  tokyonight: {
    name: 'Tokyo Night', note: 'Neon city night',
    bg: '#1a1b26', glow: '#232a4d', bar: '31, 32, 45', glass: '36, 40, 59', card: '34, 36, 52',
    ink: '192, 202, 245', text: '#c0caf5', dim: '#7982a9', inactive: 'rgba(122, 162, 247, .14)',
    accent: '#7aa2f7', agent: '#bb9af7', done: '#9ece6a', termBlack: '#24283b',
    ansi: {
      red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7',
      magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  catppuccin: {
    name: 'Catppuccin Mocha', note: 'Soothing pastel dark',
    bg: '#1e1e2e', glow: '#2e2545', bar: '36, 36, 54', glass: '49, 50, 68', card: '42, 43, 60',
    ink: '205, 214, 244', text: '#cdd6f4', dim: '#9399b2', inactive: 'rgba(203, 166, 247, .14)',
    accent: '#cba6f7', agent: '#fab387', done: '#a6e3a1', termBlack: '#313244',
    ansi: {
      red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa',
      magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
  gruvbox: {
    name: 'Gruvbox Dark', note: 'Retro warm groove',
    bg: '#282828', glow: '#3a2c1c', bar: '46, 44, 43', glass: '60, 56, 54', card: '54, 51, 49',
    ink: '235, 219, 178', text: '#ebdbb2', dim: '#a89984', inactive: 'rgba(254, 128, 25, .14)',
    accent: '#fe8019', agent: '#fabd2f', done: '#b8bb26', termBlack: '#3c3836',
    ansi: {
      red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588',
      magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  rosepine: {
    name: 'Rosé Pine', note: 'Muted rose and pine',
    bg: '#191724', glow: '#2d2238', bar: '31, 29, 46', glass: '38, 35, 58', card: '34, 32, 52',
    ink: '224, 222, 244', text: '#e0def4', dim: '#908caa', inactive: 'rgba(235, 188, 186, .13)',
    accent: '#ebbcba', agent: '#f6c177', done: '#9ccfd8', termBlack: '#26233a',
    ansi: {
      red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8',
      magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177',
      brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
  },
  everforest: {
    name: 'Everforest', note: 'Soft forest green',
    bg: '#2d353b', glow: '#34432f', bar: '52, 63, 68', glass: '61, 72, 77', card: '57, 67, 72',
    ink: '211, 198, 170', text: '#d3c6aa', dim: '#9da9a0', inactive: 'rgba(167, 192, 128, .15)',
    accent: '#a7c080', agent: '#dbbc7f', done: '#83c092', termBlack: '#3d484d',
    ansi: {
      red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3',
      magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#859289', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f',
      brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#d3c6aa',
    },
  },
  solarized: {
    name: 'Solarized Dark', note: 'Precision teal dark',
    bg: '#002b36', glow: '#063e4c', bar: '4, 49, 61', glass: '7, 54, 66', card: '6, 52, 64',
    ink: '147, 161, 161', text: '#93a1a1', dim: '#7c8f95', inactive: 'rgba(38, 139, 210, .16)',
    accent: '#268bd2', agent: '#b58900', done: '#859900', termBlack: '#073642',
    ansi: {
      red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2',
      magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
      brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#fdf6e3',
    },
  },
  onedark: {
    name: 'One Dark', note: 'Atom editor classic',
    bg: '#282c34', glow: '#2c3547', bar: '44, 49, 58', glass: '53, 59, 69', card: '49, 54, 64',
    ink: '171, 178, 191', text: '#abb2bf', dim: '#8a909b', inactive: 'rgba(97, 175, 239, .14)',
    accent: '#61afef', agent: '#c678dd', done: '#98c379', termBlack: '#3e4451',
    ansi: {
      red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef',
      magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#d19a66',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#dcdfe4',
    },
  },
};

const ACCENTS = [
  ['#d97757', 'Terracotta'], ['#c96442', 'Clay'], ['#e3a35a', 'Amber'],
  ['#e0786f', 'Coral'], ['#9cb88a', 'Sage'], ['#9a8fd1', 'Iris'],
  ['#5b9cff', 'Blue'], ['#3fb8a8', 'Teal'], ['#b48ef5', 'Violet'],
  ['#f07ab8', 'Pink'], ['#6fcf7f', 'Green'], ['#e5c07b', 'Gold'],
];

if (typeof module !== 'undefined') module.exports = { THEMES, ACCENTS };
