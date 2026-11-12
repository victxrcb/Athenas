import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, Brain, CheckCircle2, ChevronRight, CircleDashed, FileCode2, FilePen, ListChecks, MessageSquare, Terminal, User, Wrench, X } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { StatusBadge, formatDuration, workerStatus } from './status';
import { parseDiff, parseTranscript, type TranscriptEntry } from './transcript';

export type Worker = { id: string; runId: string; project: string; agent: string; brief: string; branch: string;
  worktree: string; status: string; startedAt: number | null; finishedAt: number | null;
  tokens: number | null; costUsd: number | null; filesChanged: number | null; linesChanged: number | null; error: string | null; permissionRequest: string | null };
export type WorkerResult = { worker: Worker; result: string; diff: string; outcome: string };
type Transcript = { text: string; truncated: boolean };
type Tab = 'result' | 'execution' | 'diff' | 'outcome';

export const agentLabel = (agent: string) => (agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : agent);
export const agentIconName = (agent: string) => (agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude Code' : 'Shell');

export function workerElapsed(worker: Worker, now: number): string | null {
  if (!worker.startedAt) return null;
  const end = worker.finishedAt ?? (worker.status === 'running' ? now : null);
  return end ? formatDuration(end - worker.startedAt) : null;
}

const MAX_DIFF_LINES = 6000;

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (!files.length) return <p className="detail-empty">Nenhuma alteração registrada.</p>;
  let budget = MAX_DIFF_LINES;
  return <div className="diff-files">
    {files.map((file, index) => {
      const lines = file.lines.slice(0, Math.max(0, budget));
      budget -= lines.length;
      return <details className="diff-file" key={`${file.path}-${index}`} open={files.length <= 8}>
        <summary><ChevronRight size={13} className="chevron" /><FileCode2 size={13} /><span className="diff-path" title={file.path}>{file.path}</span><span className="diff-stat"><b className="add">+{file.added}</b><b className="del">−{file.removed}</b></span></summary>
        <div className="diff-lines">{lines.map((line, row) => <div key={row} className={`diff-line ${line.kind}`}>{line.text || ' '}</div>)}
          {lines.length < file.lines.length && <div className="diff-line meta">… diff truncado na visualização.</div>}</div>
      </details>;
    })}
  </div>;
}

