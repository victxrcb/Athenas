import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RemindersView } from './RemindersView';
import { reminderDateValue, reminderWhen, useReminderStore } from './reminders';

afterEach(() => { cleanup(); useReminderStore.setState({ items: [] }); });

describe('reminders', () => {
  it('shows notes with and without an optional schedule', () => {
    useReminderStore.setState({ items: [
      { id: 'plain', text: 'Comprar café', scheduledAt: null, notifiedAt: null, createdAt: 1 },
      { id: 'scheduled', text: 'Reunião do time', scheduledAt: new Date(2026, 10, 18, 9).getTime() / 1000, notifiedAt: null, createdAt: 2 },
    ] });
    render(<RemindersView />);
    expect(screen.getByText('Comprar café')).toBeTruthy();
    expect(screen.getByText('Sem horário')).toBeTruthy();
    expect(screen.getByText('Reunião do time')).toBeTruthy();
  });

  it('only asks for date and time when scheduling is enabled', () => {
    render(<RemindersView />);
    expect(screen.queryByLabelText('Data e hora')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Agendar notificação/));
    expect(screen.getByLabelText('Data e hora')).toBeTruthy();
  });

  it('opens an existing post-it for text and schedule editing', () => {
    const scheduledAt = new Date(2026, 10, 18, 9).getTime() / 1000;
    useReminderStore.setState({ items: [{ id: 'edit', text: 'Texto original', scheduledAt, notifiedAt: null, createdAt: 1 }] });
    render(<RemindersView />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar lembrete' }));
    expect((screen.getByLabelText('Editar lembrete') as HTMLTextAreaElement).value).toBe('Texto original');
    expect((screen.getByLabelText('Agendar notificação do lembrete') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Data e hora do lembrete') as HTMLInputElement).value).toBe('2026-11-18T09:00');
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/ }));
    expect(screen.queryByLabelText('Data e hora do lembrete')).toBeNull();
  });

  it('formats local input and friendly dates', () => {
    const now = new Date(2026, 10, 17, 8, 0);
    expect(reminderDateValue(new Date(2026, 10, 17, 9, 5))).toBe('2026-11-17T09:05');
    expect(reminderWhen(new Date(2026, 10, 17, 9, 30).getTime() / 1000, now)).toContain('Hoje');
    expect(reminderWhen(new Date(2026, 10, 18, 9, 30).getTime() / 1000, now)).toContain('Amanhã');
  });
});
