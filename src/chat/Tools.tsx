import { memo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, Check, ChevronDown, ChevronRight, CircleSlash, Copy, ExternalLink, FileDiff, FileSearch, FileText, Globe, ListChecks, LoaderCircle, MessageCircleQuestion, Pencil, Plug, ScrollText, ShieldQuestion, Terminal, TerminalSquare, Wrench, X } from 'lucide-react';
import { formatDuration } from '../status';
import { copyText, notice, openFile } from './actions';
import { mergeChanges } from './diff';
import { ChangeStats, DiffViewer, shortPath } from './DiffViewer';
import { Markdown } from './Markdown';
import type { FileChange, ToolItem, ToolKind, ToolStatus } from './model';
import { setExpanded, useChatPrefs } from './prefs';

export type ChatScope = { sessionId: string; cwd?: string; openTerminal: () => void };

const STATUS: Record<ToolStatus, { label: string; icon: React.ReactNode }> = {
  running: { label: 'Em execução', icon: <LoaderCircle size={13} className="spin" /> },
  done: { label: 'Concluído', icon: <Check size={13} /> },
  failed: { label: 'Falhou', icon: <X size={13} /> },
  cancelled: { label: 'Cancelado', icon: <CircleSlash size={13} /> },
  approval: { label: 'Aguardando aprovação', icon: <ShieldQuestion size={13} /> },
};

const ICONS: Record<ToolKind, React.ReactNode> = {
  command: <Terminal size={13} />, read: <FileText size={13} />, edit: <Pencil size={13} />, search: <FileSearch size={13} />, web: <Globe size={13} />,
  mcp: <Plug size={13} />, question: <MessageCircleQuestion size={13} />, plan: <ListChecks size={13} />, agent: <Bot size={13} />, other: <Wrench size={13} />,
};

/** Present tense while it runs, past tense once it finished; nothing the agent did not report. */
const VERBS: Record<ToolKind, [string, string]> = {
  command: ['Executando', 'Executou'], read: ['Lendo', 'Leu'], edit: ['Alterando', 'Alterou'], search: ['Buscando', 'Buscou'], web: ['Consultando', 'Consultou'],
  mcp: ['Chamando', 'Chamou'], question: ['Perguntando', 'Perguntou'], plan: ['Apresentando o plano', 'Apresentou o plano'], agent: ['Subagente trabalhando', 'Subagente'], other: ['Usando', 'Usou'],
};

export function toolLabel(tool: ToolItem, cwd?: string): { verb: string; target: string } {
  const [present, past] = VERBS[tool.kind];
  const verb = tool.status === 'running' || tool.status === 'approval' ? present
    : tool.status === 'failed' ? `Falhou ao ${({ command: 'executar', read: 'ler', edit: 'alterar', search: 'buscar', web: 'consultar', mcp: 'chamar', question: 'perguntar', plan: 'planejar', agent: 'delegar', other: 'usar' })[tool.kind]}`
    : tool.status === 'cancelled' ? 'Cancelado:' : past;
  const files = tool.changes && tool.changes.length > 1 ? `${tool.changes.length} arquivos` : null;
  const target = files ?? (tool.kind === 'command' ? tool.description || tool.command?.split('\n')[0] || ''
    : tool.kind === 'agent' ? tool.description || tool.target
    : tool.filePath ? shortPath(tool.filePath, cwd) : tool.target || tool.name);
  return { verb, target };
}

