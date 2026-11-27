import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneApp, takeCode } from './PhoneApp';

const CODE = 'a'.repeat(64);
const answer = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const overview = { computer: 'athenas-pc', theme: 'oceano', agents: [
  { id: '1', agent: 'Codex', title: 'API', project: 'Loja', folder: 'loja', tone: 'running', label: 'Trabalhando', message: '', since: Date.now() },
  { id: '2', agent: 'Claude Code', title: null, project: null, folder: 'site', tone: 'waiting', label: 'Aguardando você', message: 'Autorização para Bash', since: Date.now() },
] };

let server: (path: string, body: unknown) => Response;
const requests: string[] = [];
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => { requests.push(path); return server(path, init?.body ? JSON.parse(String(init.body)) : undefined); }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear(); window.location.hash = ''; delete document.documentElement.dataset.theme; });

describe('phone page', () => {
  it('reads the pairing code once and removes it from the address', () => {
    window.location.hash = `#pair=${CODE}`;
    expect(takeCode()).toBe(CODE);
    expect(window.location.hash).toBe('');
    window.location.hash = '#pair=curto';
    expect(takeCode()).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('pairs after confirmation on the computer and lists agents with the pending ones first', async () => {
    window.location.hash = `#pair=${CODE}`;
    let approved = false;
    server = (path, body) => {
      if (path === '/api/pair') { expect(body).toEqual({ code: CODE, name: 'Redmi' }); return answer(200, { requestId: 'r', verification: '123 456' }); }
      if (path === '/api/pair/status') return answer(200, { status: approved ? 'paired' : 'waiting' });
      return approved ? answer(200, overview) : answer(401, { error: 'não pareado' });
    };
    render(<PhoneApp />);
    await wait(0);
    fireEvent.change(screen.getByLabelText('Nome do aparelho'), { target: { value: 'Redmi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Parear' }));
    await wait(0);
    expect(screen.getByText('123 456')).toBeTruthy();
    await wait(1_600);
    expect(screen.getByText('123 456')).toBeTruthy();
    approved = true;
    await wait(1_600);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((item) => item.textContent);
    expect(headings).toEqual(['Precisam de você', 'Outros agentes']);
    const urgent = within(screen.getByText('Precisam de você').parentElement!);
    expect(urgent.getByText('Autorização para Bash')).toBeTruthy();
    expect(screen.getByText('Codex · Loja')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('oceano');
  });

  it('explains how to pair when there is no code, and reports a denied request', async () => {
    server = () => answer(401, { error: 'não pareado' });
    render(<PhoneApp />);
    await wait(0);
    expect(screen.getByText('Aparelho não pareado')).toBeTruthy();
    cleanup();
    window.location.hash = `#pair=${CODE}`;
    server = (path) => (path === '/api/pair' ? answer(200, { requestId: 'r', verification: '000 001' }) : path === '/api/pair/status' ? answer(200, { status: 'denied' }) : answer(401, {}));
    render(<PhoneApp />);
    await wait(0);
    fireEvent.click(screen.getByRole('button', { name: 'Parear' }));
    await wait(0);
    await wait(1_600);
    expect(screen.getByRole('alert').textContent).toContain('recusado');
  });

  it('tells a lost connection right after pairing apart from a cookie the browser dropped', async () => {
    let after: 'down' | 'ok' | 'forgotten' = 'down';
    let paired = false;
    server = (path) => {
      if (path === '/api/pair') return answer(200, { requestId: 'r', verification: '111 222' });
      if (path === '/api/pair/status') { paired = true; return answer(200, { status: 'paired' }); }
      if (!paired || after === 'forgotten') return answer(401, {});
      if (after === 'down') throw new TypeError('offline');
      return answer(200, overview);
    };
    const pairNow = async () => {
      window.location.hash = `#pair=${CODE}`;
      render(<PhoneApp />);
      await wait(0);
      fireEvent.click(screen.getByRole('button', { name: 'Parear' }));
      await wait(0);
      await wait(1_600);
    };
    await pairNow();
    expect(screen.getByRole('status').textContent).toContain('Sem conexão');
    after = 'ok';
    await wait(3_100);
    expect(screen.getByRole('heading', { name: 'Agentes' })).toBeTruthy();
    cleanup();
    paired = false;
    after = 'forgotten';
    await pairNow();
    expect(screen.getByRole('alert').textContent).toContain('não guardou');
  });

  it('shows a lost connection without dropping the list, and notices a revoked device', async () => {
    let mode: 'ok' | 'down' | 'revoked' = 'ok';
    server = () => { if (mode === 'down') throw new TypeError('offline'); return mode === 'ok' ? answer(200, overview) : answer(401, {}); };
    render(<PhoneApp />);
    await wait(0);
    expect(screen.getByRole('status').textContent).toBe('Conectado');
    mode = 'down';
    await wait(3_100);
    expect(screen.getByRole('status').textContent).toBe('Sem conexão');
    expect(screen.getByText('API')).toBeTruthy();
    mode = 'revoked';
    await wait(3_100);
    expect(screen.getByRole('alert').textContent).toContain('revogado');
    const count = requests.length;
    await wait(10_000);
    expect(requests.length).toBe(count);
  });

  it('disconnects only after a second confirmation', async () => {
    server = (path) => (path === '/api/logout' ? answer(204, null) : answer(200, overview));
    render(<PhoneApp />);
    await wait(0);
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar este aparelho' }));
    expect(requests).not.toContain('/api/logout');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar desconexão' }));
    await wait(0);
    expect(screen.getByRole('alert').textContent).toContain('desconectado');
  });
});
