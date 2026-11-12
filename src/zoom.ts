import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** Interface scale steps offered in settings and by Ctrl +/−/0. */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5];
const KEY = 'athenas-zoom';

export function loadZoom(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (ZOOM_LEVELS.includes(saved)) return saved;
  } catch { /* storage may be unavailable */ }
  return 1;
}

/** Scales the whole webview (text, icons and terminal) and remembers the choice. */
export async function applyZoom(level: number): Promise<void> {
  try { localStorage.setItem(KEY, String(level)); } catch { /* zoom still applies for this session */ }
  window.dispatchEvent(new CustomEvent('athenas-zoom', { detail: level }));
  if (isTauri()) await getCurrentWebview().setZoom(level);
  else document.documentElement.style.setProperty('zoom', level === 1 ? '' : String(level));
}

/** Next level up (+1) or down (−1) from the current one, clamped to the available steps. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const index = ZOOM_LEVELS.indexOf(current);
  const base = index === -1 ? ZOOM_LEVELS.indexOf(1) : index;
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, base + direction))];
}
