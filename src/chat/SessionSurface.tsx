import { lazy, Suspense } from 'react';
import type { SessionInfo } from '../store';
import { useViewMode, ViewSwitch } from './ViewSwitch';
import './surface.css';

const TerminalView = lazy(() => import('../TerminalView').then((module) => ({ default: module.TerminalView })));
const ChatView = lazy(() => import('./ChatView').then((module) => ({ default: module.ChatView })));

const loading = (what: string) => <div className="terminal-loading">Carregando {what}…</div>;

/** One session as a conversation, as its terminal, or both. Shells only have a terminal. */
export function SessionSurface({ session, onStatus, onResume, ended }: {
  session: SessionInfo; onStatus: (session: SessionInfo) => void; onResume: () => void;
  /** Shown instead of the terminal once the process is gone. */
  ended: React.ReactNode;
}) {
  const mode = useViewMode(session.id);
  const running = session.status === 'rodando';
  const terminal = (viewSwitch?: React.ReactNode) => running
    ? <Suspense fallback={loading('terminal')}><TerminalView key={session.id} session={session} onStatus={onStatus} viewSwitch={viewSwitch} /></Suspense>
    : viewSwitch ? <div className="surface-ended"><div className="surface-bar">{viewSwitch}</div>{ended}</div> : ended;
  if (session.agent === 'Shell') return <>{terminal()}</>;
  if (mode === 'terminal') return <>{terminal(<ViewSwitch sessionId={session.id} />)}</>;
  return <div className={`session-surface ${mode}`}>
    <Suspense fallback={loading('conversa')}><ChatView key={session.id} session={session} onResume={onResume} /></Suspense>
    {mode === 'split' && <div className="surface-terminal">{terminal()}</div>}
  </div>;
}
