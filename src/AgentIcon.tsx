import { Terminal } from 'lucide-react';
import codexIcon from './assets/brand/codex-icon.png';

/** Agent marks used throughout the app. */
export function AgentIcon({ agent, size = 15 }: { agent: string; size?: number }) {
  if (agent === 'Claude Code') {
    return <svg className="agent-icon claude" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
      </g>
    </svg>;
  }
  if (agent === 'Codex') {
    return <img className="agent-icon codex" src={codexIcon} width={size} height={size} alt="" aria-hidden="true" />;
  }
  return <Terminal className="agent-icon shell" size={size} aria-hidden="true" />;
}
