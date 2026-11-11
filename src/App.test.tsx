import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('home', () => {
  it('opens the session dialog from the quick action', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Novo terminal', { selector: '.quick-actions button' }));
    expect(screen.getByRole('dialog', { name: 'Nova sessão' })).toBeTruthy();
    expect(screen.getByLabelText('Pasta')).toBeTruthy();
  });

  it('does not silently launch a mode that is not implemented', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Novo terminal', { selector: '.quick-actions button' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Nova sessão' }));
    fireEvent.change(dialog.getByLabelText('Pasta'), { target: { value: 'C:\\project' } });
    fireEvent.change(dialog.getByLabelText('Modo'), { target: { value: 'Plan' } });
    fireEvent.click(dialog.getByRole('button', { name: /Abrir Claude Code/ }));
    expect(screen.getByRole('status').textContent).toContain('Escolha Normal');
  });

  it('opens command search with Ctrl+P and filters actions', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const palette = within(screen.getByRole('dialog', { name: 'Paleta de comandos' }));
    fireEvent.change(palette.getByLabelText('Buscar comando'), { target: { value: 'Novo grupo' } });
    expect(palette.getByRole('button', { name: /Novo grupo/ })).toBeTruthy();
    expect(palette.queryByRole('button', { name: /Novo projeto/ })).toBeNull();
  });
});
