const KEY = 'athenas-terminal-tab-order';

export type TabOrder = Record<string, string[]>;

export function sanitizeTabOrder(value: unknown): TabOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: TabOrder = {};
  const used = new Set<string>();
  for (const [paneId, sessionIds] of Object.entries(value)) {
    if (!paneId || !Array.isArray(sessionIds)) continue;
    const clean: string[] = [];
    for (const id of sessionIds) {
      if (typeof id !== 'string' || !id || used.has(id)) continue;
      used.add(id);
      clean.push(id);
      if (clean.length === 200) break;
    }
    if (clean.length) result[paneId] = clean;
  }
  return result;
}

export function loadTabOrder(): TabOrder {
  try { return sanitizeTabOrder(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { return {}; }
}

export function saveTabOrder(order: TabOrder) {
  try { localStorage.setItem(KEY, JSON.stringify(order)); } catch { /* ordering still applies for this session */ }
}

export function sortTabs<T extends { id: string }>(order: TabOrder, paneId: string, tabs: T[]): T[] {
  const positions = new Map((order[paneId] ?? []).map((id, index) => [id, index]));
  return tabs.map((tab, index) => ({ tab, index, position: positions.get(tab.id) }))
    .sort((a, b) => {
      if (a.position === undefined && b.position === undefined) return a.index - b.index;
      if (a.position === undefined) return 1;
      if (b.position === undefined) return -1;
      return a.position - b.position;
    })
    .map(({ tab }) => tab);
}

/** Moves one tab before another tab, or to the end when beforeId is null. */
export function moveTab(order: TabOrder, id: string, targetPaneId: string, targetTabIds: string[], beforeId: string | null): TabOrder {
  const next = Object.fromEntries(Object.entries(order).map(([paneId, ids]) => [paneId, ids.filter((item) => item !== id)]));
  const current = sortTabs(next, targetPaneId, targetTabIds.map((tabId) => ({ id: tabId })))
    .map((item) => item.id)
    .filter((item) => item !== id);
  const index = beforeId ? current.indexOf(beforeId) : -1;
  current.splice(index >= 0 ? index : current.length, 0, id);
  next[targetPaneId] = current;
  return next;
}
