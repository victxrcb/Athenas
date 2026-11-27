import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileSettings, lastSeen, type MobileView } from './MobileSettings';
import { publishedAgents } from './publish';
import type { SessionInfo } from '../store';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), isTauri: () => true }));

const off: MobileView = { enabled: false, url: null, error: null, pairing: null, request: null, devices: [] };
const on: MobileView = { ...off, enabled: true, url: 'https://pc.tail1.ts.net' };
let view: MobileView;
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const called = (command: string) => invoke.mock.calls.filter((call) => call[0] === command);

beforeEach(() => {
  vi.useFakeTimers();
  view = off;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === 'mobile_tailscale') return { installed: true, running: true, https: false, dnsName: 'pc.tail1.ts.net' };
    if (command === 'mobile_set_enabled') view = on;
    if (command === 'mobile_pairing_start') view = { ...on, pairing: { url: `https://pc.tail1.ts.net/#pair=${'b'.repeat(64)}`, expiresAt: Date.now() + 120_000 } };
    return view;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('mobile settings', () => {
  it('shows what is missing, turns access on and offers a QR code', async () => {
    render(<MobileSettings />);
    await wait(0);
    expect(screen.getByText(/HTTPS Certificates/).closest('li')!.dataset.done).toBe('false');
    expect(screen.queryByRole('button', { name: /Parear celular/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    await wait(0);
    expect(called('mobile_set_enabled')[0][1]).toEqual({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Parear celular/ }));
    await wait(0);
    expect(screen.getByRole('img', { name: 'QR code de pareamento' }).querySelector('path')!.getAttribute('d')).toContain('h1v1');
    expect(screen.getByText(/expira em 2:00/)).toBeTruthy();
  });

  it('asks before letting a phone in and sends the answer', async () => {
    view = { ...on, request: { id: 'r1', name: 'Redmi', verification: '123 456' } };
    render(<MobileSettings />);
    await wait(0);
    expect(screen.getByRole('alertdialog').textContent).toContain('123 456');
    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
    await wait(0);
    expect(called('mobile_pairing_decide')[0][1]).toEqual({ requestId: 'r1', allow: true });
  });

  it('cancels an open code when the settings close, and nothing otherwise', async () => {
    view = on;
    const first = render(<MobileSettings />);
    await wait(0);
    first.unmount();
    expect(called('mobile_pairing_cancel')).toHaveLength(0);
    view = { ...on, pairing: { url: 'https://pc.tail1.ts.net/#pair=x', expiresAt: Date.now() + 1_000 } };
    const second = render(<MobileSettings />);
    await wait(0);
    second.unmount();
    expect(called('mobile_pairing_cancel')).toHaveLength(1);
  });

  it('describes the last access', () => {
    expect(lastSeen(1_000, 2_000)).toBe('agora há pouco');
    expect(lastSeen(0, 5 * 60_000)).toBe('há 5 min');
    expect(lastSeen(0, 3 * 3_600_000)).toBe('há 3 h');
    expect(lastSeen(0, 49 * 3_600_000)).toBe('há 2 dias');
  });
});

describe('published agents', () => {
  const session = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo => ({ id, agent: 'Claude Code', folder: 'C:\\loja', command: 'claude', resumeId: null, paneId: null, status: 'rodando', title: null, ...patch });

  it('reports running agents with the project and status shown on the desktop', () => {
    const workspace = { groups: [], panes: [{ id: 'p', projectId: 'b', position: 0, pinned: false }], projects: [
      { id: 'a', groupId: null, name: 'Loja', folder: '\\\\?\\C:\\Loja', layout: 'auto' as const, splitRatio: 0.5, updatedAt: 0 },
      { id: 'b', groupId: null, name: 'API', folder: 'C:\\api', layout: 'auto' as const, splitRatio: 0.5, updatedAt: 0 },
    ] };
    const list = publishedAgents(
      [session('1'), session('2', { paneId: 'p' }), session('3', { agent: 'Shell' }), session('4', { status: 'concluído' })],
      workspace,
      { 1: { state: 'done', since: 3, unread: true, message: 'trecho da resposta' }, 2: { state: 'approval', since: 7, unread: true, message: 'Autorização para Bash' } },
    );
    expect(list).toEqual([
      { id: '1', project: 'Loja', tone: 'done', label: 'Terminou', message: '', since: 3 },
      { id: '2', project: 'API', tone: 'waiting', label: 'Aguardando você', message: 'Autorização para Bash', since: 7 },
    ]);
  });
});
