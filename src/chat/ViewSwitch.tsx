import { Columns2, MessagesSquare, TerminalSquare } from 'lucide-react';
import { setViewMode, useChatPrefs, type ViewMode } from './prefs';

const MODES: { id: ViewMode; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <MessagesSquare size={13} /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalSquare size={13} /> },
  { id: 'split', label: 'Dividido', icon: <Columns2 size={13} /> },
];

export const useViewMode = (id: string) => useChatPrefs((state) => state.modes[id] ?? state.lastMode);

/** Changes only what is on screen: the process, its history and its context stay as they are. */
export function ViewSwitch({ sessionId, split = true }: { sessionId: string; split?: boolean }) {
  const mode = useViewMode(sessionId);
  return <div className="chat-segments chat-view-switch" role="group" aria-label="Visualização da sessão">
    {MODES.filter((item) => split || item.id !== 'split').map((item) => <button key={item.id} type="button" data-view={item.id} aria-pressed={mode === item.id} title={item.label} aria-label={item.label} onClick={() => setViewMode(sessionId, item.id)}>
      {item.icon}<span>{item.label}</span>
    </button>)}
  </div>;
}
