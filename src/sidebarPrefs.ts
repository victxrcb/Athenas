import { useSyncExternalStore } from 'react';

/** Navegação da sidebar: quais atalhos aparecem e se a sidebar está oculta. Guardado localmente, como tema e zoom. */
export type SidebarItemId = 'home' | 'orchestrator' | 'mapping' | 'git' | 'mcp' | 'skills';
export type SidebarPrefs = { hidden: boolean; items: Record<SidebarItemId, boolean> };

export const SIDEBAR_ITEMS: { id: SidebarItemId; label: string }[] = [
  { id: 'home', label: 'Início' },
  { id: 'orchestrator', label: 'Orquestração' },
  { id: 'mapping', label: 'Mapeamento' },
  { id: 'git', label: 'Git' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
];

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  hidden: false,
  items: { home: true, orchestrator: true, mapping: true, git: true, mcp: true, skills: true },
};

const KEY = 'athenas-sidebar';
const EVENT = 'athenas-sidebar';

export function sanitizeSidebarPrefs(value: unknown): SidebarPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as { hidden?: unknown; items?: Record<string, unknown> };
  const items = { ...DEFAULT_SIDEBAR_PREFS.items };
  for (const { id } of SIDEBAR_ITEMS) if (typeof raw.items?.[id] === 'boolean') items[id] = raw.items[id] as boolean;
  return { hidden: raw.hidden === true, items };
}

let cache: SidebarPrefs | null = null;

export function loadSidebarPrefs(): SidebarPrefs {
  if (cache) return cache;
  try {
    const saved = localStorage.getItem(KEY);
    cache = sanitizeSidebarPrefs(saved ? JSON.parse(saved) : null);
  } catch { cache = DEFAULT_SIDEBAR_PREFS; }
  return cache;
}

export function saveSidebarPrefs(next: SidebarPrefs): void {
  cache = sanitizeSidebarPrefs(next);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* a preferência continua valendo nesta sessão */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export const setSidebarHidden = (hidden: boolean) => saveSidebarPrefs({ ...loadSidebarPrefs(), hidden });
export const toggleSidebarHidden = () => setSidebarHidden(!loadSidebarPrefs().hidden);
export const setSidebarItem = (id: SidebarItemId, visible: boolean) => {
  const current = loadSidebarPrefs();
  saveSidebarPrefs({ ...current, items: { ...current.items, [id]: visible } });
};

const subscribe = (callback: () => void) => { window.addEventListener(EVENT, callback); return () => window.removeEventListener(EVENT, callback); };

export const useSidebarPrefs = (): SidebarPrefs => useSyncExternalStore(subscribe, loadSidebarPrefs, () => DEFAULT_SIDEBAR_PREFS);

/** Só para testes: descarta o cache em memória. */
export const resetSidebarPrefsCache = () => { cache = null; };
