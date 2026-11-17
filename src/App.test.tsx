import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { useAppStore } from './store';

afterEach(() => { cleanup(); localStorage.clear(); useAppStore.setState({ paletteOpen: false, section: 'home', sessionOpen: false, projectOpen: false, groupOpen: false, notice: null, sessions: [], activeSessionId: null, activeProjectId: null, workspace: { groups: [], projects: [], panes: [] } }); });

describe('home', () => {
  it('opens the session dialog from the quick action', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Novo terminal', { selector: '.quick-actions button' }));
    expect(screen.getByRole('dialog', { name: 'Nova sessão' })).toBeTruthy();
    expect(screen.getByLabelText('Pasta')).toBeTruthy();
  });

  it('keeps Plan mode available while requiring the desktop runtime', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Novo terminal', { selector: '.quick-actions button' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Nova sessão' }));
    fireEvent.change(dialog.getByLabelText('Pasta'), { target: { value: 'C:\\project' } });
    fireEvent.change(dialog.getByLabelText('Modo'), { target: { value: 'Plan' } });
    fireEvent.click(dialog.getByRole('button', { name: /Abrir Claude Code/ }));
    expect(screen.getByRole('status').textContent).toContain('aplicativo desktop');
  });

  it('opens command search with Ctrl+P and filters actions', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const palette = within(screen.getByRole('dialog', { name: 'Paleta de comandos' }));
    fireEvent.change(palette.getByLabelText('Buscar comando'), { target: { value: 'Novo grupo' } });
    expect(palette.getByRole('button', { name: /Novo grupo/ })).toBeTruthy();
    expect(palette.queryByRole('button', { name: /Novo projeto/ })).toBeNull();
  });

  it('gives terminal keyboard shortcuts priority over global shortcuts', () => {
    const { container } = render(<App />);
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    const input = document.createElement('textarea');
    terminal.appendChild(input);
    container.appendChild(terminal);
    fireEvent.keyDown(input, { key: 'p', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Paleta de comandos' })).toBeNull();
  });

  it('opens Git tools and asks for a project when none is selected', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Git' }));
    expect(await screen.findByText('Crie um projeto com pasta para usar Git.')).toBeTruthy();
    expect(document.querySelector('.git-empty button')?.textContent).toContain('Novo projeto');
  });

  it('opens the visual agent mapping from the sidebar', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Mapeamento' }));
    expect(await screen.findByRole('heading', { name: 'Mapeamento' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Terminal/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arquitetura/ })).toBeTruthy();
    expect(screen.getByLabelText('Minimapa')).toBeTruthy();
  });

  it('opens personal reminders from the sidebar', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Lembretes' }));
    expect(await screen.findByRole('heading', { name: 'Lembretes' })).toBeTruthy();
    expect(screen.getByPlaceholderText('O que você não pode esquecer?')).toBeTruthy();
  });

  it('reorders terminal tabs by dragging and persists the chosen order', async () => {
    useAppStore.setState({
      activeProjectId: 'project-1',
      sessions: [
        { id: 'a', agent: 'Shell', folder: 'C:\\project', command: 'cmd', resumeId: null, paneId: 'pane-1', status: 'concluído', title: 'Primeira' },
        { id: 'b', agent: 'Shell', folder: 'C:\\project', command: 'cmd', resumeId: null, paneId: 'pane-1', status: 'concluído', title: 'Segunda' },
        { id: 'c', agent: 'Shell', folder: 'C:\\project', command: 'cmd', resumeId: null, paneId: 'pane-1', status: 'concluído', title: 'Terceira' },
      ],
      workspace: {
        groups: [],
        projects: [{ id: 'project-1', groupId: null, name: 'Projeto', folder: 'C:\\project', layout: 'auto', splitRatio: .5, updatedAt: 1 }],
        panes: [{ id: 'pane-1', projectId: 'project-1', position: 0, pinned: false }],
      },
    });
    const { container } = render(<App />);
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('.pane-tabs > button:not(.pane-add)')];
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '' };
    const [, second, third] = tabs();
    second.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 34, height: 34, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.dragStart(third, { dataTransfer });
    expect(data.get('application/x-athenas-session')).toBe('c');
    const dragOver = createEvent.dragOver(second, { dataTransfer });
    Object.defineProperty(dragOver, 'clientX', { value: 10 });
    fireEvent(second, dragOver);
    const drop = createEvent.drop(second, { dataTransfer });
    Object.defineProperty(drop, 'clientX', { value: 10 });
    fireEvent(second, drop);

    await waitFor(() => expect(localStorage.getItem('athenas-terminal-tab-order')).not.toBeNull());
    expect(JSON.parse(localStorage.getItem('athenas-terminal-tab-order') ?? '{}')).toEqual({ 'pane-1': ['a', 'c', 'b'] });
    await waitFor(() => expect(tabs().map((tab) => tab.textContent)).toEqual(['Primeira', 'Terceira', 'Segunda']));
  });
});
