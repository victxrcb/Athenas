export type ThemeId = 'catedral' | 'ametista' | 'floresta' | 'ambar' | 'oceano' | 'pergaminho';

export const THEMES: { id: ThemeId; name: string; swatch: [string, string, string] }[] = [
  { id: 'catedral', name: 'Catedral', swatch: ['#0b0b0d', '#8b1e2d', '#b08d4a'] },
  { id: 'ametista', name: 'Ametista', swatch: ['#0d0b12', '#6d3fa0', '#b59ad6'] },
  { id: 'floresta', name: 'Floresta', swatch: ['#0a0e0c', '#2f6b4f', '#a3b18a'] },
  { id: 'ambar', name: 'Âmbar', swatch: ['#100c08', '#b4561f', '#d9a441'] },
  { id: 'oceano', name: 'Oceano', swatch: ['#090d12', '#2b6a8f', '#7fb3c8'] },
  { id: 'pergaminho', name: 'Pergaminho', swatch: ['#f3ede0', '#8b1e2d', '#8a6a2b'] },
];

const KEY = 'athenas-theme';

export function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(KEY);
    if (THEMES.some((theme) => theme.id === saved)) return saved as ThemeId;
  } catch { /* storage may be unavailable */ }
  return 'catedral';
}

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* theme still applies for this session */ }
  window.dispatchEvent(new CustomEvent('athenas-theme'));
}

/** Reads the active palette so xterm follows the app theme. */
export function terminalPalette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const light = document.documentElement.dataset.theme === 'pergaminho';
  return {
    background: read('--bg-0', '#0b0b0d'),
    foreground: read('--fg', '#d8d2c4'),
    cursor: read('--blood', '#8b1e2d'),
    selectionBackground: read('--selection', '#8b1e2d59'),
    black: light ? '#2a2620' : '#17171a', red: '#a74452', green: '#668d6a', yellow: '#ae9258',
    blue: '#6a7fa0', magenta: '#937096', cyan: '#6b9294', white: read('--fg', '#d8d2c4'),
    brightBlack: read('--fg-faint', '#5a5750'), brightRed: '#c25a68', brightGreen: '#85ab89', brightYellow: '#c2a96f',
    brightBlue: '#8ea2bd', brightMagenta: '#aa89ae', brightCyan: '#87adae', brightWhite: light ? '#1b1813' : '#f1ede4',
  };
}
