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

/** The terminal keeps a fixed black/white palette; app themes only recolor the interface around it. */
export const TERMINAL_BACKGROUND = '#0a0a0a';

export function terminalPalette() {
  return {
    background: TERMINAL_BACKGROUND,
    foreground: '#ededed',
    cursor: '#ededed',
    cursorAccent: TERMINAL_BACKGROUND,
    selectionBackground: '#ffffff40',
    black: '#1a1a1a', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d4d4d4',
    brightBlack: '#7f7f7f', brightRed: '#ff7b86', brightGreen: '#b5e48c', brightYellow: '#ffd68a',
    brightBlue: '#82c4ff', brightMagenta: '#d99cf0', brightCyan: '#7fd4de', brightWhite: '#ffffff',
  };
}
