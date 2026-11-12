import { invoke, isTauri } from '@tauri-apps/api/core';
import { Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import './spotify.css';

type Track = { title: string; artist: string; album: string; isPlaying: boolean };
type Action = 'previous' | 'toggle' | 'next';

export function SpotifyPlayer() {
  const [track, setTrack] = useState<Track | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setTrack(await invoke<Track | null>('spotify_status'));
      setError(null);
    } catch {
      setTrack(null);
      setError('Não foi possível ler a mídia do Windows.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const control = async (action: Action) => {
    if (busy) return;
    setBusy(true);
    try {
      setTrack(await invoke<Track | null>('spotify_control', { action }));
      setError(null);
      window.setTimeout(() => void refresh(), 700);
    } catch {
      setError('O Spotify não aceitou o comando.');
    } finally {
      setBusy(false);
    }
  };

  return <section className="spotify-player" aria-label="Player do Spotify">
    <div className="spotify-track">
      <div className="spotify-art" aria-hidden="true"><Music2 size={18} /></div>
      <div className="spotify-info">
        <span className="spotify-label">SPOTIFY</span>
        <strong title={track?.title}>{track?.title || 'Nada tocando'}</strong>
        <small title={track?.album || undefined}>{track?.artist || (error ?? 'Reproduza uma música no Spotify')}</small>
      </div>
    </div>
    {error && track && <small className="spotify-error" role="alert">{error}</small>}
    <div className="spotify-controls">
      <button type="button" aria-label="Música anterior" title="Música anterior" disabled={!track || busy} onClick={() => void control('previous')}><SkipBack size={16} fill="currentColor" /></button>
      <button type="button" className="spotify-toggle" aria-label={track?.isPlaying ? 'Pausar Spotify' : 'Reproduzir Spotify'} title={track?.isPlaying ? 'Pausar' : 'Reproduzir'} disabled={!track || busy} onClick={() => void control('toggle')}>{track?.isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
      <button type="button" aria-label="Próxima música" title="Próxima música" disabled={!track || busy} onClick={() => void control('next')}><SkipForward size={16} fill="currentColor" /></button>
    </div>
  </section>;
}
