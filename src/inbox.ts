import { useMemo, useSyncExternalStore } from 'react';
import { useActivityStore, type Activity } from './activity';
import type { WorkerLike } from './notifications';
import { useAppStore, type SessionInfo } from './store';

/** What waits for the user: sessions asking for approval or with an unseen finished turn, and workers that stopped. */
export type InboxItem = {
  key: string;
  kind: 'approval' | 'done' | 'error';
  source: 'session' | 'worker';
  id: string;
  agent: string;
  title: string;
  detail: string;
  folder: string;
  at: number;
};

const WORKER_KINDS: Record<string, InboxItem['kind']> = { awaiting_permission: 'approval', interrupted: 'approval', failed: 'error', completed: 'done' };
const WORKER_AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
/** Finished workers stay in the inbox for this long unless dismissed. */
const RECENT_MS = 12 * 3600_000;

export function inboxItems(
  sessions: SessionInfo[],
  activity: Record<string, Activity>,
  workers: WorkerLike[],
  dismissed: Record<string, true>,
  now = Date.now(),
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const session of sessions) {
    const current = activity[session.id];
    if (session.status !== 'rodando' || !current) continue;
    const pending = current.state === 'approval' || (current.state === 'done' && current.unread);
    if (!pending) continue;
    items.push({
      key: `session:${session.id}:${current.since}`, kind: current.state === 'approval' ? 'approval' : 'done', source: 'session', id: session.id,
      agent: session.agent, title: session.title?.trim() || session.agent, detail: current.message, folder: session.folder, at: current.since,
    });
  }
  for (const worker of workers) {
    const kind = WORKER_KINDS[worker.status];
    if (!kind) continue;
    const finished = (worker.finishedAt ?? 0) * 1000;
    if (kind !== 'approval' && (!finished || now - finished > RECENT_MS)) continue;
    const key = `worker:${worker.id}:${worker.status}`;
    if (dismissed[key]) continue;
    items.push({
      key, kind, source: 'worker', id: worker.id, agent: WORKER_AGENT[worker.agent] ?? 'Shell', title: worker.brief.split('\n')[0].slice(0, 90),
      detail: kind === 'approval' ? worker.permissionRequest ?? '' : kind === 'error' ? worker.error ?? '' : '', folder: worker.project ?? '', at: finished || now,
    });
  }
  // Decisions first, then the most recent.
  const rank = { approval: 0, error: 1, done: 2 };
  return items.sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at);
}

const KEY = 'athenas-inbox-dismissed';
const EVENT = 'athenas-inbox-dismissed';
let cache: Record<string, true> | null = null;

export function loadDismissed(): Record<string, true> {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, true>; } catch { cache = {}; }
  return cache;
}

export function dismissKeys(keys: string[]) {
  const next = { ...loadDismissed() };
  for (const key of keys) next[key] = true;
  // Keep the list bounded: worker keys only matter while those workers are recent.
  const entries = Object.entries(next).slice(-300);
  cache = Object.fromEntries(entries) as Record<string, true>;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* still dismissed for this run */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const subscribe = (callback: () => void) => { window.addEventListener(EVENT, callback); return () => window.removeEventListener(EVENT, callback); };
export const useDismissed = () => useSyncExternalStore(subscribe, loadDismissed, () => ({}));

/** Live list of everything waiting for the user. */
export function useInboxItems() {
  const sessions = useAppStore((state) => state.sessions);
  const activity = useActivityStore((state) => state.activity);
  const workers = useActivityStore((state) => state.workers);
  const dismissed = useDismissed();
  return useMemo(() => inboxItems(sessions, activity, workers, dismissed), [sessions, activity, workers, dismissed]);
}

/** "agora", "há 5 min", "há 2 h", "há 3 d". */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}
