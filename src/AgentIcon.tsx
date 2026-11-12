import { Terminal } from 'lucide-react';
import codexIcon from './assets/brand/codex-icon.png';

import { MascotIcon } from './MascotIcon';
import { useMascot } from './mascot';

function ClaudeMascot({ size }: { size: number }) {
  return <MascotIcon config={useMascot()} size={size} />;
}

/** Agent marks used throughout the app. */
export function AgentIcon({ agent, size = 15 }: { agent: string; size?: number }) {
  if (agent === 'Claude Code') {
    return <ClaudeMascot size={size} />;
  }
  if (agent === 'Codex') {
    return <img className="agent-icon codex" src={codexIcon} width={size} height={size} alt="" aria-hidden="true" />;
  }
  return <Terminal className="agent-icon shell" size={size} aria-hidden="true" />;
}
