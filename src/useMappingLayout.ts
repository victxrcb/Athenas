import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { DEFAULT_MAPPING_PREFERENCES, MAPPING_ORDERS, mergeMappingLayout, type MappingLayout, type MappingPreferences } from './mapping';
import { useAppStore } from './store';

const PREFIX = 'athenas-mapping:';
const prefsKey = (scope: string) => `${PREFIX}preferences:${scope}`;
const pendingWrites = new Map<string, Promise<void>>();

function loadPreferences(scope: string): MappingPreferences {
  const defaults = DEFAULT_MAPPING_PREFERENCES;
  try {
    const saved = JSON.parse(localStorage.getItem(prefsKey(scope)) ?? '{}') ?? {};
    return {
      order: Object.hasOwn(MAPPING_ORDERS, saved.order) ? saved.order : defaults.order,
      grid: saved.grid !== false, minimap: saved.minimap !== false, timeline: saved.timeline !== false, motion: saved.motion !== false,
      collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter((key: unknown) => typeof key === 'string') : [],
    };
  } catch { return defaults; }
}

async function loadLayout(scope: string): Promise<MappingLayout | null> {
  await pendingWrites.get(scope);
  if (isTauri()) return invoke('mapping_layout_get', { scope });
  try { return JSON.parse(localStorage.getItem(PREFIX + scope) ?? 'null'); } catch { return null; }
}

function saveLayout(scope: string, layout: MappingLayout) {
  if (!isTauri()) {
    try { localStorage.setItem(PREFIX + scope, JSON.stringify(layout)); } catch { /* local preview may disable storage */ }
    return;
  }
  const pending = (pendingWrites.get(scope) ?? Promise.resolve())
    .then(() => invoke<void>('mapping_layout_save', { scope, layout }))
    .catch((error) => useAppStore.getState().setNotice(`Não foi possível salvar o mapa: ${error}`))
    .finally(() => { if (pendingWrites.get(scope) === pending) pendingWrites.delete(scope); });
  pendingWrites.set(scope, pending);
}

export function useMappingLayout(scope: string, ids: string[]) {
  const [layout, setLayout] = useState(() => mergeMappingLayout(null, []));
  const [preferenceState, setPreferenceState] = useState(() => ({ scope, value: loadPreferences(scope) }));
  const preferences = preferenceState.scope === scope ? preferenceState.value : loadPreferences(scope);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const layoutRef = useRef(layout);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ scope: string; layout: MappingLayout } | null>(null);
  const loaded = loadedScope === scope;
  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (!pending.current) return;
    const item = pending.current;
    pending.current = null;
    saveLayout(item.scope, item.layout);
  }, []);

  const updateLayout = useCallback((apply: (value: MappingLayout) => MappingLayout, persist = false) => {
    if (!loaded) return;
    const next = apply(layoutRef.current);
    layoutRef.current = next;
    setLayout(next);
    if (persist) {
      pending.current = { scope, layout: next };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, 180);
    }
  }, [scope, loaded, flush]);

  const updatePreferences = useCallback((patch: Partial<MappingPreferences>) => {
    setPreferenceState((current) => {
      const next = { ...(current.scope === scope ? current.value : loadPreferences(scope)), ...patch };
      try { localStorage.setItem(prefsKey(scope), JSON.stringify(next)); } catch { /* changes still apply for this run */ }
      return { scope, value: next };
    });
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    setLoadedScope(null);
    setFresh(false);
    const apply = (stored: MappingLayout | null) => {
      if (cancelled) return;
      const next = mergeMappingLayout(stored, idsRef.current);
      layoutRef.current = next;
      setLayout(next);
      setFresh(!stored);
      setLoadedScope(scope);
    };
    void loadLayout(scope).then(apply).catch((error) => {
      if (cancelled) return;
      useAppStore.getState().setNotice(`Não foi possível carregar o mapa: ${error}`);
      apply(null);
    });
    window.addEventListener('pagehide', flush);
    return () => { cancelled = true; flush(); window.removeEventListener('pagehide', flush); };
  }, [scope, flush]);

  useEffect(() => {
    if (!loaded || (layoutRef.current.nodes.length === ids.length && layoutRef.current.nodes.every((node, index) => node.sessionId === ids[index]))) return;
    updateLayout((current) => mergeMappingLayout(current, ids));
  }, [ids, loaded, updateLayout]);

  return { layout, layoutRef, loaded, fresh, setFresh, updateLayout, preferences, updatePreferences };
}
