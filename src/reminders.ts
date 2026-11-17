import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { useAppStore } from './store';

export type Reminder = { id: string; text: string; scheduledAt: number | null; notifiedAt: number | null; createdAt: number };

type ReminderState = { items: Reminder[]; setItems: (items: Reminder[]) => void };
export const useReminderStore = create<ReminderState>((set) => ({ items: [], setItems: (items) => set({ items }) }));

export async function refreshReminders() {
  if (!isTauri()) return;
  useReminderStore.getState().setItems(await invoke<Reminder[]>('reminder_list'));
}

export async function createReminder(text: string, scheduledAt: number | null) {
  useReminderStore.getState().setItems(await invoke<Reminder[]>('reminder_create', { text, scheduledAt }));
}

export async function deleteReminder(id: string) {
  useReminderStore.getState().setItems(await invoke<Reminder[]>('reminder_delete', { id }));
}

export function reminderDateValue(date = new Date(Date.now() + 3_600_000)): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function reminderWhen(seconds: number, now = new Date()): string {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const year = date.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  const day = sameDay ? 'Hoje' : date.toDateString() === tomorrow.toDateString() ? 'Amanhã' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year });
  return `${day}, ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

export function useReminderEvents() {
  useEffect(() => {
    if (!isTauri()) return;
    void refreshReminders().catch(() => undefined);
    const changed = listen('reminders-changed', () => { void refreshReminders().catch(() => undefined); });
    const due = listen<Reminder>('reminder-due', ({ payload }) => {
      useAppStore.getState().setNotice(`Lembrete: ${payload.text}`);
    });
    return () => { void changed.then((off) => off()); void due.then((off) => off()); };
  }, []);
}
