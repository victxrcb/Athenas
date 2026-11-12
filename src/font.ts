/** Fonte da interface. Sobrescreve a variável CSS --font-ui; o terminal continua com a fonte mono. */
export type FontPreset = { id: string; name: string; stack: string };

export const DEFAULT_FONT = 'inter';
const FALLBACK = "system-ui, sans-serif";

export const FONT_PRESETS: FontPreset[] = [
  { id: 'inter', name: 'Inter', stack: `Inter, 'Segoe UI Variable', 'Segoe UI', ${FALLBACK}` },
  { id: 'system', name: 'Padrão do sistema', stack: `system-ui, -apple-system, 'Segoe UI Variable', 'Segoe UI', sans-serif` },
  { id: 'segoe', name: 'Segoe UI', stack: `'Segoe UI Variable', 'Segoe UI', ${FALLBACK}` },
  { id: 'arial', name: 'Arial', stack: `Arial, Helvetica, ${FALLBACK}` },
  { id: 'verdana', name: 'Verdana', stack: `Verdana, Tahoma, ${FALLBACK}` },
  { id: 'calibri', name: 'Calibri', stack: `Calibri, Carlito, ${FALLBACK}` },
  { id: 'georgia', name: 'Georgia', stack: `Georgia, 'Times New Roman', serif` },
  { id: 'mono', name: 'JetBrains Mono', stack: `'JetBrains Mono', 'Cascadia Mono', Consolas, monospace` },
];

export type FontChoice = { id: string; custom: string };

const KEY = 'athenas-font';
/** Nome de fonte instalada: só letras, números, espaço, hífen, ponto e sublinhado (evita injeção de CSS). */
const SAFE_NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;

export const isValidFontName = (name: string) => SAFE_NAME.test(name.trim());

export function sanitizeFont(value: unknown): FontChoice {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<FontChoice>;
  const custom = typeof raw.custom === 'string' && isValidFontName(raw.custom) ? raw.custom.trim() : '';
  if (raw.id === 'custom' && custom) return { id: 'custom', custom };
  return { id: FONT_PRESETS.some((item) => item.id === raw.id) ? raw.id as string : DEFAULT_FONT, custom };
}

export function fontStack(choice: FontChoice): string {
  if (choice.id === 'custom' && choice.custom) return `"${choice.custom}", ${FONT_PRESETS[0].stack}`;
  return (FONT_PRESETS.find((item) => item.id === choice.id) ?? FONT_PRESETS[0]).stack;
}

export function loadFont(): FontChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return sanitizeFont(saved ? JSON.parse(saved) : null);
  } catch { return { id: DEFAULT_FONT, custom: '' }; }
}

export function applyFont(choice: FontChoice): FontChoice {
  const next = sanitizeFont(choice);
  document.documentElement.style.setProperty('--font-ui', fontStack(next));
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* vale só nesta sessão */ }
  return next;
}
