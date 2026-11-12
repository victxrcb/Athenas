import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageBar } from './UsageBar';
import { useAppStore } from './store';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn().mockResolvedValue([
    { agent: 'Claude Code', fiveHour: { usedPercent: 34.5, resetsAt: '2026-11-12T20:00:00Z' }, weekly: { usedPercent: 70, resetsAt: '2026-11-19T20:00:00Z' }, error: null },
  ]),
}));

afterEach(() => cleanup());

describe('usage bar', () => {
  it('shows account quota and app memory, with weekly quota and reset times in the modal', async () => {
    useAppStore.setState({ memory: { totalBytes: 3 * 1024 * 1024 * 1024, appBytes: 400 * 1024 * 1024, groups: [], agents: [{ agent: 'Claude Code', sessions: 1, bytes: 1000, cpuPercent: 85 }] } });
    render(<UsageBar />);
    expect(screen.getByText('App 400 MB')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Uso de Claude Code' }).textContent).toContain('35%'));
    fireEvent.click(screen.getByRole('button', { name: 'Uso de Claude Code' }));
    const modal = within(screen.getByRole('dialog', { name: 'Cota de Claude Code' }));
    expect(modal.getByText('70% utilizada')).toBeTruthy();
    expect(modal.getAllByText(/Renova em/)).toHaveLength(2);
  });
});