function Collapsible({ className, icon, title, meta, children, open }: { className: string; icon: ReactNode; title: ReactNode; meta?: ReactNode; children: ReactNode; open?: boolean }) {
  return <details className={`tx ${className}`} open={open}>
    <summary><ChevronRight size={12} className="chevron" />{icon}<span className="tx-title">{title}</span>{meta}</summary>
    <div className="tx-body">{children}</div>
  </details>;
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'message':
      return <div className="tx tx-message"><span className="tx-icon"><MessageSquare size={13} /></span><div className="tx-text">{entry.text}</div></div>;
    case 'reasoning':
      return <Collapsible className="tx-reasoning" icon={<Brain size={13} />} title="Raciocínio"><p className="tx-text">{entry.text}</p></Collapsible>;
    case 'command': {
      const failed = entry.exitCode !== null && entry.exitCode !== 0;
      return <Collapsible className={`tx-command ${failed ? 'failed' : ''}`} open={entry.running || failed} icon={<Terminal size={13} />} title={<code>{entry.command}</code>}
        meta={entry.running ? <span className="tx-chip running"><CircleDashed size={11} /> executando</span> : entry.exitCode !== null ? <span className={`tx-chip ${failed ? 'error' : 'ok'}`}>exit {entry.exitCode}</span> : undefined}>
        {entry.output ? <pre>{entry.output}</pre> : <p className="detail-empty">Sem saída.</p>}
      </Collapsible>;
    }
    case 'files':
      return <div className="tx tx-files"><span className="tx-icon"><FilePen size={13} /></span><div><span className="tx-label">Arquivos alterados</span>
        <ul>{entry.changes.map((change) => <li key={change.path}><b className={`kind-${change.kind}`}>{change.kind === 'add' ? 'A' : change.kind === 'delete' ? 'D' : 'M'}</b><code>{change.path}</code></li>)}</ul></div></div>;
    case 'tool':
      return <Collapsible className={`tx-tool ${entry.failed ? 'failed' : ''}`} icon={<Wrench size={13} />} title={<>{entry.name} {entry.detail && <code>{entry.detail}</code>}</>}
        meta={entry.running ? <span className="tx-chip running"><CircleDashed size={11} /> em andamento</span> : entry.failed ? <span className="tx-chip error">falhou</span> : undefined}>
        {entry.output ? <pre>{entry.output}</pre> : <p className="detail-empty">Sem retorno.</p>}
      </Collapsible>;
    case 'todo':
      return <div className="tx tx-todo"><span className="tx-icon"><ListChecks size={13} /></span><ul>{entry.items.map((item, index) => <li key={index} className={item.done ? 'done' : ''}>{item.done ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />}{item.text}</li>)}</ul></div>;
    case 'result':
      return <div className={`tx tx-result ${entry.failed ? 'failed' : ''}`}><span className="tx-icon">{entry.failed ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}</span><div>
        <span className="tx-label">{entry.failed ? 'Resultado com erro' : 'Resumo da execução'}</span>
        {entry.meta.length > 0 && <div className="tx-meta">{entry.meta.map((item) => <span key={item}>{item}</span>)}</div>}
        {entry.text && <div className="tx-text">{entry.text}</div>}</div></div>;
    case 'error':
      return <div className="tx tx-error"><span className="tx-icon"><AlertCircle size={13} /></span><div className="tx-text">{entry.text}</div></div>;
    case 'log': {
      const count = entry.text.split('\n').length;
      return <Collapsible className="tx-log" icon={null} title={`Log técnico · ${count} ${count === 1 ? 'linha' : 'linhas'}`}><pre>{entry.text}</pre></Collapsible>;
    }
  }
}

