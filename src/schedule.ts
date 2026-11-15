import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from './store';

/** A prompt typed into an agent at a given time (see `schedule.rs`). */
export type ScheduleRepeat = 'none' | 'hourly' | 'daily' | 'weekly';
export type ScheduledPrompt = {
  id: string; target: 'session' | 'new'; sessionId: string | null; agent: string; folder: string; label: string; text: string;
  runAt: number; repeat: ScheduleRepeat; status: 'pending' | 'sent' | 'failed' | 'cancelled'; lastError: string | null; lastRunAt: number | null; createdAt: number;
};
export type ScheduleDraft = { target: 'session' | 'new'; sessionId?: string; agent?: string; folder?: string };

export const REPEAT_LABELS: Record<ScheduleRepeat, string> = { none: 'Não repetir', hourly: 'A cada hora', daily: 'Todo dia', weekly: 'Toda semana' };

type ScheduleStore = {
  items: ScheduledPrompt[];
  /** Open editor and its preselected target; null when closed. */
  draft: ScheduleDraft | null;
  setItems: (items: ScheduledPrompt[]) => void;
  open: (draft: ScheduleDraft) => void;
  close: () => void;
};

export const useScheduleStore = create<ScheduleStore>((set) => ({
  items: [],
  draft: null,
  setItems: (items) => set({ items }),
  open: (draft) => set({ draft }),
  close: () => set({ draft: null }),
}));

export async function refreshSchedules() {
  if (!isTauri()) return;
  useScheduleStore.getState().setItems(await invoke<ScheduledPrompt[]>('schedule_list'));
}

/** Runs a schedule command that returns the updated list. */
export async function scheduleAction(command: 'schedule_cancel' | 'schedule_delete' | 'schedule_run_now', id: string) {
  useScheduleStore.getState().setItems(await invoke<ScheduledPrompt[]>(command, { id }));
}

export async function createSchedule(input: { target: 'session' | 'new'; sessionId: string | null; agent: string | null; folder: string | null; text: string; runAt: number; repeat: ScheduleRepeat }) {
  useScheduleStore.getState().setItems(await invoke<ScheduledPrompt[]>('schedule_create', input));
}

/** `datetime-local` value for a Date, in local time. */
export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "hoje às 14:30", "amanhã às 09:00", "12/11 às 08:00" (or with the year when it is not this year). */
export function formatWhen(seconds: number, now = new Date()): string {
  const date = new Date(seconds * 1000);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((day(date) - day(now)) / 86_400_000);
  if (diff === 0) return `hoje às ${time}`;
  if (diff === 1) return `amanhã às ${time}`;
  if (diff === -1) return `ontem às ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${date.toLocaleDateString('pt-BR', sameYear ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' })} às ${time}`;
}

/** Keeps the list fresh and reports each delivery. */
export function useScheduleEvents() {
  useEffect(() => {
    if (!isTauri()) return;
    void refreshSchedules().catch(() => undefined);
    const changed = listen('schedule-changed', () => { void refreshSchedules().catch(() => undefined); });
    const fired = listen<{ label: string; error: string | null }>('schedule-fired', ({ payload }) => {
      useAppStore.getState().setNotice(payload.error ? `Prompt agendado não enviado (${payload.label}): ${payload.error}` : `Prompt agendado enviado: ${payload.label}.`);
    });
    return () => { void changed.then((off) => off()); void fired.then((off) => off()); };
  }, []);
}
