import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { useAppStore } from './store';

afterEach(() => { cleanup(); useAppStore.setState({ paletteOpen: false, section: 'home', sessionOpen: false, projectOpen: false, groupOpen: false, notice: null }); });

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
});
