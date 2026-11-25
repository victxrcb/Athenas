import { useMemo } from 'react';
import { MessagesSquare, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useAppStore, type SessionInfo } from '../store';
import { setViewMode } from './prefs';
import { composeItems, sessionChat, useChatStore } from './store';
import { useChatSync } from './sync';

export function openConversation(session: SessionInfo) {
  setViewMode(session.id, 'chat');
  const state = useAppStore.getState();
  state.setSection('home');
  state.setActiveProjectId(null);
  state.setActiveSessionId(session.id);
}

/** A one-paragraph preview: Markdown marks and code blocks would only add noise in the side panel. */
export const snippet = (value: string) => value
  .replace(/```[\s\S]*?(```|$)/g, ' ')
  .replace(/^\s*(#{1,6}|>|[-*+] (\[[ x]\] )?|\|.*\|\s*$)\s*/gm, ' ')
  .replace(/\*\*|__|`|~~/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 220);

/** Latest message, pending request and last failure of the agent selected on the map, from the shared chat state. */
export function MappingConversation({ session }: { session: SessionInfo }) {
  useChatSync(session);
  const chat = useChatStore((state) => sessionChat(state, session.id));
  const requests = useChatStore((state) => state.permissions);
  const pending = requests.filter((request) => request.sessionId === session.id);
  const items = useMemo(() => composeItems(chat), [chat.transcript, chat.messages, chat.tools, chat.outbox]);
  const latest = [...items].reverse().find((item) => item.type === 'assistant' || item.type === 'user');
  // Only failures after the last request of the user are still relevant.
  const turn = items.slice(items.map((item) => item.type).lastIndexOf('user') + 1);
  const failure = [...turn].reverse().find((item) => (item.type === 'tool' && item.status === 'failed') || (item.type === 'notice' && item.tone === 'error'));
  return <section><h3>Conversa</h3>
    {pending.length > 0 && <p className="mapping-conversation-alert"><ShieldAlert size={13} /> {pending.length === 1 ? 'Solicitação pendente' : `${pending.length} solicitações pendentes`}: {pending[0].toolName === 'AskUserQuestion' ? 'pergunta do agente' : pending[0].toolName}</p>}
    {failure && <p className="mapping-conversation-error"><TriangleAlert size={13} /> {failure.type === 'tool' ? `Falha: ${snippet(failure.description || failure.target || failure.name)}` : failure.type === 'notice' ? snippet(failure.text) : ''}</p>}
    {latest && (latest.type === 'assistant' || latest.type === 'user')
      ? <p className="mapping-conversation-latest"><strong>{latest.type === 'user' ? 'Você' : session.agent}:</strong> {snippet(latest.text)}</p>
      : <p>Nenhuma mensagem disponível.</p>}
    <button className="mapping-action" onClick={() => openConversation(session)}><MessagesSquare size={14} /> Abrir conversa</button>
  </section>;
}
