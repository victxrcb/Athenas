export type ThemeId = 'catedral' | 'ametista' | 'floresta' | 'ambar' | 'oceano' | 'preto-branco' | 'grafite' | 'rose' | 'menta' | 'crepusculo' | 'meia-noite' | 'pergaminho' | 'nevoa';

export const DEFAULT_THEME: ThemeId = 'preto-branco';

export const THEMES: { id: ThemeId; name: string; swatch: [string, string, string]; light?: boolean }[] = [
  { id: 'preto-branco', name: 'Preto e Branco', swatch: ['#0a0a0a', '#ededed', '#808080'] },
  { id: 'catedral', name: 'Catedral', swatch: ['#0b0b0d', '#8b1e2d', '#b08d4a'] },
  { id: 'ametista', name: 'Ametista', swatch: ['#0d0b12', '#6d3fa0', '#b59ad6'] },
  { id: 'floresta', name: 'Floresta', swatch: ['#0a0e0c', '#2f6b4f', '#a3b18a'] },
  { id: 'ambar', name: 'Âmbar', swatch: ['#100c08', '#b4561f', '#d9a441'] },
  { id: 'oceano', name: 'Oceano', swatch: ['#090d12', '#2b6a8f', '#7fb3c8'] },
  { id: 'grafite', name: 'Grafite', swatch: ['#0e0f11', '#5c6670', '#c2c8cf'] },
  { id: 'rose', name: 'Rosé', swatch: ['#120b0e', '#b0456a', '#e3a6bb'] },
  { id: 'menta', name: 'Menta', swatch: ['#08100f', '#1f8a78', '#8fd6c4'] },
  { id: 'crepusculo', name: 'Crepúsculo', swatch: ['#110b10', '#c2503f', '#e8a15c'] },
  { id: 'meia-noite', name: 'Meia-noite', swatch: ['#080a14', '#3d4fc2', '#9aa7f0'] },
  { id: 'pergaminho', name: 'Pergaminho', swatch: ['#f3ede0', '#8b1e2d', '#8a6a2b'], light: true },
  { id: 'nevoa', name: 'Névoa', swatch: ['#eef1f5', '#2f5fa8', '#6b7f99'], light: true },
];

const KEY = 'athenas-theme';

export function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(KEY);
    if (THEMES.some((theme) => theme.id === saved)) return saved as ThemeId;
  } catch { /* storage may be unavailable */ }
  return DEFAULT_THEME;
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
  const light = THEMES.some((theme) => theme.light && theme.id === document.documentElement.dataset.theme);
  return {
    background: read('--bg-0', '#0a0a0a'),
    foreground: read('--fg', '#ededed'),
    cursor: read('--blood', '#ededed'),
    selectionBackground: read('--selection', '#ffffff2e'),
    black: light ? '#2a2620' : '#17171a', red: '#a74452', green: '#668d6a', yellow: '#ae9258',
    blue: '#6a7fa0', magenta: '#937096', cyan: '#6b9294', white: read('--fg', '#d8d2c4'),
    brightBlack: read('--fg-faint', '#5a5750'), brightRed: '#c25a68', brightGreen: '#85ab89', brightYellow: '#c2a96f',
    brightBlue: '#8ea2bd', brightMagenta: '#aa89ae', brightCyan: '#87adae', brightWhite: light ? '#1b1813' : '#f1ede4',
  };
}
