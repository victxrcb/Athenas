/** One visual language for every state shown in the app: terminal sessions and orchestrator workers. */
export type StatusTone = 'idle' | 'queued' | 'running' | 'waiting' | 'attention' | 'done' | 'landed' | 'error' | 'cancelled';
export type StatusInfo = { tone: StatusTone; label: string; live: boolean };

const WORKER: Record<string, StatusInfo> = {
  queued: { tone: 'queued', label: 'Na fila', live: false },
  running: { tone: 'running', label: 'Executando', live: true },
  awaiting_permission: { tone: 'waiting', label: 'Aguardando você', live: false },
  interrupted: { tone: 'attention', label: 'Interrompido', live: false },
  completed: { tone: 'done', label: 'Concluído', live: false },
  landed: { tone: 'landed', label: 'Integrado', live: false },
  failed: { tone: 'error', label: 'Erro', live: false },
  aborted: { tone: 'cancelled', label: 'Cancelado', live: false },
};

const SESSION: Record<string, StatusInfo> = {
  iniciando: { tone: 'queued', label: 'Iniciando', live: true },
  rodando: { tone: 'running', label: 'Ativo', live: true },
  'concluído': { tone: 'idle', label: 'Encerrado', live: false },
  erro: { tone: 'error', label: 'Erro', live: false },
};

/** Unknown states keep their raw name instead of being reported as failures. */
export function workerStatus(status: string): StatusInfo {
  return WORKER[status] ?? { tone: 'idle', label: status || 'Desconhecido', live: false };
}

export function sessionStatus(status: string): StatusInfo {
  return SESSION[status] ?? { tone: 'idle', label: status || 'Desconhecido', live: false };
}

export const ACTIVE_WORKER = ['queued', 'running', 'interrupted', 'awaiting_permission'];

export function StatusDot({ info, className }: { info: StatusInfo; className?: string }) {
  return <i className={`status-dot tone-${info.tone}${info.live ? ' live' : ''}${className ? ` ${className}` : ''}`} title={info.label} aria-hidden="true" />;
}

export function StatusBadge({ info }: { info: StatusInfo }) {
  return <span className={`status-badge tone-${info.tone}${info.live ? ' live' : ''}`}><i aria-hidden="true" />{info.label}</span>;
}

/** "3 min", "1 h 05 min" — compact durations for elapsed time. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
