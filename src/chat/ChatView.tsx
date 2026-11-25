import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ChevronDown, ChevronUp, MessagesSquare, Play, Search, TerminalSquare, X } from 'lucide-react';
import { useActivityStore } from '../activity';
import { AgentIcon } from '../AgentIcon';
import { displayPath } from '../path';
import type { SessionInfo } from '../store';
import './chat.css';
import { exportMarkdown, notice } from './actions';
import { buildBlocks, findMatches, stableBlocks, type Block } from './blocks';
import { ChatHeader, Elapsed } from './ChatHeader';
import { Composer } from './Composer';
import { useContextInfo } from './Context';
import { mergeChanges } from './diff';
import { DiffViewer } from './DiffViewer';
import { MessageList } from './MessageList';
import type { ChatItem, ToolItem } from './model';
import { setDraft, setViewMode, useChatPrefs } from './prefs';
import { RequestCard, TerminalAttention } from './Requests';
import { composeItems, loadEarlier, readSession, sessionChat, useChatStore, type PermissionRequest } from './store';
import { useChatSync } from './sync';
import { toolLabel, type ChatScope } from './Tools';

const STARTUP_PATIENCE = 6_000;

/** The command or file that identifies what a request is about. */
const subject = (input: any) => input?.command ?? input?.file_path ?? input?.url ?? input?.questions?.[0]?.question ?? JSON.stringify(input ?? null);

/** Statuses the file cannot know: waiting for approval, or left unfinished by a process that ended. */
export function effectiveItems(items: ChatItem[], running: boolean, requests: PermissionRequest[]): ChatItem[] {
  let changed = false;
  const next = items.map((item) => {
    // Nothing keeps arriving once the process ended.
    if (!running && item.type === 'assistant' && item.streaming) { changed = true; return { ...item, streaming: false }; }
    if (item.type !== 'tool' || item.status !== 'running') return item;
    const waiting = requests.some((request) => request.toolName === item.name && subject(request.toolInput) === subject(item.input));
    if (running && !waiting) return item;
    changed = true;
    return { ...item, status: running ? 'approval' : 'cancelled' } satisfies ToolItem;
  });
  return changed ? next : items;
}

export function conversationMarkdown(items: ChatItem[], agent: string): string {
  return items.map((item) => {
    if (item.type === 'user') return `## Você\n\n${item.text}`;
    if (item.type === 'assistant') return `## ${agent}\n\n${item.text}`;
    if (item.type === 'tool') return `- ${item.name}: ${item.command ?? item.target}`;
    if (item.type === 'notice') return `> ${item.text}`;
    return item.type === 'pr' ? `> Pull request #${item.number}: ${item.url}` : '';
  }).join('\n\n');
}

