import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, SendHorizontal, Square } from 'lucide-react';
import { AgentIcon } from '../AgentIcon';
import type { ChatItem, ToolItem } from '../chat/model';
import { StatusDot, type StatusTone } from '../status';
import { ApiError, api, type AgentCard, type Decision, type PermissionRequest } from './api';
import { useConversation } from './conversation';
import { RequestCard } from './Requests';
import { Text } from './Text';

const PAGE = 80;
const NEAR_BOTTOM = 120;
const MAX_OUTPUT = 4_000;
/** After this long without the message showing up, it probably needs a look at the computer. */
const UNCONFIRMED_MS = 25_000;

/** What was typed and not sent yet, kept while the user moves between agents. */
const drafts = new Map<string, { text: string; id: string }>();

type Pending = { id: string; text: string; seen: number; late: boolean };

const squeeze = (text: string) => text.replace(/\s+/g, '');
const occurrences = (items: ChatItem[], text: string) => items.filter((item) => item.type === 'user' && squeeze(item.text) === squeeze(text)).length;

/** Needs only to be unique among one device's recent messages. */
const messageId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const TOOL_STATUS: Record<string, string> = { running: 'em andamento', failed: 'falhou', cancelled: 'cancelada', approval: 'aguardando' };

function Tool({ tool }: { tool: ToolItem }) {
  const output = [tool.output, tool.stderr].filter(Boolean).join('\n');
  return <details className={`phone-tool status-${tool.status}`}>
    <summary><b>{tool.name}</b> <span>{tool.target}</span>{TOOL_STATUS[tool.status] && <em>{TOOL_STATUS[tool.status]}</em>}</summary>
    {tool.command && <pre>{tool.command}</pre>}
    {tool.changes?.map((change) => <pre key={change.path}>{change.hunks.flatMap((hunk) => hunk.lines).slice(0, 300).map((line, index) => <span key={index} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : undefined}>{line}{'\n'}</span>)}</pre>)}
    {output && !tool.changes?.length && <pre>{output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…[recortado]` : output}</pre>}
  </details>;
}

/** Consecutive actions fold into one line, so the answers stay easy to find. */
function group(items: ChatItem[]): (ChatItem | ToolItem[])[] {
  const out: (ChatItem | ToolItem[])[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.type !== 'tool') out.push(item);
    else if (Array.isArray(last)) last.push(item);
    else out.push([item]);
  }
  return out;
}

const History = memo(function History({ items }: { items: ChatItem[] }) {
  return <>{group(items).map((entry) => {
    if (Array.isArray(entry)) {
      if (entry.length === 1) return <Tool key={entry[0].id} tool={entry[0]} />;
      const running = entry.some((tool) => tool.status === 'running');
      return <details key={entry[0].id} className="phone-tools"><summary>{entry.length} ações{running ? ' · em andamento' : ''}</summary>{entry.map((tool) => <Tool key={tool.id} tool={tool} />)}</details>;
    }
    if (entry.type === 'user') return <article key={entry.id} className="phone-user" aria-label="Sua mensagem">
      {entry.images?.map((source, index) => <img key={index} src={source} alt={`Imagem anexada ${index + 1}`} />)}
      {entry.text && <p>{entry.text}</p>}
    </article>;
    if (entry.type === 'assistant') return <article key={entry.id} className="phone-answer" aria-label="Resposta do agente"><Text text={entry.text} /></article>;
    if (entry.type === 'notice') return <p key={entry.id} className={`phone-note tone-${entry.tone === 'info' ? 'idle' : entry.tone === 'warning' ? 'waiting' : 'error'}`}>{entry.text}</p>;
    if (entry.type === 'pr') return <p key={entry.id} className="phone-note"><a href={entry.url} target="_blank" rel="noopener noreferrer">Pull request #{entry.number}</a></p>;
    return null;
  })}</>;
});

export function ConversationView({ agent, ended, onBack, onUnauthorized }: { agent: AgentCard; ended: boolean; onBack: () => void; onUnauthorized: () => void }) {
  const chat = useConversation(agent.id, agent.agent, onUnauthorized);
  const [draft, setDraft] = useState(() => drafts.get(agent.id) ?? { text: '', id: messageId() });
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const blocked = agent.state === 'approval' || chat.requests.length > 0;
  const working = agent.state === 'working';
  const closed = ended || chat.refusal !== null;

  const write = (text: string) => {
    // A changed text is a new message; the same text retried keeps its identity.
    const next = { text, id: text === draft.text ? draft.id : messageId() };
    drafts.set(agent.id, next);
    setDraft(next);
  };

  useEffect(() => {
    setPending((list) => {
      const left = list.filter((item) => occurrences(chat.items, item.text) <= item.seen);
      return left.length === list.length ? list : left;
    });
  }, [chat.items]);

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [chat.items, chat.requests, pending, error]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.text.trim();
    if (!text || sending || blocked || closed) return;
    setSending(true);
    setError('');
    const seen = occurrences(chat.items, text);
    try {
      await api.send(agent.id, draft.id, text);
      const id = draft.id;
      setPending((list) => [...list, { id, text, seen, late: false }]);
      window.setTimeout(() => setPending((list) => list.map((item) => (item.id === id ? { ...item, late: true } : item))), UNCONFIRMED_MS);
      drafts.delete(agent.id);
      setDraft({ text: '', id: messageId() });
      following.current = true;
      chat.refresh();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setError(failure instanceof ApiError ? failure.message : 'Sem resposta do computador. Toque em enviar de novo; a mensagem não será repetida.');
    } finally { setSending(false); }
  };

  const decide = async (request: PermissionRequest, decision: Decision) => {
    setDeciding(request.id);
    setError('');
    try { await api.decide(agent.id, request.id, decision); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return onUnauthorized();
      setError(failure instanceof ApiError ? failure.message : 'Sem resposta do computador. Confira se o pedido ainda está aqui.');
      setDeciding(null);
    }
    // The card leaves when the computer stops listing the request.
    chat.refresh();
  };

  const interrupt = async () => {
    setStopping(true);
    setError('');
    try { await api.interrupt(agent.id); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return onUnauthorized();
      setError(failure instanceof ApiError ? failure.message : 'Sem resposta do computador.');
    } finally { setStopping(false); }
  };

  const visible = chat.items.slice(-limit);
  return <main className="phone-chat">
    <header className="phone-chat-header">
      <button type="button" aria-label="Voltar para os agentes" onClick={onBack}><ArrowLeft size={20} /></button>
      <AgentIcon agent={agent.agent} size={22} />
      <div><h1>{agent.title?.trim() || agent.agent}</h1><small>{[agent.agent, agent.project ?? agent.folder].filter(Boolean).join(' · ')}</small></div>
      <span className="phone-card-status"><span><StatusDot info={{ tone: (ended ? 'idle' : agent.tone) as StatusTone, label: agent.label, live: !ended && working }} />{ended ? 'Encerrado' : agent.label}</span></span>
    </header>
    <div className="phone-history" ref={scroller} onScroll={() => {
      const box = scroller.current;
      if (box) following.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    }}>
      {(chat.items.length > limit || chat.hasEarlier) && <button type="button" className="phone-earlier" onClick={() => { following.current = false; setLimit((value) => value + PAGE); if (chat.items.length <= limit) chat.loadEarlier(); }}>Mensagens anteriores</button>}
      {!chat.loaded && !chat.refusal && <p className="phone-empty">{chat.offline ? 'Sem conexão com o computador.' : 'Carregando a conversa…'}</p>}
      {chat.loaded && !chat.bound && <p className="phone-empty">{chat.ambiguous ? 'Há mais de uma conversa possível. Escolha qual é a desta sessão no chat do computador.' : 'Esta sessão ainda não registrou uma conversa.'}</p>}
      <History items={visible} />
      {pending.map((item) => <article key={item.id} className="phone-user pending" aria-label="Sua mensagem"><p>{item.text}</p><small>{item.late && !working ? 'Ainda não apareceu na conversa. Confira no computador.' : working ? 'Na fila do agente' : 'Enviada'}</small></article>)}
      {!closed && chat.requests.map((request) => <RequestCard key={request.id} request={request} busy={deciding === request.id} onDecide={(decision) => void decide(request, decision)} />)}
      {!closed && chat.loaded && agent.state === 'approval' && chat.requests.length === 0 && <section className="phone-request" role="status">
        <h3>Aguardando sua resposta</h3>
        {agent.message && <p>{agent.message}</p>}
        <p className="phone-muted">Este pedido só pode ser respondido no computador.</p>
      </section>}
    </div>
    <footer className="phone-composer">
      {chat.offline && chat.loaded && <p className="phone-banner" role="alert">Sem conexão com o computador. Tentando de novo…</p>}
      {error && <p className="phone-banner" role="alert">{error}</p>}
      {closed ? <p className="phone-banner" role="alert">{chat.refusal ?? 'Este agente não está mais em execução.'}</p> : <form onSubmit={send}>
        <textarea aria-label="Mensagem para o agente" rows={2} value={draft.text} placeholder={blocked ? 'Responda o pedido antes de enviar' : 'Mensagem para o agente'} onChange={(event) => write(event.target.value)} />
        <div>
          {(working || agent.state === 'approval') && <button type="button" aria-label="Interromper o agente" disabled={stopping} onClick={() => void interrupt()}><Square size={18} /></button>}
          <button type="submit" className="primary" aria-label="Enviar" disabled={sending || blocked || !draft.text.trim()}><SendHorizontal size={18} /></button>
        </div>
      </form>}
    </footer>
  </main>;
}
