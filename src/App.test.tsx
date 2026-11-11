import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('home', () => {
  it('opens the session dialog from the quick action', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Novo terminal', { selector: '.quick-actions button' }));
    expect(screen.getByRole('dialog', { name: 'Nova sessão' })).toBeTruthy();
    expect(screen.getByLabelText('Pasta')).toBeTruthy();
  });
});
