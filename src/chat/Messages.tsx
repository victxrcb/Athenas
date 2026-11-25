import { memo, useRef } from 'react';
import { Copy, Download, FileCode2, GitPullRequest, Info, PenLine, TriangleAlert, ArrowUpRight, CircleAlert } from 'lucide-react';
import { AgentIcon } from '../AgentIcon';
import { copyText, exportMarkdown, openLink } from './actions';
import { Markdown } from './Markdown';
import type { MessageItem, NoticeItem, PullRequestItem } from './model';
import { RawRecord, type ChatScope } from './Tools';

export const clock = (at: number | null) => (at ? new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

export const UserMessage = memo(function UserMessage({ item, scope, busy, onReuse }: { item: MessageItem; scope: ChatScope; busy: boolean; onReuse: (text: string) => void }) {
  return <article className={`chat-user ${item.pending ? 'pending' : ''}`} aria-label="Sua mensagem">
    <div className="chat-bubble">
      {item.images?.map((source, index) => <img key={index} src={source} alt={`Imagem anexada ${index + 1}`} />)}
      {item.text.includes('```') ? <Markdown text={item.text} sessionId={scope.sessionId} /> : item.text && <p>{item.text}</p>}
    </div>
    <footer>
      {item.pending ? <span>{busy ? 'Na fila do agente' : 'Enviando…'}</span> : <time>{clock(item.at)}</time>}
      <button type="button" title="Copiar mensagem" aria-label="Copiar mensagem" onClick={() => void copyText(item.text)}><Copy size={13} /></button>
      <button type="button" title="Editar e enviar como nova mensagem (o histórico não muda)" aria-label="Editar e reenviar" onClick={() => onReuse(item.text)}><PenLine size={13} /></button>
    </footer>
  </article>;
});

export const AssistantMessage = memo(function AssistantMessage({ item, agent, scope, lead }: { item: MessageItem; agent: string; scope: ChatScope; lead: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  return <article className={`chat-assistant ${item.streaming ? 'streaming' : ''} ${lead ? 'lead' : ''}`} aria-label={`Resposta de ${agent}`}>
    {lead && <header><span className="chat-avatar"><AgentIcon agent={agent} size={17} /></span><strong>{agent}</strong><time>{clock(item.at)}</time></header>}
    <div ref={body}><Markdown text={item.text} sessionId={scope.sessionId} /></div>
    {item.clipped && <p className="chat-muted">Mensagem longa recortada aqui; o registro original está completo.</p>}
    {!item.streaming && <footer className="chat-actions">
      <button type="button" title="Copiar resposta" aria-label="Copiar resposta" onClick={() => void copyText(body.current?.innerText || item.text, 'Resposta copiada.')}><Copy size={13} /></button>
      <button type="button" title="Copiar como Markdown" aria-label="Copiar Markdown" onClick={() => void copyText(item.text, 'Markdown copiado.')}><FileCode2 size={13} /></button>
      <button type="button" title="Exportar resposta" aria-label="Exportar resposta" onClick={() => void exportMarkdown(item.text, `resposta-${agent}`)}><Download size={13} /></button>
      {item.offset !== null && <RawRecord sessionId={scope.sessionId} offset={item.offset} />}
    </footer>}
  </article>;
});

export const Notice = memo(function Notice({ item, scope }: { item: NoticeItem; scope: ChatScope }) {
  const icon = item.tone === 'error' ? <CircleAlert size={14} /> : item.tone === 'warning' ? <TriangleAlert size={14} /> : <Info size={14} />;
  return <div className={`chat-notice tone-${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>
    <div>{icon}<span>{item.text}</span><time>{clock(item.at)}</time></div>
    {(item.detail || item.tone === 'error') && <details><summary>Detalhes técnicos</summary>
      {item.detail && <pre>{item.detail}</pre>}
      {item.offset !== null && <RawRecord sessionId={scope.sessionId} offset={item.offset} />}
    </details>}
  </div>;
});

export const PullRequest = memo(function PullRequest({ item, scope }: { item: PullRequestItem; scope: ChatScope }) {
  return <button type="button" className="chat-pr" onClick={() => void openLink(scope.sessionId, item.url)}>
    <GitPullRequest size={15} /><span><strong>Pull request #{item.number}</strong><small>{item.repository}</small></span><ArrowUpRight size={14} />
  </button>;
});
