import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { AlertTriangle, GitMerge, Network, Play, RefreshCw, RotateCcw, ShieldCheck, Square } from 'lucide-react';
import { Select } from './Select';
import { AgentIcon } from './AgentIcon';
import { confirmAction } from './confirm';
import { displayPath } from './path';
import { ACTIVE_WORKER, StatusBadge, StatusDot, workerStatus } from './status';
import { WorkerDetail, agentIconName, agentLabel, workerElapsed, type Worker, type WorkerResult } from './WorkerDetail';
import { useAppStore } from './store';

/** Claude reports denials as { tool_name, tool_input }; anything else is shown verbatim. */
function describePermission(raw: string | null): { tool: string; detail: string } {
  if (!raw) return { tool: 'uma ferramenta', detail: 'Pedido de permissão indisponível.' };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const tool = typeof record.tool_name === 'string' ? record.tool_name : typeof record.tool === 'string' ? record.tool : 'uma ferramenta';
      const input = record.tool_input ?? record.input;
      if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string') return { tool, detail: (input as Record<string, string>).command };
      return { tool, detail: JSON.stringify(input ?? value, null, 2) };
    }
    return { tool: 'uma ferramenta', detail: JSON.stringify(value, null, 2) };
  } catch { return { tool: 'uma ferramenta', detail: raw }; }
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`orch-stat tone-${tone} ${value ? '' : 'zero'}`}><b>{value}</b><span>{label}</span></div>;
}

