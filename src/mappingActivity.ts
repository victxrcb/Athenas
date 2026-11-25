import { useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { sessionLabel, useActivityStore } from './activity';
import { sessionStatus, type StatusTone } from './status';
import { useAppStore } from './store';

const kinds = {
  started: ['Sessão iniciada', 'running'],
  working: ['Processamento iniciado', 'running'],
  approval: ['Aguardando interação', 'waiting'],
  done: ['Turno concluído', 'done'],
  idle: ['Interação interrompida', 'idle'],
  ended: ['Sessão encerrada', 'idle'],
  error: ['Erro na sessão', 'error'],
  sent: ['Mensagem entregue', 'done'],
  failed: ['Falha na entrega', 'error'],
} as const satisfies Record<string, readonly [string, StatusTone]>;
export const MAPPING_EVENT_KINDS = kinds;
export type MappingEventKind = keyof typeof kinds;
export type MappingEvent = { id: string; sessionId: string; agent: string; kind: MappingEventKind; at: number; relatedId?: string };
const KEY = 'athenas-mapping-events';
const LIMIT = 240;

function loadEvents(): MappingEvent[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((event) => event && typeof event.id === 'string' && typeof event.sessionId === 'string' && Object.hasOwn(kinds, event.kind) && Number.isFinite(event.at)).slice(-LIMIT) : [];
  } catch { return []; }
}

export const useMappingEvents = create<{ events: MappingEvent[] }>(() => ({ events: loadEvents() }));
let nextEventId = 0;

export function latestMappingEvent(events: MappingEvent[], match: (event: MappingEvent) => boolean) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (match(events[index])) return events[index];
  }
}

function record(sessionId: string, kind: MappingEventKind, at = Date.now(), relatedId?: string) {
  const session = useAppStore.getState().sessions.find((entry) => entry.id === sessionId);
  // Store event metadata only. Prompt, terminal output and provider messages stay out of the timeline.
  const event = { id: `${at}-${++nextEventId}-${sessionId}`, sessionId, agent: session?.agent ?? 'Agente', kind, at, relatedId };
  useMappingEvents.setState(({ events }) => ({ events: [...events.slice(1 - LIMIT), event] }));
}

export function mappingEventDescription(event: MappingEvent, sessions = useAppStore.getState().sessions) {
  const name = (id: string) => {
    const session = sessions.find((entry) => entry.id === id);
    return session ? sessionLabel(session) : undefined;
  };
  const recipient = event.relatedId && name(event.relatedId);
  return [name(event.sessionId) ?? event.agent, recipient].filter(Boolean).join(' → ');
}

export function useMappingEventTracking() {
  useEffect(() => {
    let writeTimer = 0;
    const save = () => {
      window.clearTimeout(writeTimer);
      try { localStorage.setItem(KEY, JSON.stringify(useMappingEvents.getState().events)); } catch { /* history stays available in memory */ }
    };
    const stopSaving = useMappingEvents.subscribe(() => {
      window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(save, 500);
    });
    const stopSessions = useAppStore.subscribe((state, previous) => {
      if (state.sessions === previous.sessions) return;
      const before = new Map(previous.sessions.map((session) => [session.id, session.status]));
      for (const session of state.sessions) {
        const old = before.get(session.id);
        if (old === session.status) continue;
        if (session.status === 'rodando') record(session.id, 'started');
        else if (old && session.status === 'erro') record(session.id, 'error');
        else if (old && sessionStatus(session.status).label === 'Encerrado') record(session.id, 'ended');
      }
    });
    const stopActivity = useActivityStore.subscribe((state, previous) => {
      if (state.activity === previous.activity) return;
      for (const [id, item] of Object.entries(state.activity)) {
        const old = previous.activity[id];
        if (old?.state === item.state && old.since === item.since) continue;
        if (item.state === 'idle' && !old) continue;
        record(id, item.state, item.since);
      }
    });
    const messages = isTauri() ? listen<{ fromId: string | null; toId: string; error: string | null }>('agent-message', ({ payload }) => {
      record(payload.fromId ?? payload.toId, payload.error ? 'failed' : 'sent', Date.now(), payload.fromId ? payload.toId : undefined);
    }) : null;
    window.addEventListener('pagehide', save);
    return () => {
      save();
      stopSaving();
      stopSessions();
      stopActivity();
      window.removeEventListener('pagehide', save);
      void messages?.then((off) => off());
    };
  }, []);
}
