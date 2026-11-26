import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../TerminalView', () => ({ TerminalView: ({ viewSwitch }: { viewSwitch?: React.ReactNode }) => <div data-testid="terminal">{viewSwitch}</div> }));

import { useActivityStore } from '../activity';
import { useAppStore, type SessionInfo } from '../store';
import { ChatView } from './ChatView';
import { useChatPrefs } from './prefs';
import { SessionSurface } from './SessionSurface';
import { addOutbox, applyLiveEvent, composeItems, forgetChat, receiveChunk, receiveLive, useChatStore, type Chunk } from './store';
import { receivePermissions } from './sync';

const session: SessionInfo = { id: 's1', agent: 'Claude Code', folder: 'C:\\p', command: 'claude', resumeId: 'r', paneId: null, status: 'rodando', title: 'Correção' };
const chunk = (records: any[], extra: Partial<Chunk> = {}): Chunk => ({ bound: true, reset: false, source: 'conv', start: 0, end: 1000, more: false, candidates: [], lines: records.map((v, index) => ({ o: index, v })), ...extra });
const answer = (text: string, id = 'a1') => ({ type: 'assistant', uuid: id, timestamp: new Date().toISOString(), message: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

let page: Chunk;
beforeEach(() => {
  page = chunk([]);
  invoke.mockImplementation((command: string) => {
    if (command === 'chat_read') { const next = page; page = chunk([]); return Promise.resolve(next); }
    if (command === 'chat_context') return Promise.resolve({ folder: 'C:\\p', branch: 'master', instructions: ['CLAUDE.md'], commands: [] });
    return Promise.resolve(null);
  });
  useAppStore.setState({ sessions: [session], notice: null });
});
afterEach(() => {
  cleanup(); invoke.mockReset(); localStorage.clear(); forgetChat('s1');
  useChatStore.setState({ permissions: [] });
  useActivityStore.setState({ activity: {} });
  useChatPrefs.setState({ modes: {}, lastMode: 'chat', drafts: {}, history: {}, expanded: {} });
});

describe('chat view', () => {
  it('renders markdown without running anything the message contains', async () => {
    page = chunk([{ type: 'user', uuid: 'u', message: { content: 'Mostre' } }, answer('## Título\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>\n\n![rastreio](https://example.com/p.png) [mal](javascript:alert(3))')]);
    const { container } = render(<ChatView session={session} />);
    expect(await screen.findByRole('heading', { name: 'Título' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.querySelector('.chat-code figcaption')?.textContent).toContain('TypeScript');
    expect(container.querySelector('.chat-markdown script')).toBeNull();
    expect(container.querySelector('.chat-markdown img')).toBeNull();
    expect([...container.querySelectorAll('.chat-markdown a')].every((link) => !link.getAttribute('href')?.startsWith('javascript'))).toBe(true);
    expect(screen.getByRole('button', { name: /rastreio/ })).toBeTruthy();
  });

  it('folds finished actions and shows their real details on demand', async () => {
    const use = (id: string, command: string) => ({ type: 'assistant', uuid: `a${id}`, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: `Passo ${id}` } }] } });
    const done = (id: string) => ({ type: 'user', uuid: `r${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `saida ${id}` }] }, toolUseResult: { stdout: `saida ${id}`, stderr: '' } });
    page = chunk([use('1', 'npm test'), done('1'), use('2', 'npm run build'), done('2')]);
    render(<ChatView session={session} />);
    const head = await screen.findByRole('button', { name: /2 etapas executadas/ });
    expect(screen.queryByText('Passo 1')).toBeNull();
    fireEvent.click(head);
    fireEvent.click(screen.getByRole('button', { name: /Passo 1/ }));
    expect(screen.getByText('saida 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar comando' })).toBeTruthy();
  });

  it('drops the queued copy once the file records a message whose image path became a placeholder', () => {
    const path = '"C:\\Users\\Ana Lima\\AppData\\clipboard\\81db721f.png"';
    const record = (uuid: string, text: string) => ({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } });
    const queued = () => useChatStore.getState().sessions.s1.outbox.map((item) => item.text);
    receiveChunk('s1', 'Claude Code', chunk([]));
    addOutbox('s1', `veja a tela\n\n${path}`);
    // Another message with an image must not clear it.
    receiveChunk('s1', 'Claude Code', chunk([record('u0', '[Image #1]outro assunto')]));
    expect(queued()).toHaveLength(1);
    receiveChunk('s1', 'Claude Code', chunk([record('u1', '[Image #2]veja a tela')]));
    expect(queued()).toEqual([]);
    // The placeholder can also stay in the middle, and a message can be only the image.
    addOutbox('s1', `compare ${path} com o layout`);
    receiveChunk('s1', 'Claude Code', chunk([record('u2', 'compare [Image #3] com o layout')]));
    expect(queued()).toEqual([]);
    addOutbox('s1', path);
    receiveChunk('s1', 'Claude Code', chunk([record('u3', '[Image #4]')]));
    expect(queued()).toEqual([]);
  });

  it('streams live text and replaces it once the file records it', async () => {
    render(<ChatView session={session} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('chat_read', expect.anything()));
    const event = (index: number, delta: string, final = false) => ({ sessionId: 's1', event: { event: 'MessageDisplay', at: Date.now(), messageId: 'm', index, delta, final } });
    // Batches can arrive out of order.
    act(() => receiveLive([event(1, 'chegando agora'), event(0, 'Texto ')]));
    expect(await screen.findByText('Texto chegando agora')).toBeTruthy();
    act(() => { receiveChunk('s1', 'Claude Code', chunk([answer('Texto chegando agora')])); });
    await waitFor(() => expect(screen.getAllByText('Texto chegando agora')).toHaveLength(1));
    expect(useChatStore.getState().sessions.s1.messages).toHaveLength(0);
  });

  it('offers exactly the permission options of the request and sends the choice', async () => {
    render(<ChatView session={session} />);
    act(() => receivePermissions([{ id: 'p1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm install' }, agentId: null, createdAt: 1, suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm install' }] }, { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }]));
    const card = within(await screen.findByRole('alertdialog', { name: 'Autorização necessária' }));
    expect(card.getByText('npm install')).toBeTruthy();
    expect(card.getByRole('button', { name: /Sempre permitir Bash\(npm install\) nesta sessão/ })).toBeTruthy();
    expect(card.queryByRole('button', { name: /bypass/i })).toBeNull();
    expect((screen.getByLabelText('Mensagem para Claude Code') as HTMLTextAreaElement).placeholder).toContain('Responda');
    expect(useActivityStore.getState().activity.s1.state).toBe('approval');
    expect(invoke).not.toHaveBeenCalledWith('chat_permission_decide', expect.anything());
    fireEvent.click(card.getByRole('button', { name: 'Permitir uma vez' }));
    expect(invoke).toHaveBeenCalledWith('chat_permission_decide', { sessionId: 's1', requestId: 'p1', decision: { behavior: 'allow' } });
    act(() => receivePermissions([]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useActivityStore.getState().activity.s1.state).toBe('working');
  });

  it('answers structured questions', async () => {
    render(<ChatView session={session} />);
    act(() => receivePermissions([{ id: 'q1', sessionId: 's1', toolName: 'AskUserQuestion', agentId: null, createdAt: 1, suggestions: [], toolInput: { questions: [{ question: 'Qual estratégia?', multiSelect: false, options: [{ label: 'Reutilizar' }, { label: 'Criar' }] }] } }]));
    const send = await screen.findByRole('button', { name: 'Enviar resposta' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Criar' }));
    fireEvent.click(send);
    expect(invoke).toHaveBeenCalledWith('chat_permission_decide', { sessionId: 's1', requestId: 'q1', decision: { behavior: 'answer', answers: { 'Qual estratégia?': 'Criar' } } });
  });

  it('sends with Enter, keeps drafts and asks before typing into an unconfirmed agent', async () => {
    invoke.mockImplementation((command: string, args: any) => {
      if (command === 'chat_read') return Promise.resolve(chunk([], { bound: false }));
      if (command === 'chat_send') return args.force ? Promise.resolve() : Promise.reject('NOT_READY');
      return Promise.resolve(null);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ChatView session={session} />);
    const input = screen.getByLabelText('Mensagem para Claude Code') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Corrija o login' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(invoke).not.toHaveBeenCalledWith('chat_send', expect.anything());
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith('chat_send', { sessionId: 's1', text: 'Corrija o login', force: true });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(false));
    expect(input.value).toBe('Corrija o login');
    confirm.mockReturnValue(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(invoke).toHaveBeenCalledWith('chat_send', { sessionId: 's1', text: 'Corrija o login', force: true });
    expect(screen.getByText('Corrija o login')).toBeTruthy();
    expect(useChatPrefs.getState().history.s1).toEqual(['Corrija o login']);
    // While the agent works, the send button interrupts it with Esc.
    fireEvent.click(screen.getByRole('button', { name: 'Interromper' }));
    expect(invoke).toHaveBeenCalledWith('terminal_write', { id: 's1', data: '\x1b' });
    confirm.mockRestore();
  });

  it('asks which Codex conversation belongs to the session instead of guessing', async () => {
    page = chunk([], { bound: false, source: '', candidates: [{ id: 'c1', startedAt: 1, preview: 'Primeira' }, { id: 'c2', startedAt: 2, preview: 'Segunda' }] });
    render(<ChatView session={{ ...session, agent: 'Codex' }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Segunda/ }));
    expect(invoke).toHaveBeenCalledWith('chat_bind', { sessionId: 's1', conversationId: 'c2' });
  });

  it('points to the terminal when Codex never records a message', async () => {
    vi.useFakeTimers();
    try {
      const codex: SessionInfo = { ...session, agent: 'Codex' };
      render(<ChatView session={codex} />);
      act(() => {
        addOutbox('s1', 'oi');
        useActivityStore.getState().set('s1', { state: 'working', since: Date.now(), unread: false, message: '' });
      });
      expect(screen.getByText('Trabalhando…')).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(21_000));
      expect(screen.getByText(/ainda não registrou sua mensagem/)).toBeTruthy();
      expect(screen.queryByText('Trabalhando…')).toBeNull();
      // Once Codex records it and the turn opens, the usual activity line returns.
      act(() => { receiveChunk('s1', 'Codex', chunk([{ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }, { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: 'oi' } }])); });
      expect(screen.queryByText(/ainda não registrou/)).toBeNull();
      expect(screen.getByText('Trabalhando…')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('restores an ended conversation without presenting it as running', async () => {
    page = chunk([answer('Histórico salvo'), { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep' } }] } }]);
    const resume = vi.fn();
    render(<ChatView session={{ ...session, status: 'concluído' }} onResume={resume} />);
    expect(await screen.findByText('Histórico salvo')).toBeTruthy();
    expect(screen.queryByLabelText('Mensagem para Claude Code')).toBeNull();
    expect(screen.getByLabelText('Cancelado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retomar sessão/ }));
    expect(resume).toHaveBeenCalled();
  });

  it('switches views without starting or stopping anything', async () => {
    render(<SessionSurface session={session} onStatus={() => undefined} onResume={() => undefined} ended={null} />);
    await screen.findByLabelText('Conversa com Claude Code');
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(await screen.findByTestId('terminal')).toBeTruthy();
    expect(screen.queryByLabelText('Conversa com Claude Code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dividido' }));
    expect(await screen.findByLabelText('Conversa com Claude Code')).toBeTruthy();
    expect(await screen.findByTestId('terminal')).toBeTruthy();
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => /terminal_start|terminal_stop|chat_send/.test(String(command)))).toEqual([]);
  });
});

describe('live overlay', () => {
  it('shows announced tools until the file has them and ignores subagents', () => {
    let chat = applyLiveEvent({ transcript: { items: [], meta: { turnOpen: false } }, start: 0, end: 0, source: '', bound: false, loaded: false, error: null, candidates: [], messages: [], tools: [], outbox: [], ready: false, tick: 0 }, { event: 'PreToolUse', at: 1, toolUseId: 't', toolName: 'Read', toolInput: { file_path: 'a' } });
    chat = applyLiveEvent(chat, { event: 'PreToolUse', at: 2, toolUseId: 's', toolName: 'Read', agentId: 'sub' });
    expect(composeItems(chat).map((item) => item.id)).toEqual(['t']);
    chat = applyLiveEvent(chat, { event: 'PostToolUseFailure', at: 3, toolUseId: 't' });
    expect(composeItems(chat)[0]).toMatchObject({ status: 'failed' });
    expect(chat.ready).toBe(true);
  });
});
