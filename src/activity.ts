import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sessionStatus, type StatusInfo } from './status';
import { useAppStore, type SessionInfo } from './store';
import type { WorkerLike } from './notifications';

/**
 * Live state of each running session, fed by Claude hooks, Codex OSC 9 notifications and the user's own input:
 * working (turn in progress), approval (waiting for a decision), done (turn finished) or idle.
 */
export type ActivityState = 'working' | 'approval' | 'done' | 'idle';
export type Activity = { state: ActivityState; since: number; unread: boolean; message: string };
type ActivityStore = {
  activity: Record<string, Activity>;
  /** Dev-server addresses printed by each session, oldest first. */
  urls: Record<string, string[]>;
  set: (id: string, activity: Activity) => void;
  clear: (id: string) => void;
  markRead: (id: string) => void;
  addUrl: (id: string, url: string) => void;
  /** Latest orchestrator workers, from the navigation poll. */
  workers: WorkerLike[];
  setWorkers: (workers: WorkerLike[]) => void;
};

export const useActivityStore = create<ActivityStore>((set) => ({
  activity: {},
  urls: {},
  set: (id, activity) => set((state) => ({ activity: { ...state.activity, [id]: activity } })),
  clear: (id) => set((state) => {
    if (!(id in state.activity) && !(id in state.urls)) return state;
    const activity = { ...state.activity }; delete activity[id];
    const urls = { ...state.urls }; delete urls[id];
    return { activity, urls };
  }),
  markRead: (id) => set((state) => {
    const current = state.activity[id];
    return current?.unread ? { activity: { ...state.activity, [id]: { ...current, unread: false } } } : state;
  }),
  workers: [],
  setWorkers: (workers) => set({ workers }),
  addUrl: (id, url) => set((state) => (state.urls[id]?.includes(url) ? state : { urls: { ...state.urls, [id]: [...(state.urls[id] ?? []), url] } })),
}));

/** Name shown for a session: the user's or automatic title, else the agent. */
export const sessionLabel = (session: Pick<SessionInfo, 'agent' | 'title'>) => session.title?.trim() || session.agent;

/** What the dot and label of a session show: process status when it ended, live activity while it runs. */
export function liveStatus(session: SessionInfo, activity: Activity | undefined): StatusInfo {
  if (session.status !== 'rodando' || !activity) return sessionStatus(session.status);
  switch (activity.state) {
    case 'working': return { tone: 'running', label: 'Trabalhando', live: true };
    case 'approval': return { tone: 'waiting', label: 'Aguardando você', live: false };
    case 'done': return activity.unread ? { tone: 'done', label: 'Terminou', live: false } : { tone: 'idle', label: 'Pronto', live: false };
    default: return { tone: 'idle', label: 'Pronto', live: false };
  }
}

/** The session is visible in the focused window, so anything it reports is already seen. */
export function sessionOnScreen(session: SessionInfo): boolean {
  if (typeof document === 'undefined' || !document.hasFocus()) return false;
  const state = useAppStore.getState();
  if (state.section !== 'home') return false;
  if (state.activeSessionId) return state.activeSessionId === session.id;
  const pane = state.workspace.panes.find((item) => item.id === session.paneId);
  return Boolean(pane && pane.projectId === state.activeProjectId);
}

export function applyAttention(previous: Activity | undefined, kind: string, message: string, onScreen: boolean, now = Date.now()): Activity {
  if (kind === 'working') return { state: 'working', since: now, unread: false, message: '' };
  if (kind === 'approval') return { state: 'approval', since: now, unread: true, message };
  if (kind === 'done' || kind === 'error') return { state: 'done', since: now, unread: !onScreen, message };
  return previous ?? { state: 'idle', since: now, unread: false, message: '' };
}

function setState(session: SessionInfo, kind: string, message = '') {
  const store = useActivityStore.getState();
  store.set(session.id, applyAttention(store.activity[session.id], kind, message, sessionOnScreen(session)));
}

/**
 * Turns keystrokes into activity: Enter submits a prompt (Codex has no hook for it), any key answers a
 * pending approval, and Esc interrupts. It also rebuilds the typed line so Codex sessions get a title.
 */
export function createInputTracker(session: SessionInfo) {
  let line = '';
  return (data: string) => {
    const current = useActivityStore.getState().activity[session.id];
    if (session.agent === 'Shell') return;
    if (data === '\x1b') {
      // Esc interrupts the turn, and Claude skips its Stop hook on interruptions.
      if (current?.state === 'working' || current?.state === 'approval') useActivityStore.getState().set(session.id, { state: 'idle', since: Date.now(), unread: false, message: '' });
      line = '';
      return;
    }
    if (current?.state === 'approval') setState(session, 'working');
    if (data.startsWith('\x1b[200~')) { line += data.replace('\x1b[200~', '').replace('\x1b[201~', ''); return; }
    if (data.startsWith('\x1b')) return;
    for (const char of data) {
      if (char === '\r') {
        const prompt = line.trim();
        line = '';
        if (session.agent === 'Codex' && prompt) {
          setState(session, 'working');
          if (!session.title && isTauri()) void invoke('terminal_auto_title', { id: session.id, prompt }).catch(() => undefined);
        }
      } else if (char === '\x7f' || char === '\b') line = line.slice(0, -1);
      else if (char === '\x15') line = '';
      else if (char >= ' ') line += char;
    }
  };
}

/** Feeds the activity store from backend events and clears "unread" once the user is looking. */
export function useActivityTracking() {
  useEffect(() => {
    if (!isTauri()) return;
    const sessionById = (id: string) => useAppStore.getState().sessions.find((item) => item.id === id);
    const attention = listen<{ sessionId: string; kind: string; message: string }>('agent-attention', ({ payload }) => {
      const session = sessionById(payload.sessionId);
      if (session) setState(session, payload.kind, payload.message);
    });
    const status = listen<SessionInfo>('terminal-status', ({ payload }) => {
      useAppStore.getState().upsertSession(payload);
      if (payload.status !== 'rodando') useActivityStore.getState().clear(payload.id);
    });
    const urls = listen<{ sessionId: string; url: string }>('session-url', ({ payload }) => useActivityStore.getState().addUrl(payload.sessionId, payload.url));
    const markVisible = () => {
      const { activity, markRead } = useActivityStore.getState();
      for (const [id, item] of Object.entries(activity)) {
        if (!item.unread || item.state === 'approval') continue;
        const session = sessionById(id);
        if (session && sessionOnScreen(session)) markRead(id);
      }
    };
    const unsubscribeApp = useAppStore.subscribe(markVisible);
    window.addEventListener('focus', markVisible);
    return () => {
      void attention.then((off) => off()); void status.then((off) => off()); void urls.then((off) => off());
      unsubscribeApp(); window.removeEventListener('focus', markVisible);
    };
  }, []);
}

/** Renames a session; an empty name brings back the agent's name. */
export async function renameSession(id: string, title: string): Promise<void> {
  const updated = await invoke<SessionInfo>('terminal_rename', { id, title });
  useAppStore.getState().upsertSession(updated);
}
