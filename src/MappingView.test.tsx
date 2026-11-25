import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivityStore } from './activity';
import { MappingView } from './MappingView';
import { useMappingEventTracking, useMappingEvents } from './mappingActivity';
import { useAppStore, type SessionInfo } from './store';

vi.mock('./TerminalView', () => ({ TerminalView: ({ session }: { session: SessionInfo }) => <textarea aria-label={`PTY ${session.agent}`} /> }));

const claude: SessionInfo = { id: 'session-a', agent: 'Claude Code', title: 'Implementação', folder: 'C:\\alpha', command: 'claude', resumeId: null, paneId: null, status: 'rodando' };
const codex: SessionInfo = { id: 'session-b', agent: 'Codex', title: 'Revisão', folder: 'C:\\beta', command: 'codex', resumeId: null, paneId: null, status: 'erro' };

beforeEach(() => {
  localStorage.clear();
  useActivityStore.setState({ activity: {} });
  useMappingEvents.setState({ events: [] });
  useAppStore.setState({
    sessions: [claude, codex],
    memory: { groups: [], agents: [], appBytes: 0, totalBytes: 0 },
    workspace: {
      groups: [], panes: [],
      projects: [
        { id: 'project-a', groupId: null, name: 'Alpha', folder: claude.folder, layout: 'auto', splitRatio: .5, updatedAt: 1 },
        { id: 'project-b', groupId: null, name: 'Beta', folder: codex.folder, layout: 'auto', splitRatio: .5, updatedAt: 1 },
      ],
    },
    activeProjectId: null,
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const architecture = () => screen.getByRole('button', { name: 'Arquitetura' });
const terminal = () => screen.getByRole('button', { name: 'Terminal' });
const claudeCard = () => screen.findByRole('article', { name: 'Implementação · Ativo' });

describe('MappingView', () => {
  it('preserves terminal instance, content and sessions across both modes and hiding', async () => {
    render(<MappingView />);
    fireEvent.dblClick(await claudeCard());
    const emulator = await screen.findByRole('textbox', { name: 'PTY Claude Code' });
    fireEvent.change(emulator, { target: { value: 'scrollback' } });
    fireEvent.click(architecture());
    expect(await claudeCard()).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'PTY Claude Code' })).toBeNull();
    fireEvent.click(terminal());
    expect(screen.getByRole('textbox', { name: 'PTY Claude Code' })).toBe(emulator);
    expect((emulator as HTMLTextAreaElement).value).toBe('scrollback');
    fireEvent.click(screen.getAllByRole('button', { name: 'Ocultar janela do mapa' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Exibir 1 oculto(s)' }));
    expect(screen.getByRole('textbox', { name: 'PTY Claude Code' })).toBe(emulator);
    expect(useAppStore.getState().sessions).toHaveLength(2);
  });

  it('filters sessions by project and displays real live status and process metrics in the inspector', async () => {
    render(<MappingView />);
    const card = await claudeCard();
    fireEvent.keyDown(card, { key: 'Enter' });
    const inspector = screen.getByRole('complementary', { name: 'Detalhes do agente' });
    const metrics = within(inspector).getByLabelText('Métricas da sessão');
    expect(within(metrics).getAllByText('—')).toHaveLength(3);
    act(() => {
      useAppStore.setState({ memory: { groups: [], agents: [], appBytes: 0, totalBytes: 0, sessions: { [claude.id]: { pid: 123, bytes: 64 * 1024 * 1024, cpuPercent: 12.5, runtimeSeconds: 40, suspended: false } } } });
      useActivityStore.getState().set(claude.id, { state: 'working', since: 1, message: '', unread: false });
    });
    expect(within(metrics).getByText('12.5%')).toBeTruthy();
    expect(within(metrics).getByText('64 MB')).toBeTruthy();
    expect(within(inspector).getByText('Trabalhando')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filtrar projeto'), { target: { value: 'project-b' } });
    await screen.findByRole('article', { name: 'Revisão · Erro' });
    expect(screen.queryByRole('article', { name: /Implementação/ })).toBeNull();
  });

  it('restores manual coordinates, organization, zoom and panel preferences after remount', async () => {
    const { unmount } = render(<MappingView />);
    const card = await claudeCard();
    const handle = card.querySelector('header')!;
    for (const [type, x, y] of [['pointerdown', 100, 100], ['pointermove', 160, 130], ['pointerup', 160, 130]] as const) {
      fireEvent(handle, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    }
    const manual = card.style.transform;
    expect(manual).toBe('translate(124px, 94px)');
    fireEvent.change(screen.getByLabelText('Organização do canvas'), { target: { value: 'project' } });
    expect(card.style.transform).not.toBe(manual);
    fireEvent.click(screen.getByRole('button', { name: 'Recolher minimapa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar zoom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar zoom' }));
    expect(card.className).toContain('semantic-near');
    fireEvent.click(screen.getByRole('button', { name: 'Atividade' }));
    unmount();
    render(<MappingView />);
    const restored = await claudeCard();
    expect(restored.className).toContain('semantic-near');
    expect(screen.queryByLabelText('Minimapa')).toBeNull();
    expect(screen.queryByLabelText('Filtrar eventos por tipo')).toBeNull();
    expect((screen.getByLabelText('Organização do canvas') as HTMLSelectElement).value).toBe('project');
    fireEvent.change(screen.getByLabelText('Organização do canvas'), { target: { value: 'free' } });
    expect(restored.style.transform).toBe(manual);
  });

  it('creates links by dragging, inspects and confirms removal without adding other edges', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<MappingView />);
    const source = await claudeCard();
    const target = await screen.findByRole('article', { name: 'Revisão · Erro' });
    const original = document.elementFromPoint;
    try {
      document.elementFromPoint = vi.fn(() => source);
      const port = within(source).getByRole('button', { name: /Linkar Implementação/ });
      fireEvent(port, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      fireEvent(window, new MouseEvent('pointerup', { bubbles: true }));
      expect(container.querySelectorAll('path.mapping-edge')).toHaveLength(0);
      document.elementFromPoint = vi.fn(() => target);
      fireEvent(port, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      fireEvent(window, new MouseEvent('pointerup', { bubbles: true }));
    } finally {
      document.elementFromPoint = original;
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Inspecionar vínculo Implementação → Revisão' }));
    expect(container.querySelectorAll('path.mapping-edge')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remover vínculo' }));
    await waitFor(() => expect(container.querySelectorAll('path.mapping-edge')).toHaveLength(0));
    expect(window.confirm).toHaveBeenCalledWith('Remover o vínculo de Implementação para Revisão?');
  });

  it('records status transitions and redacts activity content from persistent history', async () => {
    function Harness() { useMappingEventTracking(); return <MappingView />; }
    const { unmount } = render(<Harness />);
    await claudeCard();
    act(() => {
      useActivityStore.getState().set(claude.id, { state: 'approval', since: Date.now(), message: 'private prompt', unread: true });
      useAppStore.getState().upsertSession({ ...claude, status: 'concluído' });
    });
    fireEvent.change(screen.getByLabelText('Filtrar eventos por tipo'), { target: { value: 'approval' } });
    const timeline = screen.getByRole('region', { name: 'Timeline de atividades' });
    fireEvent.click(within(timeline).getByRole('button', { name: /Aguardando interação/ }));
    expect(within(timeline).getByRole('button', { name: 'Centralizar' })).toBeTruthy();
    unmount();
    const stored = localStorage.getItem('athenas-mapping-events');
    expect(stored).toContain('"kind":"approval"');
    expect(stored).toContain('"kind":"ended"');
    expect(stored).not.toContain('private prompt');
  });
});
