import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MappingView } from './MappingView';
import { useAppStore } from './store';

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    sessions: [
      { id: 'session-a', agent: 'Claude Code', folder: 'C:\\alpha', command: 'claude', resumeId: null, paneId: null, status: 'concluído' },
      { id: 'session-b', agent: 'Codex', folder: 'C:\\beta', command: 'codex', resumeId: null, paneId: null, status: 'erro' },
    ],
    workspace: {
      groups: [], panes: [],
      projects: [
        { id: 'project-a', groupId: null, name: 'Alpha', folder: 'C:\\alpha', layout: 'auto', splitRatio: .5, updatedAt: 1 },
        { id: 'project-b', groupId: null, name: 'Beta', folder: 'C:\\beta', layout: 'auto', splitRatio: .5, updatedAt: 1 },
      ],
    },
    activeProjectId: null,
  });
});

afterEach(() => cleanup());

describe('MappingView', () => {
  it('uses real sessions across terminal and architecture modes without creating sessions', async () => {
    render(<MappingView />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(useAppStore.getState().sessions).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Ocultar janela do mapa' })[0]);
    expect(screen.getByRole('button', { name: /Exibir 1 oculto/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Exibir 1 oculto/ }));

    fireEvent.click(screen.getByRole('button', { name: /Arquitetura/ }));
    expect(screen.getAllByText('Sem tarefa estruturada disponível')).toHaveLength(2);
    expect(useAppStore.getState().sessions).toHaveLength(2);
  });

  it('filters mapped sessions by the existing project structure', async () => {
    render(<MappingView />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Filtrar projeto'), { target: { value: 'project-b' } });
    await waitFor(() => expect(screen.queryByText('Claude Code')).toBeNull());
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('1 agente(s) no mapa')).toBeTruthy();
  });

  it('links two agents by dragging the cable onto another agent and removes the link', async () => {
    const { container } = render(<MappingView />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());
    const target = container.querySelector<HTMLElement>('[data-session-id="session-b"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => target) as typeof document.elementFromPoint;
    try {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Linkar Claude Code a outro agente' }), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 700, clientY: 100 });
      fireEvent.pointerUp(window, { clientX: 700, clientY: 100 });
    } finally {
      document.elementFromPoint = original;
    }
    await waitFor(() => expect(JSON.parse(localStorage.getItem('athenas-agent-links') ?? '[]')).toMatchObject([{ fromId: 'session-a', toId: 'session-b' }]));
    await waitFor(() => expect(screen.getByText('Claude Code → Codex')).toBeTruthy());
    expect(container.querySelectorAll('path.mapping-edge')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remover link Claude Code → Codex' }));
    await waitFor(() => expect(screen.queryByText('Claude Code → Codex')).toBeNull());
    expect(JSON.parse(localStorage.getItem('athenas-agent-links')!)).toEqual([]);
  });

  it('does not let an agent command itself', async () => {
    const { container } = render(<MappingView />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());
    const self = container.querySelector<HTMLElement>('[data-session-id="session-a"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => self) as typeof document.elementFromPoint;
    try {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Linkar Claude Code a outro agente' }), { button: 0 });
      fireEvent.pointerUp(window, {});
    } finally {
      document.elementFromPoint = original;
    }
    expect(container.querySelectorAll('path.mapping-edge')).toHaveLength(0);
    expect(localStorage.getItem('athenas-agent-links')).toBeNull();
  });
});