export function ChatView({ session, onResume, split = true, showHeader = true }: { session: SessionInfo; onResume?: () => void; split?: boolean; showHeader?: boolean }) {
  useChatSync(session);
  const chat = useChatStore((state) => sessionChat(state, session.id));
  const allRequests = useChatStore((state) => state.permissions);
  const requests = useMemo(() => allRequests.filter((request) => request.sessionId === session.id), [allRequests, session.id]);
  const activity = useActivityStore((state) => state.activity[session.id]);
  const width = useChatPrefs((state) => state.width);
  const running = session.status === 'rodando';
  const working = running && activity?.state === 'working';
  const info = useContextInfo(session.id, `${chat.source}:${chat.stoppedAt ?? ''}:${chat.transcript.meta.branch ?? ''}`);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [match, setMatch] = useState(0);
  const [diff, setDiff] = useState(false);

  const items = useMemo(() => effectiveItems(composeItems(chat), running, requests), [chat.transcript, chat.messages, chat.tools, chat.outbox, running, requests]);
  const previous = useRef<Block[]>([]);
  const blocks = useMemo(() => (previous.current = stableBlocks(previous.current, buildBlocks(items))), [items]);
  const changes = useMemo(() => mergeChanges(items.flatMap((item) => (item.type === 'tool' ? item.changes ?? [] : []))), [items]);
  const matches = useMemo(() => (searching ? findMatches(items, query) : []), [items, query, searching]);
  // The newest result first: searches usually look for something said recently.
  const matchId = matches.length ? matches[matches.length - 1 - (match % matches.length)] : undefined;

  const openTerminal = useCallback(() => setViewMode(session.id, split ? 'split' : 'terminal'), [session.id, split]);
  const cwd = chat.transcript.meta.cwd ?? displayPath(session.folder);
  const scope = useMemo<ChatScope>(() => ({ sessionId: session.id, cwd, openTerminal }), [session.id, cwd, openTerminal]);
  const reuse = useCallback((text: string) => {
    setDraft(session.id, text);
    document.querySelector<HTMLTextAreaElement>(`[data-chat="${session.id}"] textarea[aria-label^="Mensagem"]`)?.focus();
  }, [session.id]);
  const loadOlder = useCallback(() => void loadEarlier(session), [session]);
  const closeSearch = () => { setSearching(false); setQuery(''); setMatch(0); };
  useEffect(() => { closeSearch(); setDiff(false); }, [session.id]);

  const runningTool = [...items].reverse().find((item): item is ToolItem => item.type === 'tool' && item.status === 'running');
  const streaming = chat.messages.length > 0;
  const doing = streaming ? 'Gerando resposta…' : runningTool ? `${toolLabel(runningTool, cwd).verb} ${toolLabel(runningTool, cwd).target}` : 'Trabalhando…';
  const attention = running && activity?.state === 'approval' && !requests.length;
  const blocked = requests.length ? 'Responda a solicitação acima para continuar.' : attention ? 'O agente está esperando uma resposta no terminal.' : null;

  const empty = !items.length && !requests.length;
  // Claude Code reports as soon as it is past its startup dialogs; silence usually means one is open.
  const [slow, setSlow] = useState(false);
  const silent = running && session.agent === 'Claude Code' && empty && !chat.ready;
  useEffect(() => {
    setSlow(false);
    if (!silent || !isTauri()) return;
    const timer = window.setTimeout(() => setSlow(true), STARTUP_PATIENCE);
    return () => window.clearTimeout(timer);
  }, [silent, session.id]);
  return <section className="chat" data-chat={session.id} data-width={width} aria-label={`Conversa com ${session.agent}`}
    onKeyDown={(event) => { if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearching(true); } }}>
    {showHeader && <ChatHeader session={session} chat={chat} info={info} changedFiles={changes.length} searching={searching} split={split}
      onSearch={() => (searching ? closeSearch() : setSearching(true))} onFiles={() => setDiff(true)} onResume={onResume}
      onExport={() => void exportMarkdown(conversationMarkdown(items, session.agent), session.title || session.agent)} />}
    {searching && <div className="chat-search" role="search">
      <Search size={14} />
      <input autoFocus aria-label="Buscar na conversa" placeholder="Buscar na conversa carregada" value={query} onChange={(event) => { setQuery(event.target.value); setMatch(0); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && matches.length) setMatch((match + (event.shiftKey ? matches.length - 1 : 1)) % matches.length);
          if (event.key === 'Escape') { event.stopPropagation(); closeSearch(); }
        }} />
      <span aria-live="polite">{query ? (matches.length ? `${(match % matches.length) + 1} de ${matches.length}` : 'Nenhum resultado') : ''}</span>
      <button type="button" className="icon-button small" aria-label="Resultado anterior" disabled={!matches.length} onClick={() => setMatch((match + 1) % matches.length)}><ChevronUp size={14} /></button>
      <button type="button" className="icon-button small" aria-label="Próximo resultado" disabled={!matches.length} onClick={() => setMatch((match + matches.length - 1) % matches.length)}><ChevronDown size={14} /></button>
      <button type="button" className="icon-button small" aria-label="Fechar busca" onClick={closeSearch}><X size={14} /></button>
    </div>}
    <MessageList key={`list:${session.id}`} blocks={blocks} agent={session.agent} scope={scope} busy={Boolean(working)} matchId={matchId} hasEarlier={chat.start > 0} onLoadEarlier={loadOlder} onReuse={reuse}>
      {chat.error && <div className="chat-notice tone-error" role="alert"><div><span>{chat.error}</span><button type="button" className="chat-link-button" onClick={() => void readSession(session)}>Tentar novamente</button></div></div>}
      {!chat.bound && chat.candidates.length > 0 && <section className="chat-request" aria-label="Escolher conversa">
        <header><MessagesSquare size={15} /><strong>Qual conversa é desta sessão?</strong></header>
        <p>Há mais de uma conversa do Codex possível nesta pasta. Escolha a correta; nenhuma é presumida.</p>
        <div className="chat-candidates">{chat.candidates.map((candidate) => <button key={candidate.id} type="button" onClick={() => void invoke('chat_bind', { sessionId: session.id, conversationId: candidate.id }).then(() => readSession(session)).catch((error) => notice(String(error)))}>
          <span>{candidate.preview || 'Sem mensagens'}</span><small>{candidate.startedAt ? new Date(candidate.startedAt).toLocaleString('pt-BR') : candidate.id}</small>
        </button>)}</div>
      </section>}
      {empty && !chat.error && !chat.candidates.length && <div className="chat-empty">
        <span><AgentIcon agent={session.agent} size={28} /></span>
        {!isTauri() ? <p>A conversa aparece no aplicativo desktop.</p>
          : running ? <><h3>Nova conversa com {session.agent}</h3><p>Envie a primeira mensagem. Se o terminal estiver pedindo alguma confirmação, responda lá primeiro.</p><button type="button" className="button-quiet button-sm" onClick={openTerminal}><TerminalSquare size={13} /> Ver o terminal</button></>
          : <><h3>Nenhuma conversa estruturada encontrada</h3><p>Esta sessão terminou sem um registro que possa ser lido.</p>{onResume && <button type="button" className="chat-primary" onClick={onResume}><Play size={13} /> Retomar</button>}</>}
      </div>}
      {slow && silent && !attention && <TerminalAttention message="O Claude Code ainda não confirmou que está pronto. Se for a primeira vez nesta pasta, confirme a confiança no terminal." scope={scope} />}
      {requests.map((request) => <RequestCard key={request.id} request={request} scope={scope} />)}
      {attention && <TerminalAttention message={activity.message} scope={scope} />}
      {working && !requests.length && <div className="chat-activity" role="status"><i aria-hidden="true" /><span title={doing}>{doing}</span><Elapsed sessionId={session.id} /></div>}
    </MessageList>
    {running
      ? <Composer key={`composer:${session.id}`} session={session} chat={chat} info={info} working={Boolean(working)} blocked={blocked} onTerminal={openTerminal} />
      : !empty && <div className="chat-ended" role="status"><p>Sessão encerrada. O histórico abaixo foi restaurado do disco; o agente não está em execução.</p>{onResume && <button type="button" className="chat-primary" onClick={onResume}><Play size={13} /> Retomar sessão</button>}</div>}
    {diff && changes.length > 0 && <DiffViewer changes={changes} cwd={cwd} sessionId={session.id} onClose={() => setDiff(false)} />}
  </section>;
}
