import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useActivityStore } from '../activity';
import { useAppStore, type SessionInfo } from '../store';
import { forgetChat, readSession, receiveLive, useChatStore, type LiveEvent, type PermissionRequest } from './store';

const FAST = 500;
const SLOW = 1_600;

/** Keeps one visible conversation up to date; several views of a session share the same reads. */
export function useChatSync(session: SessionInfo) {
  const running = session.status === 'rodando';
  const tick = useChatStore((state) => state.sessions[session.id]?.tick ?? 0);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let timer = 0;
    const loop = async () => {
      await readSession(session);
      if (!active) return;
      const working = useActivityStore.getState().activity[session.id]?.state === 'working';
      // A finished session gets one late read for lines flushed on exit.
      if (running) timer = window.setTimeout(loop, working ? FAST : SLOW);
    };
    void loop();
    const late = running ? 0 : window.setTimeout(() => void readSession(session), SLOW);
    return () => { active = false; window.clearTimeout(timer); window.clearTimeout(late); };
  }, [session.id, session.agent, running]);
  useEffect(() => {
    if (!tick || !isTauri()) return;
    // The file is written slightly after the hook fires.
    const timer = window.setTimeout(() => void readSession(session), 150);
    return () => window.clearTimeout(timer);
  }, [session.id, tick]);
}

function setActivity(id: string, state: 'working' | 'approval', message: string) {
  const store = useActivityStore.getState();
  const previous = store.activity[id];
  if (previous?.state === state) return;
  store.set(id, { state, since: state === 'working' ? Date.now() : previous?.since ?? Date.now(), unread: state === 'approval', message });
}

/** Moves the shared session status when requests appear or are resolved anywhere (chat or terminal). */
export function receivePermissions(list: PermissionRequest[]) {
  const previous = useChatStore.getState().permissions;
  useChatStore.setState({ permissions: list });
  for (const request of list) {
    setActivity(request.sessionId, 'approval', request.toolName === 'AskUserQuestion' ? 'O agente fez uma pergunta' : `Autorização para ${request.toolName}`);
  }
  for (const request of previous) {
    if (list.some((item) => item.sessionId === request.sessionId)) continue;
    if (useActivityStore.getState().activity[request.sessionId]?.state === 'approval') setActivity(request.sessionId, 'working', '');
  }
}

/** App-wide listeners for the live channel; mounted once by the shell. */
export function useChatEvents() {
  useEffect(() => {
    if (!isTauri()) return;
    const live = listen<{ sessionId: string; event: LiveEvent }[]>('agent-live', ({ payload }) => receiveLive(payload));
    const permissions = listen<PermissionRequest[]>('agent-permissions', ({ payload }) => receivePermissions(payload));
    void invoke<PermissionRequest[]>('chat_permissions').then((list) => { if (Array.isArray(list)) receivePermissions(list); }).catch(() => undefined);
    const removed = useAppStore.subscribe((state, before) => {
      if (state.sessions === before.sessions) return;
      for (const session of before.sessions) {
        const now = state.sessions.find((item) => item.id === session.id);
        // A restarted session may write a new conversation file.
        if (!now || (now.status === 'rodando' && session.status !== 'rodando')) forgetChat(session.id);
      }
    });
    return () => { removed(); void live.then((off) => off()); void permissions.then((off) => off()); };
  }, []);
}
