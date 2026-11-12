import { AgentIcon } from './AgentIcon';
import { useAppStore } from './store';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const tone = (percent: number) => (percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low');

type UsageWindow = { usedPercent: number; resetsAt: string | null };
type AgentQuota = { agent: string; fiveHour: UsageWindow | null; weekly: UsageWindow | null; error: string | null };

const resetLabel = (value: string | null) => {
  if (!value) return 'Horário indisponível';
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? 'Horário indisponível' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
};

/** Account quota is refreshed separately from the live process memory snapshot. */
export function UsageBar() {
  const { agents, totalBytes, appBytes } = useAppStore((state) => state.memory);
  const [quotas, setQuotas] = useState<AgentQuota[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const refresh = () => { void invoke<AgentQuota[]>('agent_quotas').then((result) => { if (active) setQuotas(result); }).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 300_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const detail = quotas.find((item) => item.agent === selected);
  return <div className="usage-bar" aria-label="Uso de recursos">
    {agents.map((item) => {
      if (item.agent === 'Shell') return <span key={item.agent} className="usage-agent" title={`Shell: ${megabytes(item.bytes)} em ${item.sessions} ${item.sessions === 1 ? 'sessão' : 'sessões'}`}><AgentIcon agent={item.agent} size={14} />Shell</span>;
      const quota = quotas.find((entry) => entry.agent === item.agent);
      const percent = quota?.fiveHour?.usedPercent;
      return <button type="button" key={item.agent} className={`usage-agent ${percent == null ? '' : tone(percent)}`}
        title={`${item.agent}: ${percent == null ? 'cota de 5h indisponível' : `${Math.round(percent)}% da cota de 5h utilizada`} · ${megabytes(item.bytes)} em ${item.sessions} ${item.sessions === 1 ? 'sessão' : 'sessões'}`}
        aria-label={`Uso de ${item.agent}`} onClick={() => setSelected(item.agent)}>
        <AgentIcon agent={item.agent} size={14} />{percent == null ? '—' : `${Math.round(percent)}%`}<small>5h</small>
      </button>;
    })}
    <span className="usage-ram" title={`App ${megabytes(appBytes)} · Agentes ${megabytes(totalBytes - appBytes)}`}>App {megabytes(appBytes)}</span>
    {selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <div className="small-modal usage-modal" role="dialog" aria-modal="true" aria-label={`Cota de ${selected}`}>
        <div className="modal-top"><span className="section-kicker">Cota · {selected}</span><button type="button" aria-label="Fechar modal" onClick={() => setSelected(null)}>×</button></div>
        {detail?.error && <p className="usage-error">{detail.error}</p>}
        <div className="usage-window"><span>Sessão de 5 horas</span><strong>{detail?.fiveHour ? `${Math.round(detail.fiveHour.usedPercent)}% utilizada` : 'Indisponível'}</strong><small>Renova em {resetLabel(detail?.fiveHour?.resetsAt ?? null)}</small></div>
        <div className="usage-window"><span>Semana</span><strong>{detail?.weekly ? `${Math.round(detail.weekly.usedPercent)}% utilizada` : 'Indisponível'}</strong><small>Renova em {resetLabel(detail?.weekly?.resetsAt ?? null)}</small></div>
      </div>
    </div>}
  </div>;
}