function Output({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  const [all, setAll] = useState(false);
  const lines = value.replace(/\n$/, '').split('\n');
  const long = lines.length > 14 || value.length > 2_400;
  const shown = long && !all ? lines.slice(0, 14).join('\n').slice(0, 2_400) : value;
  return <div className={`chat-output ${tone ?? ''}`}>
    <div><span>{label}</span><button type="button" onClick={() => void copyText(value, 'Saída copiada.')}><Copy size={12} /> Copiar</button></div>
    <pre>{shown}</pre>
    {long && <button type="button" className="chat-link-button" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Recolher saída' : `Mostrar tudo (${lines.length} linhas)`}</button>}
  </div>;
}

/** The untouched record from the conversation file, with nothing clipped. */
export function RawRecord({ sessionId, offset }: { sessionId: string; offset: number }) {
  const [raw, setRaw] = useState<string | null>(null);
  if (raw === null) return <button type="button" className="chat-link-button" onClick={() => {
    void invoke<string>('chat_raw', { sessionId, offset }).then(setRaw).catch((error) => notice(String(error)));
  }}><ScrollText size={12} /> Ver registro original</button>;
  return <><Output label="Registro original" value={raw} /><button type="button" className="chat-link-button" onClick={() => setRaw(null)}>Ocultar registro</button></>;
}

function CommandResult({ tool, scope }: { tool: ToolItem; scope: ChatScope }) {
  return <div className="chat-command">
    <div className="chat-command-line">
      <pre><span aria-hidden="true">$ </span>{tool.command}</pre>
      <button type="button" title="Copiar comando" aria-label="Copiar comando" onClick={() => void copyText(tool.command ?? '', 'Comando copiado.')}><Copy size={13} /></button>
      <button type="button" title="Abrir o terminal desta sessão" aria-label="Abrir o terminal desta sessão" onClick={scope.openTerminal}><TerminalSquare size={13} /></button>
    </div>
    <dl>
      {(tool.cwd || scope.cwd) && <><dt>Diretório</dt><dd>{tool.cwd || scope.cwd}</dd></>}
      {typeof tool.exitCode === 'number' && <><dt>Código de saída</dt><dd>{tool.exitCode}</dd></>}
      {tool.durationMs !== undefined && <><dt>Duração</dt><dd>{formatMs(tool.durationMs)}</dd></>}
    </dl>
    {tool.output ? <Output label={tool.stderr ? 'stdout' : 'Saída'} value={tool.output} tone={tool.status === 'failed' ? 'error' : undefined} /> : null}
    {tool.stderr ? <Output label="stderr" value={tool.stderr} tone="error" /> : null}
    {!tool.output && !tool.stderr && tool.status !== 'running' && <p className="chat-muted">Sem saída registrada.</p>}
  </div>;
}

export const formatMs = (value: number) => (value < 1000 ? `${Math.round(value)} ms` : value < 60_000 ? `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : formatDuration(value / 1000));

function Details({ tool, scope }: { tool: ToolItem; scope: ChatScope }) {
  const [diff, setDiff] = useState<string | null>(null);
  return <div className="chat-step-details">
    {tool.kind === 'command' ? <CommandResult tool={tool} scope={scope} /> : <>
      {tool.plan && <Markdown text={tool.plan} sessionId={scope.sessionId} />}
      {tool.answers && <dl>{Object.entries(tool.answers).map(([question, answer]) => <div key={question}><dt>{question}</dt><dd>{answer}</dd></div>)}</dl>}
      {tool.filePath && <button type="button" className="chat-file-ref" title={tool.filePath} onClick={() => void openFile(scope.sessionId, tool.filePath!, tool.line)}>
        <FileText size={13} /> <span>{shortPath(tool.filePath, scope.cwd)}{tool.line ? `:${tool.line}` : ''}</span><ExternalLink size={12} />
      </button>}
      {tool.changes && <FileList changes={tool.changes} cwd={scope.cwd} onOpen={setDiff} />}
      {!tool.changes && tool.output ? <Output label="Resultado" value={tool.output} tone={tool.status === 'failed' ? 'error' : undefined} /> : null}
      {tool.stderr ? <Output label="Erros" value={tool.stderr} tone="error" /> : null}
      {!tool.output && !tool.changes && tool.input != null && !tool.filePath && !tool.plan && !tool.answers
        ? <Output label="Entrada" value={typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)} /> : null}
    </>}
    {tool.offset !== null && <RawRecord sessionId={scope.sessionId} offset={tool.offset} />}
    {diff && tool.changes && <DiffViewer changes={tool.changes} initial={diff} cwd={scope.cwd} sessionId={scope.sessionId} onClose={() => setDiff(null)} />}
  </div>;
}

function FileList({ changes, cwd, onOpen }: { changes: FileChange[]; cwd?: string; onOpen: (path: string) => void }) {
  return <ul className="chat-files">{changes.map((change) => <li key={change.path}>
    <button type="button" title={change.path} onClick={() => onOpen(change.path)}><FileDiff size={13} /><span>{shortPath(change.path, cwd)}</span><ChangeStats added={change.added} removed={change.removed} /></button>
  </li>)}</ul>;
}

export const ToolStep = memo(function ToolStep({ tool, scope, forceOpen }: { tool: ToolItem; scope: ChatScope; forceOpen?: boolean }) {
  const key = `${scope.sessionId}:${tool.id}`;
  const stored = useChatPrefs((state) => state.expanded[key]);
  const open = forceOpen || (stored ?? false);
  const { verb, target } = toolLabel(tool, scope.cwd);
  const stats = tool.changes?.reduce((total, change) => ({ added: total.added + change.added, removed: total.removed + change.removed }), { added: 0, removed: 0 });
  return <div className={`chat-step status-${tool.status}`} data-item={tool.id}>
    <button type="button" className="chat-step-head" aria-expanded={open} onClick={() => setExpanded(key, !open)}>
      <span className="chat-step-status" title={STATUS[tool.status].label} aria-label={STATUS[tool.status].label}>{STATUS[tool.status].icon}</span>
      <span className="chat-step-icon">{ICONS[tool.kind]}</span>
      <span className="chat-step-verb">{verb}</span>
      <span className="chat-step-target" title={tool.target}>{target}</span>
      {stats && <ChangeStats {...stats} />}
      {tool.durationMs !== undefined && tool.durationMs >= 1000 && <span className="chat-step-time">{formatMs(tool.durationMs)}</span>}
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
    {open && <Details tool={tool} scope={scope} />}
  </div>;
});

/** Consecutive actions between two messages: finished ones fold away, the current one stays in sight. */
export const ToolGroup = memo(function ToolGroup({ tools, scope, matchId }: { tools: ToolItem[]; scope: ChatScope; matchId?: string }) {
  const key = `${scope.sessionId}:group:${tools[0].id}`;
  const stored = useChatPrefs((state) => state.expanded[key]);
  const current = tools.filter((tool) => tool.status === 'running' || tool.status === 'approval');
  const folded = tools.filter((tool) => tool.status !== 'running' && tool.status !== 'approval');
  const matched = Boolean(matchId && tools.some((tool) => tool.id === matchId));
  const open = matched || (stored ?? false);
  if (tools.length === 1) return <div className="chat-steps single"><ToolStep tool={tools[0]} scope={scope} forceOpen={matched} /></div>;
  const failed = folded.filter((tool) => tool.status === 'failed').length;
  const first = tools[0].at;
  const last = folded.reduce((latest, tool) => Math.max(latest, (tool.at ?? 0) + (tool.durationMs ?? 0)), 0);
  const elapsed = first && last > first ? last - first : undefined;
  return <div className="chat-steps">
    {folded.length > 0 && <button type="button" className="chat-steps-head" aria-expanded={open} onClick={() => setExpanded(key, !open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span className={failed ? 'has-failure' : undefined}>{failed ? <X size={13} /> : <Check size={13} />}</span>
      <strong>{folded.length} {folded.length === 1 ? 'etapa executada' : 'etapas executadas'}</strong>
      {failed > 0 && <em>{failed} com falha</em>}
      {elapsed !== undefined && <small>{formatMs(elapsed)}</small>}
    </button>}
    {open && <div className="chat-steps-body">{folded.map((tool) => <ToolStep key={tool.id} tool={tool} scope={scope} forceOpen={matchId === tool.id} />)}</div>}
    {current.map((tool) => <ToolStep key={tool.id} tool={tool} scope={scope} forceOpen={matchId === tool.id} />)}
  </div>;
});

/** What a turn changed, shown after its last action. */
export const ChangeSummary = memo(function ChangeSummary({ changes, scope }: { changes: FileChange[]; scope: ChatScope }) {
  const files = mergeChanges(changes);
  const [open, setOpen] = useState<string | null>(null);
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  return <section className="chat-changes" aria-label="Arquivos modificados">
    <header><FileDiff size={14} /><strong>{files.length} {files.length === 1 ? 'arquivo modificado' : 'arquivos modificados'}</strong><ChangeStats {...totals} />
      <button type="button" className="chat-link-button" onClick={() => setOpen(files[0].path)}>Ver alterações</button></header>
    <FileList changes={files} cwd={scope.cwd} onOpen={setOpen} />
    {open && <DiffViewer changes={files} initial={open} cwd={scope.cwd} sessionId={scope.sessionId} onClose={() => setOpen(null)} />}
  </section>;
});
