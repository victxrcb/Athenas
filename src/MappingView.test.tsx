import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