export function OrchestratorView() {
  const app = useAppStore();
  const projects = app.workspace.projects.filter((project) => project.folder);
  const [projectId, setProjectId] = useState(app.activeProjectId ?? '');
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<WorkerResult | null>(null);
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude');
  const [brief, setBrief] = useState('');
  const [runId, setRunId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const folder = project?.folder ?? null;
  const runs = useMemo(() => [...new Set(workers.map((worker) => worker.runId))], [workers]);
  const waiting = workers.filter((worker) => worker.status === 'awaiting_permission');
  const selected = workers.find((worker) => worker.id === selectedId) ?? null;
  const now = Math.floor(Date.now() / 1000);
  const count = (...statuses: string[]) => workers.filter((worker) => statuses.includes(worker.status)).length;

  const refresh = async () => {
    if (!isTauri()) return;
    try { setWorkers(await invoke<Worker[]>('orchestration_list', { project: folder })); setError(null); }
    catch (reason) { setError(String(reason)); }
    finally { setLoaded(true); }
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1500); return () => window.clearInterval(timer); }, [folder]);
  // Reload the result whenever the selected worker changes state (e.g. running → completed).
  useEffect(() => {
    if (!selectedId || !isTauri()) return;
    let alive = true;
    void invoke<WorkerResult>('orchestration_result', { workerId: selectedId })
      .then((value) => { if (alive) { setResult(value); setError(null); } })
      .catch((reason) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [selectedId, selected?.status]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(timer); }, [notice]);

  const action = async (run: () => Promise<unknown>, message: string) => {
    try { await run(); setNotice(message); setError(null); await refresh(); }
    catch (reason) { setError(String(reason)); }
  };
  const select = (id: string) => { if (id !== selectedId) setResult(null); setSelectedId(id === selectedId ? null : id); };
  const abort = async (worker: Worker, decision?: 'abort') => {
    if (!(await confirmAction('Abortar este worker e preservar seu worktree para revisão?', { title: 'Abortar worker', confirm: 'Abortar' }))) return;
    if (decision) await action(() => invoke('orchestration_permission', { workerId: worker.id, decision }), 'Worker abortado.');
    else await action(() => invoke('orchestration_abort', { workerId: worker.id }), 'Worker abortado.');
  };
  const land = async (worker: Worker) => {
    if (!(await confirmAction(`Integrar ${worker.branch} na branch base e remover o worktree?`, { title: 'Aterrissar worker', confirm: 'Aterrissar' }))) return;
    await action(() => invoke('orchestration_land', { workerId: worker.id }), 'Worker integrado à branch base.');
  };
  const workerActions = (worker: Worker, size = 'button-sm'): ReactNode => <>
    {worker.status === 'interrupted' && <button className={`button-quiet ${size}`} onClick={() => void action(() => invoke('orchestration_resume', { workerId: worker.id }), 'Worker recolocado na fila.')}><RotateCcw size={13} /> Retomar</button>}
    {worker.status === 'completed' && <button className={`button-primary ${size}`} onClick={() => void land(worker)}><GitMerge size={13} /> Aterrissar</button>}
    {['queued', 'running', 'interrupted'].includes(worker.status) && <button className={`button-ghost danger ${size}`} onClick={() => void abort(worker)}><Square size={11} /> Abortar</button>}
  </>;
  const submitBrief = () => {
    if (!folder || !brief.trim()) return;
    void action(async () => { const worker = await invoke<Worker>('orchestration_delegate', { project: folder, agent, brief, runId: runId || null }); setBrief(''); setRunId(worker.runId); }, 'Worker criado.');
  };

  if (!isTauri()) return <div className="tools-empty">Abra o aplicativo desktop para orquestrar agentes.</div>;
  return <div className="tools-content orchestration">
    <div className="tools-heading">
      <div><span className="section-kicker">Líder + workers</span><h1>Orquestração</h1><p>Workers executam em worktrees isolados. O líder recebe apenas os resultados.</p></div>
      <div className="heading-actions">
        <div className="orchestration-field"><span>Projeto</span><Select label="Projeto" value={project?.id ?? ""} onChange={(value) => { setProjectId(value); setSelectedId(null); setResult(null); }} options={[{ value: "", label: "Selecione" }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} /></div>
        <button className="button-quiet" onClick={() => void refresh()}><RefreshCw size={14} /> Atualizar</button>
      </div>
    </div>
    {error && <p className="tools-error" role="alert">{error}</p>}
    {notice && <p className="tools-success" role="status">{notice}</p>}

    {waiting.length > 0 && <section className="permission-queue" aria-label="Aguardando você">
      <header><AlertTriangle size={15} /><h2>Aguardando você</h2><span className="count">{waiting.length}</span><small>Workers pausados até sua decisão.</small></header>
      {waiting.map((worker) => { const request = describePermission(worker.permissionRequest); return <div className="permission-request" key={worker.id}>
        <div className="permission-body">
          <div className="permission-who"><AgentIcon agent={agentIconName(worker.agent)} size={13} /><strong>{agentLabel(worker.agent)}</strong><code>{worker.branch}</code><button className="link-button" onClick={() => select(worker.id)}>Ver detalhes</button></div>
          <p>Quer usar <b>{request.tool}</b></p>
          <pre>{request.detail}</pre>
        </div>
        <div className="permission-actions">
          <button className="button-primary button-sm" onClick={() => void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'once' }), 'Permissão concedida uma vez; worker retomado.')}><ShieldCheck size={13} /> Aprovar uma vez</button>
          <button className="button-quiet button-sm" onClick={() => void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'session' }), 'Permissão concedida na sessão; worker retomado.')}>Aprovar na sessão</button>
          <button className="button-quiet button-sm" onClick={() => void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'deny' }), 'Permissão negada.')}>Negar</button>
          <button className="button-ghost danger button-sm" onClick={() => void abort(worker, 'abort')}>Abortar</button>
        </div>
      </div>; })}
    </section>}

    <section className="orch-lead" aria-label="Líder">
      <div className="orch-lead-id">
        <span className="orch-node"><Network size={17} /></span>
        <div><span className="section-kicker">Líder</span><strong>{project?.name ?? 'Escolha um projeto'}</strong><small title={displayPath(folder ?? '')}>{folder ? displayPath(folder) : 'Projetos precisam de uma pasta para orquestrar.'}</small></div>
      </div>
      <div className="orch-stats">
        <Stat label="Executando" value={count('running')} tone="running" />
        <Stat label="Na fila" value={count('queued')} tone="queued" />
        <Stat label="Aguardando você" value={count('awaiting_permission', 'interrupted')} tone="waiting" />
        <Stat label="Concluídos" value={count('completed', 'landed')} tone="done" />
        <Stat label="Com erro" value={count('failed')} tone="error" />
      </div>
      <div className="orch-lead-actions">
        <small>{runs.length} run(s) · limite {app.preferences.workerLimit} em paralelo</small>
        <div>
          <button className="button-quiet button-sm" disabled={!folder} title="Registra o MCP hera_* para uma sessão líder do Claude Code" onClick={() => void action(() => invoke('mcp_register_orchestrator', { projectFolder: folder, agent: 'Claude Code' }), 'MCP do Claude registrado. Reinicie a sessão líder para carregar as ferramentas.')}><AgentIcon agent="Claude Code" size={13} /> Ativar líder Claude</button>
          <button className="button-quiet button-sm" disabled={!folder} title="Registra o MCP hera_* para uma sessão líder do Codex" onClick={() => void action(() => invoke('mcp_register_orchestrator', { projectFolder: folder, agent: 'Codex' }), 'MCP do Codex registrado. Reinicie a sessão líder para carregar as ferramentas.')}><AgentIcon agent="Codex" size={13} /> Ativar líder Codex</button>
        </div>
      </div>
      <form className="orch-delegate" onSubmit={(event) => { event.preventDefault(); submitBrief(); }}>
        <textarea aria-label="Brief" rows={2} placeholder="Descreva a tarefa para um novo worker…" value={brief} disabled={!folder} onChange={(event) => setBrief(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); event.stopPropagation(); submitBrief(); } }} />
        <div className="orch-delegate-bar">
          <span className="hint">O líder também delega pelo MCP com <code>hera_delegate</code>.</span>
          <Select label="Agente worker" value={agent} onChange={(value) => setAgent(value as "claude" | "codex")} options={[{ value: "claude", label: "Claude", icon: <AgentIcon agent="Claude Code" size={13} /> }, { value: "codex", label: "Codex", icon: <AgentIcon agent="Codex" size={13} /> }]} />
          <Select label="Run" value={runId} onChange={setRunId} options={[{ value: "", label: "Novo run" }, ...runs.map((id) => ({ value: id, label: `Run ${id.slice(0, 8)}` }))]} />
          <button className="button-primary" disabled={!folder || !brief.trim()}><Play size={13} /> Delegar <span>Ctrl ↵</span></button>
        </div>
      </form>
    </section>

    <div className={`orch-workspace ${selected ? 'with-detail' : ''}`}>
      <div className="orch-board">
        {!loaded ? <div className="orch-skeleton" aria-label="Carregando workers"><i /><i /><i /></div>
          : workers.length === 0 ? <div className="empty-state"><span className="empty-icon"><Network size={20} /></span><div><strong>Nenhum worker neste projeto.</strong><p>Delegue uma tarefa acima ou ative um líder para que ele distribua o trabalho.</p></div></div>
          : runs.map((id) => {
            const members = workers.filter((worker) => worker.runId === id);
            const finished = members.filter((worker) => worker.status === 'completed' || worker.status === 'landed').length;
            const failed = members.filter((worker) => worker.status === 'failed' || worker.status === 'aborted').length;
            const activeRun = members.some((worker) => ACTIVE_WORKER.includes(worker.status));
            return <section className={`orch-run ${activeRun ? 'active' : ''}`} key={id}>
              <header>
                <span className="orch-run-id">Run <code>{id.slice(0, 8)}</code></span>
                <span className="orch-run-meta">{finished}/{members.length} concluído(s){failed ? ` · ${failed} sem sucesso` : ''}</span>
                <div className="progress" role="progressbar" aria-label={`Progresso do run ${id.slice(0, 8)}`} aria-valuemin={0} aria-valuemax={members.length} aria-valuenow={finished}>
                  <i className="done" style={{ width: `${(finished / members.length) * 100}%` }} /><i className="failed" style={{ width: `${(failed / members.length) * 100}%` }} />
                </div>
              </header>
              <ul className="orch-workers">
                {members.map((worker) => {
                  const info = workerStatus(worker.status);
                  const elapsed = workerElapsed(worker, now);
                  return <li key={worker.id} className={`worker-row tone-${info.tone} ${selectedId === worker.id ? 'selected' : ''}`}>
                    <button className="worker-main" aria-pressed={selectedId === worker.id} aria-label={`${agentLabel(worker.agent)}: ${worker.brief}`} onClick={() => select(worker.id)}>
                      <StatusDot info={info} />
                      <span className="worker-agent"><AgentIcon agent={agentIconName(worker.agent)} size={13} />{agentLabel(worker.agent)}</span>
                      <span className="worker-brief" title={worker.brief}>{worker.brief}</span>
                      <code className="worker-branch" title={worker.branch}>{worker.branch}</code>
                      <span className="worker-meta">{elapsed && <span>{elapsed}</span>}{(worker.filesChanged ?? 0) > 0 && <span>{worker.filesChanged} arq · {worker.linesChanged ?? 0} lin</span>}</span>
                      <StatusBadge info={info} />
                    </button>
                    <div className="worker-actions">{workerActions(worker)}</div>
                    {worker.error && worker.status !== 'awaiting_permission' && <div className="worker-error">{worker.error}</div>}
                  </li>;
                })}
              </ul>
            </section>;
          })}
      </div>
      {selected && <WorkerDetail key={selected.id} worker={selected} result={result?.worker.id === selected.id ? result : null} now={now} actions={workerActions(selected, '')} onClose={() => { setSelectedId(null); setResult(null); }} />}
    </div>
  </div>;
}