function TranscriptView({ worker }: { worker: Worker }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const live = worker.status === 'running';
  useEffect(() => {
    let alive = true;
    const load = () => invoke<Transcript>('orchestration_transcript', { workerId: worker.id })
      .then((value) => { if (alive) { setTranscript((current) => (current?.text === value.text && current.truncated === value.truncated ? current : value)); setError(null); } })
      .catch((reason) => { if (alive) setError(String(reason)); });
    void load();
    const timer = live ? window.setInterval(() => void load(), 2000) : undefined;
    return () => { alive = false; if (timer) window.clearInterval(timer); };
  }, [worker.id, live]);
  const entries = useMemo(() => parseTranscript(transcript?.text ?? ''), [transcript]);
  // Follow new output only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [entries]);
  if (error) return <p className="tools-error" role="alert">{error}</p>;
  if (!transcript) return <p className="detail-empty">Carregando execução…</p>;
  return <div className="transcript" ref={scroller} onScroll={(event) => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
    {transcript.truncated && <p className="transcript-note">Mostrando apenas o trecho final da execução.</p>}
    <div className="tx tx-instruction"><span className="tx-icon"><User size={13} /></span><div><span className="tx-label">Instrução delegada</span><div className="tx-text">{worker.brief}</div></div></div>
    {entries.map((entry) => <Entry key={entry.id} entry={entry} />)}
    {!entries.length && <p className="detail-empty">{live ? 'Aguardando a primeira saída do worker…' : 'Nenhum registro de execução.'}</p>}
    {live && <div className="transcript-live"><span className="activity" aria-hidden="true"><i /><i /><i /></span> Worker em execução</div>}
  </div>;
}

function OutcomeView({ outcome }: { outcome: string }) {
  let data: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(outcome); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { data = null; }
  if (!outcome) return <p className="detail-empty">Worker em andamento.</p>;
  if (!data) return <pre className="detail-pre">{outcome}</pre>;
  const value = (key: string) => data?.[key];
  const rows: [string, ReactNode][] = [
    ['Estado', typeof value('status') === 'string' ? workerStatus(value('status') as string).label : '—'],
    ['Duração', typeof value('duration_ms') === 'number' ? formatDuration((value('duration_ms') as number) / 1000) : '—'],
    ['Código de saída', value('exit_code') == null ? '—' : String(value('exit_code'))],
    ['Arquivos', value('files_changed') == null ? '—' : String(value('files_changed'))],
    ['Linhas', value('lines_changed') == null ? '—' : String(value('lines_changed'))],
    ['Tokens', value('tokens') == null ? '—' : String(value('tokens'))],
    ['Custo', typeof value('cost_usd') === 'number' ? `$${(value('cost_usd') as number).toFixed(4)}` : '—'],
  ];
  return <><dl className="detail-facts">{rows.map(([label, content]) => <div key={label}><dt>{label}</dt><dd>{content}</dd></div>)}</dl>
    {typeof value('error') === 'string' && <div className="worker-error">{value('error') as string}</div>}
    <details className="tx tx-log"><summary><ChevronRight size={12} className="chevron" /><span className="tx-title">outcome.json</span></summary><div className="tx-body"><pre>{outcome}</pre></div></details></>;
}

export function WorkerDetail({ worker, result, now, actions, onClose }: { worker: Worker; result: WorkerResult | null; now: number; actions: ReactNode; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('result');
  const info = workerStatus(worker.status);
  const elapsed = workerElapsed(worker, now);
  const diffFiles = useMemo(() => (result ? parseDiff(result.diff).length : 0), [result]);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'result', label: 'Resultado' },
    { id: 'execution', label: 'Execução' },
    { id: 'diff', label: 'Diff', count: diffFiles || undefined },
    { id: 'outcome', label: 'Outcome' },
  ];
  return <aside className={`orch-detail tone-${info.tone}`} aria-label={`Detalhes do worker ${agentLabel(worker.agent)}`}>
    <header className="detail-head">
      <span className="agent-avatar"><AgentIcon agent={agentIconName(worker.agent)} size={16} /></span>
      <div className="detail-title"><strong>{agentLabel(worker.agent)} <span>· worker</span></strong><code title={worker.branch}>{worker.branch}</code></div>
      <StatusBadge info={info} />
      <button className="icon-button" aria-label="Fechar detalhes" onClick={onClose}><X size={15} /></button>
    </header>
    <dl className="detail-facts compact">
      <div><dt>Run</dt><dd><code>{worker.runId.slice(0, 8)}</code></dd></div>
      <div><dt>Duração</dt><dd>{elapsed ?? '—'}</dd></div>
      <div><dt>Alterações</dt><dd>{worker.filesChanged ?? 0} arq · {worker.linesChanged ?? 0} lin</dd></div>
      {worker.tokens != null && <div><dt>Tokens</dt><dd>{worker.tokens.toLocaleString('pt-BR')}</dd></div>}
      {worker.costUsd != null && <div><dt>Custo</dt><dd>${worker.costUsd.toFixed(4)}</dd></div>}
      <div className="wide"><dt>Worktree</dt><dd><code title={worker.worktree}>{worker.worktree}</code></dd></div>
    </dl>
    {worker.error && <div className="worker-error"><AlertCircle size={13} /> {worker.error}</div>}
    {actions && <div className="detail-actions">{actions}</div>}
    <div className="segmented" role="tablist" aria-label="Seções do worker">
      {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.count ? <small>{item.count}</small> : null}</button>)}
    </div>
    <div className="detail-panel" role="tabpanel">
      {tab === 'execution' ? <TranscriptView worker={worker} />
        : !result ? <p className="detail-empty">Carregando…</p>
        : tab === 'result' ? (result.result ? <div className="detail-result">{result.result}</div> : <p className="detail-empty">Resultado ainda não disponível.</p>)
        : tab === 'diff' ? <DiffView diff={result.diff} />
        : <OutcomeView outcome={result.outcome} />}
    </div>
  </aside>;
}
