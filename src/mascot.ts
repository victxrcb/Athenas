import { useSyncExternalStore } from 'react';

/** Customizable pixel mascot used as the Claude Code mark. */
export type MascotEyes = 'tall' | 'dot' | 'happy' | 'sleepy';
export type MascotOutfit = 'none' | 'beach' | 'halloween' | 'christmas' | 'party' | 'formal' | 'pirate' | 'winter';
export type MascotConfig = { color: string; eyes: MascotEyes; antennas: boolean; blush: boolean; outfit: MascotOutfit };

export const DEFAULT_MASCOT: MascotConfig = { color: '#ff7a80', eyes: 'tall', antennas: false, blush: false, outfit: 'none' };
export const MASCOT_COLORS = ['#ff7a80', '#d97757', '#f5c04a', '#6fd3a0', '#5fb7f5', '#a98bf5', '#f58bd0', '#e8e8e8'];
export const MASCOT_EYES: { id: MascotEyes; label: string }[] = [
  { id: 'tall', label: 'Altos' }, { id: 'dot', label: 'Pontos' }, { id: 'happy', label: 'Felizes' }, { id: 'sleepy', label: 'Sonolentos' },
];

const KEY = 'athenas-mascot';
const EVENT = 'athenas-mascot';
const HEX = /^#[0-9a-f]{6}$/i;

/** 13×9 grid. `#` body, `.` empty. Eyes, antennas and blush are drawn on top. */
export const MASCOT_BODY = [
  '..#########..',
  '..#########..',
  '..#########..',
  '..#########..',
  '#############',
  '#############',
  '..#########..',
  '..#.#...#.#..',
  '..#.#...#.#..',
];
export const MASCOT_EYE_PIXELS: Record<MascotEyes, [number, number][]> = {
  tall: [[3, 2], [3, 3], [9, 2], [9, 3]],
  dot: [[3, 3], [9, 3]],
  happy: [[2, 3], [3, 2], [4, 3], [8, 3], [9, 2], [10, 3]],
  sleepy: [[3, 3], [4, 3], [8, 3], [9, 3]],
};
export const MASCOT_ANTENNA_PIXELS: [number, number][] = [[4, -2], [4, -1], [8, -2], [8, -1]];
export const MASCOT_BLUSH_PIXELS: [number, number][] = [[2, 4], [10, 4]];

/** Outfit pixel: [x, y, fill]. Negative y draws above the head (hats). Drawn over body, eyes and blush. */
export type OutfitPixel = [number, number, string];

const span = (y: number, from: number, to: number, fill: string): OutfitPixel[] =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, y, fill] as OutfitPixel);
const at = (fill: string, ...points: [number, number][]): OutfitPixel[] => points.map(([x, y]) => [x, y, fill] as OutfitPixel);

const INK = '#10181a';
const WHITE = '#f4f4f4';

export const MASCOT_OUTFITS: { id: MascotOutfit; label: string; pixels: OutfitPixel[] }[] = [
  { id: 'none', label: 'Nenhum', pixels: [] },
  { id: 'beach', label: 'Praia', pixels: [
    // óculos de sol + sunga listrada
    ...span(2, 2, 10, INK), ...span(3, 2, 4, INK), ...span(3, 8, 10, INK), ...at('#4a5a60', [2, 2], [8, 2]),
    ...span(6, 2, 10, '#2f8fe0'), ...at('#e8f4ff', [4, 6], [6, 6], [8, 6]), ...at('#2f8fe0', [2, 7], [4, 7], [8, 7], [10, 7]),
  ] },
  { id: 'halloween', label: 'Halloween', pixels: [
    // chapéu de bruxa + abóbora na mão
    ...span(-1, 1, 11, '#5b3a85'), ...span(-2, 4, 8, '#f28c28'), ...span(-3, 5, 7, '#5b3a85'), ...at('#5b3a85', [7, -4], [8, -5]),
    ...at('#f28c28', [11, 3], [12, 3], [11, 4], [12, 4]), ...at('#3f8f3a', [12, 2]),
  ] },
  { id: 'christmas', label: 'Natal', pixels: [
    // gorro do Papai Noel
    ...span(-1, 2, 10, WHITE), ...span(-2, 3, 9, '#d63a3a'), ...span(-3, 5, 9, '#d63a3a'), ...span(-4, 8, 10, '#d63a3a'), ...at(WHITE, [11, -4]),
  ] },
  { id: 'party', label: 'Festa', pixels: [
    // chapéu de festa + confete
    ...span(-1, 4, 8, '#f5c04a'), ...span(-2, 5, 7, '#5fb7f5'), ...at('#f5c04a', [6, -3]), ...at('#f58bd0', [6, -4], [11, -3]),
    ...at('#6fd3a0', [1, -3], [12, -1]), ...at('#a98bf5', [0, -1]),
  ] },
  { id: 'formal', label: 'Formal', pixels: [
    // cartola + gravata borboleta
    ...span(-1, 3, 9, '#2e2e38'), ...span(-2, 4, 8, '#c0392b'), ...span(-3, 4, 8, '#2e2e38'), ...span(-4, 4, 8, '#2e2e38'),
    ...at('#c0392b', [5, 4], [5, 5], [7, 4], [7, 5]), ...at('#8e2a20', [6, 4], [6, 5]),
  ] },
  { id: 'pirate', label: 'Pirata', pixels: [
    // chapéu pirata + tapa-olho
    ...span(-1, 1, 11, '#f5c04a'), ...span(-2, 2, 10, '#3a3a44'), ...span(-3, 4, 8, '#3a3a44'), ...at(WHITE, [6, -2]),
    ...span(1, 3, 7, INK), ...span(2, 8, 10, INK), ...span(3, 8, 10, INK),
  ] },
  { id: 'winter', label: 'Inverno', pixels: [
    // gorro com pompom + cachecol
    ...span(-1, 2, 10, '#3d8fd1'), ...span(-2, 3, 9, '#5fb7f5'), ...at(WHITE, [6, -3]),
    ...span(4, 2, 10, '#d63a3a'), ...at('#d63a3a', [9, 5], [9, 6]), ...at(WHITE, [4, 4], [8, 4]),
  ] },
];

export const outfitPixels = (outfit: MascotOutfit): OutfitPixel[] => MASCOT_OUTFITS.find((item) => item.id === outfit)?.pixels ?? [];

export function sanitizeMascot(value: unknown): MascotConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<MascotConfig>;
  return {
    color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color.toLowerCase() : DEFAULT_MASCOT.color,
    eyes: MASCOT_EYES.some((item) => item.id === raw.eyes) ? (raw.eyes as MascotEyes) : DEFAULT_MASCOT.eyes,
    antennas: raw.antennas === true,
    blush: raw.blush === true,
    outfit: MASCOT_OUTFITS.some((item) => item.id === raw.outfit) ? (raw.outfit as MascotOutfit) : DEFAULT_MASCOT.outfit,
  };
}

let cache: MascotConfig | null = null;

export function loadMascot(): MascotConfig {
  if (cache) return cache;
  try {
    const saved = localStorage.getItem(KEY);
    cache = sanitizeMascot(saved ? JSON.parse(saved) : null);
  } catch { cache = DEFAULT_MASCOT; }
  return cache;
}

export function saveMascot(config: MascotConfig): void {
  cache = sanitizeMascot(config);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* mascot still applies for this session */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const subscribe = (callback: () => void) => { window.addEventListener(EVENT, callback); return () => window.removeEventListener(EVENT, callback); };

export const useMascot = (): MascotConfig => useSyncExternalStore(subscribe, loadMascot, () => DEFAULT_MASCOT);
