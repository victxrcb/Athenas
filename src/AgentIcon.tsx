import { Terminal } from 'lucide-react';

/** Own simple marks for each agent (not the vendors' logos), colored to tell them apart at a glance. */
export function AgentIcon({ agent, size = 15 }: { agent: string; size?: number }) {
  if (agent === 'Claude Code') {
    return <svg className="agent-icon claude" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
      </g>
    </svg>;
  }
  if (agent === 'Codex') {
    return <svg className="agent-icon codex" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M9.5 10l-2 2 2 2M14.5 10l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>;
  }
  return <Terminal className="agent-icon shell" size={size} aria-hidden="true" />;
}
