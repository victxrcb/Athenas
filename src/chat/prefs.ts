/** Per-viewer conveniences of the chat: view mode, width, drafts, prompt history and expanded blocks. */
import { create } from 'zustand';

export type ViewMode = 'chat' | 'terminal' | 'split';
export type ChatWidth = 'compact' | 'default' | 'wide';
type Prefs = {
  /** Mode of each session; new sessions use the last one chosen. */
  modes: Record<string, ViewMode>;
  lastMode: ViewMode;
  width: ChatWidth;
  drafts: Record<string, string>;
  history: Record<string, string[]>;
  expanded: Record<string, boolean>;
  lineNumbers: boolean;
};

const KEY = 'athenas-chat';
const DEFAULTS: Prefs = { modes: {}, lastMode: 'chat', width: 'default', drafts: {}, history: {}, expanded: {}, lineNumbers: false };

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return saved && typeof saved === 'object' ? { ...DEFAULTS, ...saved } : DEFAULTS;
  } catch { return DEFAULTS; }
}

export const useChatPrefs = create<Prefs>(load);

let timer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(timer);
  timer = setTimeout(flushPrefs, 400);
}
export function flushPrefs() {
  clearTimeout(timer);
  try { localStorage.setItem(KEY, JSON.stringify(useChatPrefs.getState())); } catch { /* kept for this window only */ }
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPrefs);

/** Newest entries win once a map grows past its limit. */
function bounded<T>(map: Record<string, T>, key: string, value: T | undefined, limit: number): Record<string, T> {
  const next = { ...map };
  delete next[key];
  if (value !== undefined) next[key] = value;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - limit))) delete next[old];
  return next;
}

function set(change: (state: Prefs) => Partial<Prefs>) {
  useChatPrefs.setState(change);
  save();
}

export const setViewMode = (id: string, mode: ViewMode) => set((state) => ({ modes: bounded(state.modes, id, mode, 200), lastMode: mode }));
export const setChatWidth = (width: ChatWidth) => set(() => ({ width }));
export const setDraft = (id: string, value: string) => set((state) => ({ drafts: bounded(state.drafts, id, value || undefined, 60) }));
export const pushHistory = (id: string, value: string) => set((state) => {
  const previous = state.history[id] ?? [];
  return { history: bounded(state.history, id, [...previous.filter((item) => item !== value), value].slice(-40), 60) };
});
export const setExpanded = (key: string, open: boolean) => set((state) => ({ expanded: bounded(state.expanded, key, open, 400) }));
export const toggleLineNumbers = () => set((state) => ({ lineNumbers: !state.lineNumbers }));
