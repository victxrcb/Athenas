import { useSyncExternalStore } from 'react';

/** Customizable pixel mascot used as the Claude Code mark. */
export type MascotEyes = 'tall' | 'dot' | 'happy' | 'sleepy';
export type MascotConfig = { color: string; eyes: MascotEyes; antennas: boolean; blush: boolean };

export const DEFAULT_MASCOT: MascotConfig = { color: '#ff7a80', eyes: 'tall', antennas: false, blush: false };
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

export function sanitizeMascot(value: unknown): MascotConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<MascotConfig>;
  return {
    color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color.toLowerCase() : DEFAULT_MASCOT.color,
    eyes: MASCOT_EYES.some((item) => item.id === raw.eyes) ? (raw.eyes as MascotEyes) : DEFAULT_MASCOT.eyes,
    antennas: raw.antennas === true,
    blush: raw.blush === true,
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
