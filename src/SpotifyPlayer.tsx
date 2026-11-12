import { invoke, isTauri } from '@tauri-apps/api/core';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
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
      <div className="spotify-art" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="12" fill="#1DB954" />
        <path d="M5.2 9.2c4.5-1.3 9.9-.8 13.6 1.5M6.1 12.4c3.8-1 8.5-.5 11.7 1.4M7 15.4c3.1-.8 6.8-.3 9.5 1.2" stroke="#101810" strokeWidth="1.7" strokeLinecap="round" />
      </svg></div>
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
