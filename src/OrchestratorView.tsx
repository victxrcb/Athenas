import { useEffect, useMemo, useState } from 'react';
import { Select } from './Select';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { GitMerge, Play, RefreshCw } from 'lucide-react';
import { useAppStore } from './store';

type Worker = { id: string; runId: string; project: string; agent: string; brief: string; branch: string;
  worktree: string; status: string; startedAt: number | null; finishedAt: number | null;
  tokens: number | null; costUsd: number | null; filesChanged: number | null; linesChanged: number | null; error: string | null; permissionRequest: string | null };
type Result = { worker: Worker; result: string; diff: string; outcome: string };

export function OrchestratorView() {
  const app = useAppStore();
  const projects = app.workspace.projects.filter((project) => project.folder);
  const [projectId, setProjectId] = useState(app.activeProjectId ?? '');
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude');
  const [brief, setBrief] = useState('');
  const [runId, setRunId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const folder = project?.folder ?? null;
  const runs = useMemo(() => [...new Set(workers.map((worker) => worker.runId))], [workers]);
  const waiting = workers.filter((worker) => worker.status === 'awaiting_permission');
  const refresh = async () => {
    if (!isTauri()) return;
    try { setWorkers(await invoke<Worker[]>('orchestration_list', { project: folder })); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1500); return () => window.clearInterval(timer); }, [folder]);
  const action = async (run: () => Promise<unknown>, message: string) => {
    try { await run(); setNotice(message); setError(null); await refresh(); }
    catch (reason) { setError(String(reason)); }
  };
  const openResult = async (id: string) => {
    setSelectedId(id);
    try { setResult(await invoke<Result>('orchestration_result', { workerId: id })); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  if (!isTauri()) return <div className="tools-empty">Abra o aplicativo desktop para orquestrar agentes.</div>;
  return <div className="tools-content orchestration">
    <div className="tools-heading"><div><span className="section-kicker">LÍDER + WORKERS</span><h1>Orquestração</h1><p>Workers executam em worktrees isolados. O líder recebe apenas os resultados.</p></div><button onClick={() => void refresh()}><RefreshCw size={15} /> Atualizar</button></div>
    {error && <p className="tools-error" role="alert">{error}</p>}{notice && <p className="tools-success" role="status">{notice}</p>}
    <div className="orchestration-controls"><div className="orchestration-field"><span>Projeto</span><Select label="Projeto" value={project?.id ?? ""} onChange={(value) => { setProjectId(value); setSelectedId(null); setResult(null); }} options={[{ value: "", label: "Selecione" }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} /></div><button disabled={!folder} onClick={() => void action(() => invoke('mcp_register_orchestrator', { projectFolder: folder, agent: 'Claude Code' }), 'MCP do Claude registrado. Reinicie a sessão líder para carregar as ferramentas.')}>Ativar líder Claude</button><button disabled={!folder} onClick={() => void action(() => invoke('mcp_register_orchestrator', { projectFolder: folder, agent: 'Codex' }), 'MCP do Codex registrado. Reinicie a sessão líder para carregar as ferramentas.')}>Ativar líder Codex</button></div>
    <form className="orchestration-delegate" onSubmit={(event) => { event.preventDefault(); if (!folder || !brief.trim()) return; void action(async () => { const worker = await invoke<Worker>('orchestration_delegate', { project: folder, agent, brief, runId: runId || null }); setBrief(''); setRunId(worker.runId); }, 'Worker criado.'); }}><div><strong>Delegar pelo board</strong><small>O líder também pode usar hera_delegate pelo MCP.</small></div><Select label="Agente worker" value={agent} onChange={(value) => setAgent(value as "claude" | "codex")} options={[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }]} /><Select label="Run" value={runId} onChange={setRunId} options={[{ value: "", label: "Novo run" }, ...runs.map((id) => ({ value: id, label: id.slice(0, 8) }))]} /><input aria-label="Brief" placeholder="Descreva a tarefa do worker" value={brief} onChange={(event) => setBrief(event.target.value)} /><button className="button-primary" disabled={!folder || !brief.trim()}><Play size={14} /> Delegar</button></form>
    {waiting.length > 0 && <section className="permission-queue"><h2>Aguardando você · {waiting.length}</h2>{waiting.map((worker) => <div className="permission-request" key={worker.id}><div><strong>{worker.agent} · {worker.branch}</strong><pre>{worker.permissionRequest ? JSON.stringify(JSON.parse(worker.permissionRequest), null, 2) : 'Pedido de permissão indisponível.'}</pre></div><div className="permission-actions"><button onClick={() => void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'once' }), 'Permissão concedida uma vez; worker retomado.')}>Aprovar uma vez</button><button onClick={() => void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'session' }), 'Permissão concedida na sessão; worker retomado.')}>Aprovar na sessão</button><button onClick={() => void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'deny' }), 'Permissão negada.')}>Negar</button><button onClick={() => { if (window.confirm('Abortar este worker e preservar seu worktree para revisão?')) void action(() => invoke('orchestration_permission', { workerId: worker.id, decision: 'abort' }), 'Worker abortado.'); }}>Abortar</button></div></div>)}</section>}
    {workers.some((worker) => ['queued', 'running', 'interrupted'].includes(worker.status)) && <div className="worker-live-actions">{workers.filter((worker) => ['queued', 'running', 'interrupted'].includes(worker.status)).map((worker) => <div key={worker.id}><span>{worker.agent} · {worker.branch} · {worker.status}</span><button onClick={() => { if (window.confirm('Abortar o worker e preservar seu worktree para revisão?')) void action(() => invoke('orchestration_abort', { workerId: worker.id }), 'Worker abortado.'); }}>Abortar</button></div>)}</div>}
    <div className="orchestration-board"><div className="orchestration-planner"><span>PLANNER</span><strong>{project?.name ?? 'Escolha um projeto'}</strong><small>{runs.length} run(s) · {workers.length} worker(s) · limite {app.preferences.workerLimit} em paralelo</small></div>
      {workers.length === 0 ? <div className="orchestration-empty">Nenhum worker neste projeto.</div> : runs.map((id) => <section className="orchestration-run" key={id}><header>RUN {id.slice(0, 8)}<small>{workers.filter((worker) => worker.runId === id).length} worker(s)</small></header><div className="orchestration-cards">{workers.filter((worker) => worker.runId === id).map((worker) => <article className={`orchestration-card status-${worker.status}`} key={worker.id}><div className="worker-top"><span>{worker.agent.toUpperCase()}</span><b>{worker.status === 'completed' ? 'Concluído' : worker.status === 'landed' ? 'Integrado' : worker.status === 'running' ? 'Executando' : worker.status === 'queued' ? 'Na fila' : worker.status === 'interrupted' ? 'Interrompido' : 'Falhou'}</b></div><p>{worker.brief}</p><small>{worker.branch}</small><div className="worker-metrics"><span>{worker.costUsd == null ? 'Custo indisponível' : `$${worker.costUsd.toFixed(4)}`}</span><span>{worker.tokens == null ? 'Tokens indisponíveis' : `${worker.tokens} tokens`}</span><span>{worker.filesChanged ?? 0} arquivos · {worker.linesChanged ?? 0} linhas</span></div>{worker.error && <div className="worker-error">{worker.error}</div>}<div className="worker-actions"><button onClick={() => void openResult(worker.id)}>Ver resultado e diff</button>{worker.status === 'interrupted' && <button onClick={() => void action(() => invoke('orchestration_resume', { workerId: worker.id }), 'Worker recolocado na fila.')}>Retomar</button>}{worker.status === 'completed' && <button onClick={() => { if (!window.confirm(`Integrar ${worker.branch} na branch base e remover o worktree?`)) return; void action(() => invoke('orchestration_land', { workerId: worker.id }), 'Worker integrado à branch base.'); }}><GitMerge size={13} /> Aterrissar</button>}</div></article>)}</div></section>)}
    </div>
    {selectedId && result && <div className="orchestration-result"><div><h2>Resultado de {result.worker.agent}</h2><button onClick={() => { setSelectedId(null); setResult(null); }}>Fechar</button></div><pre>{result.result || 'Resultado ainda não disponível.'}</pre><h3>Diff</h3><pre>{result.diff || 'Nenhuma alteração registrada.'}</pre><h3>Outcome</h3><pre>{result.outcome || 'Worker em andamento.'}</pre></div>}
  </div>;
}
