import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receiveMobileAction } from '../chat/sync';
import { useChatStore } from '../chat/store';
import { useActivityStore } from '../activity';
import { useAppStore } from '../store';
import { PhoneApp, takeAgent } from './PhoneApp';

const agent = { id: 's1', agent: 'Claude Code', title: 'API', project: 'Loja', folder: 'loja', tone: 'running', label: 'Trabalhando', message: '', since: null, state: 'working' };
const answer = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const line = (o: number, type: 'user' | 'assistant', text: string) => ({ o, v: { type, uuid: `u${o}`, message: { content: [{ type: 'text', text }] } } });
const chunk = (lines: unknown[], end: number) => ({ bound: true, reset: false, source: 'c', start: 0, end, more: false, lines, candidates: [] });
const permission = { id: 'r1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf build && npm run build', description: 'Recompila' }, suggestions: [], agentId: null, createdAt: 0 };

let state: { canControl: boolean; agents: any[]; lines: any[]; requests: any[]; sendFails: number };
let posts: { path: string; body: any }[];
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const sent = (path: string) => posts.filter((post) => post.path === path).map((post) => post.body);

beforeEach(() => {
  vi.useFakeTimers();
  state = { canControl: true, agents: [agent], lines: [line(1, 'user', 'compile o projeto'), line(2, 'assistant', 'Vou **compilar**. <img src=x onerror=alert(1)> [docs](https://example.com) [arquivo](file:///etc)')], requests: [], sendFails: 0 };
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body) posts.push({ path, body });
    if (path === '/api/agents') return answer(200, { computer: 'pc', theme: null, agents: state.agents, canControl: state.canControl, notifications: false });
    if (path === '/api/conversation') return answer(200, { chunk: chunk(body.from ? state.lines.filter((item) => item.o > body.from) : state.lines, state.lines.at(-1)?.o ?? 0), requests: state.requests });
    if (path === '/api/send' && state.sendFails-- > 0) throw new TypeError('offline');
    return answer(200, {});
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const open = async () => {
  render(<PhoneApp />);
  await wait(0);
  fireEvent.click(screen.getByRole('button', { name: /API/ }));
  await wait(0);
};
const box = () => screen.getByLabelText('Mensagem para o agente') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;

describe('phone conversation', () => {
  it('shows the conversation without running or fetching anything it mentions', async () => {
    await open();
    expect(screen.getByText('compile o projeto')).toBeTruthy();
    const reply = screen.getByLabelText('Resposta do agente');
    expect(reply.querySelector('strong')!.textContent).toBe('compilar');
    expect(reply.querySelector('img')).toBeNull();
    expect(reply.querySelectorAll('a')).toHaveLength(1);
    expect(reply.querySelector('a')!.getAttribute('rel')).toContain('noopener');
  });

  it('sends a message, keeps its identity when retried and clears it once recorded', async () => {
    await open();
    state.sendFails = 1;
    fireEvent.change(box(), { target: { value: 'agora rode os testes' } });
    fireEvent.click(sendButton());
    await wait(0);
    expect(screen.getByRole('alert').textContent).toContain('não será repetida');
    expect(box().value).toBe('agora rode os testes');
    fireEvent.click(sendButton());
    await wait(0);
    const [first, second] = sent('/api/send');
    expect(second).toEqual(first);
    expect(box().value).toBe('');
    expect(screen.getByText('Na fila do agente')).toBeTruthy();
    state.lines = [...state.lines, line(3, 'user', 'agora rode os testes')];
    await wait(1_600);
    expect(screen.queryByText('Na fila do agente')).toBeNull();
    expect(screen.getAllByText('agora rode os testes')).toHaveLength(1);
  });

  it('shows the whole command, arms approval after a moment and blocks messages meanwhile', async () => {
    state.agents = [{ ...agent, tone: 'waiting', label: 'Aguardando você', state: 'approval' }];
    state.requests = [permission];
    await open();
    expect(screen.getByText('rm -rf build && npm run build')).toBeTruthy();
    const allow = screen.getByRole('button', { name: 'Permitir uma vez' }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'sim' } });
    expect(sendButton().disabled).toBe(true);
    await wait(900);
    fireEvent.click(allow);
    await wait(0);
    expect(sent('/api/decide')).toEqual([{ sessionId: 's1', requestId: 'r1', decision: { behavior: 'allow' } }]);
  });

  it('answers a question and points to the computer for what has no request', async () => {
    state.agents = [{ ...agent, tone: 'waiting', state: 'approval', message: 'Quer executar: npm test' }];
    await open();
    expect(screen.getByText('Este pedido só pode ser respondido no computador.')).toBeTruthy();
    state.requests = [{ ...permission, toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Qual banco?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] } }];
    await wait(1_600);
    fireEvent.click(screen.getByLabelText('Postgres'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar resposta' }));
    await wait(0);
    expect(sent('/api/decide')[0].decision).toEqual({ behavior: 'answer', answers: { 'Qual banco?': 'Postgres' } });
  });

  it('interrupts, notices the agent ending and returns with the back button', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Interromper o agente' }));
    await wait(0);
    expect(sent('/api/interrupt')).toEqual([{ sessionId: 's1' }]);
    state.agents = [];
    await wait(3_100);
    expect(screen.getByRole('alert').textContent).toContain('não está mais em execução');
    expect(screen.queryByLabelText('Mensagem para o agente')).toBeNull();
    await act(async () => { window.history.replaceState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate', { state: null })); });
    expect(screen.getByText('Nenhum agente em execução no momento.')).toBeTruthy();
  });

  it('keeps conversations closed until the computer releases this device', async () => {
    state.canControl = false;
    await open();
    expect(screen.queryByLabelText('Mensagem para o agente')).toBeNull();
    expect(screen.getByText(/libere este aparelho/)).toBeTruthy();
    expect(sent('/api/conversation')).toHaveLength(0);
    // Releasing the device later leaves the list on screen.
    state.canControl = true;
    await wait(3_100);
    expect(screen.queryByText(/libere este aparelho/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Agentes' })).toBeTruthy();
    cleanup();
    state.canControl = false;
    window.history.replaceState(null, '', '/#agent=s1');
    render(<PhoneApp />);
    await wait(0);
    state.canControl = true;
    await wait(3_100);
    expect(screen.getByRole('heading', { name: 'Agentes' })).toBeTruthy();
  });

  it('opens the agent named by a tapped notification', async () => {
    // As on a fresh load: the address already carries the agent, with no navigation event.
    window.history.replaceState(null, '', '/#agent=s1');
    render(<PhoneApp />);
    await wait(0);
    expect(screen.getByRole('heading', { name: 'API' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    window.location.hash = '#agent=../x';
    expect(takeAgent()).toBeNull();
  });
});

describe('desktop reaction to the phone', () => {
  it('treats a message or interruption from the phone like one typed on the computer', () => {
    useAppStore.setState({ sessions: [{ id: 's1', agent: 'Claude Code', folder: 'C:\\loja', command: 'claude', resumeId: null, paneId: null, status: 'rodando' }] });
    receiveMobileAction({ sessionId: 's1', kind: 'sent', text: 'oi' });
    expect(useActivityStore.getState().activity.s1.state).toBe('working');
    expect(useChatStore.getState().sessions.s1.outbox.map((item) => item.text)).toEqual(['oi']);
    receiveMobileAction({ sessionId: 's1', kind: 'interrupted', text: '' });
    expect(useActivityStore.getState().activity.s1.state).toBe('idle');
    receiveMobileAction({ sessionId: 'outra', kind: 'sent', text: 'x' });
    expect(useChatStore.getState().sessions.outra).toBeUndefined();
    useAppStore.setState({ sessions: [] });
  });
});
