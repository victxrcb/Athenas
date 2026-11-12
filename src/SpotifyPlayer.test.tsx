import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyPlayer } from './SpotifyPlayer';

const mock = vi.hoisted(() => ({
  track: null as null | { title: string; artist: string; album: string; isPlaying: boolean },
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mock.invoke,
}));

afterEach(() => { cleanup(); mock.invoke.mockReset(); mock.track = null; });

describe('Spotify player', () => {
  it('shows an empty state and disables controls without a Spotify media session', async () => {
    mock.invoke.mockResolvedValue(null);
    render(<SpotifyPlayer />);
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('spotify_status'));
    expect(screen.getByText('Nada tocando')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Próxima música' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the current song and sends playback commands', async () => {
    mock.track = { title: 'Minha música', artist: 'Artista', album: 'Álbum', isPlaying: true };
    mock.invoke.mockImplementation(async (command: string, args?: { action: string }) => {
      if (command === 'spotify_control' && args?.action === 'toggle' && mock.track) mock.track = { ...mock.track, isPlaying: false };
      return mock.track;
    });
    render(<SpotifyPlayer />);
    expect(await screen.findByText('Minha música')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar Spotify' }));
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('spotify_control', { action: 'toggle' }));
    expect(await screen.findByRole('button', { name: 'Reproduzir Spotify' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima música' }));
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('spotify_control', { action: 'next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Música anterior' }));
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('spotify_control', { action: 'previous' }));
  });
});
