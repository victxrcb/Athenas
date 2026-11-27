/** Delivering a message to the running agent through its own terminal. */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { applyAttention, useActivityStore } from '../activity';
import { confirmAction } from '../confirm';
import type { SessionInfo } from '../store';
import { notice } from './actions';
import { addOutbox, markReady, useChatStore } from './store';

/** Returns true once the message was typed into the agent. */
export async function sendMessage(session: SessionInfo, body: string): Promise<boolean> {
  if (!isTauri()) { notice('Abra o aplicativo desktop para conversar com um agente.'); return false; }
  const chat = useChatStore.getState().sessions[session.id];
  const deliver = (force: boolean) => invoke('chat_send', { sessionId: session.id, text: body, force });
  try {
    try { await deliver(chat?.ready ?? false); } catch (error) {
      if (String(error) !== 'NOT_READY') throw error;
      const ok = await confirmAction(
        `Ainda não há conversa registrada por esta sessão. Se o terminal estiver mostrando um aviso (como a confirmação de confiança na pasta), a mensagem responderia a ele. Confira o terminal antes de continuar.`,
        { title: `O ${session.agent} está pronto?`, confirm: 'Já conferi, enviar' },
      );
      if (!ok) return false;
      await deliver(true);
      markReady(session.id);
    }
  } catch (error) { notice(String(error)); return false; }
  markSent(session, body);
  return true;
}

/** What the interface does once a message reached the agent, typed here or on a paired phone. */
export function markSent(session: SessionInfo, body: string) {
  const command = body.trimStart().startsWith('/');
  if (!command) {
    addOutbox(session.id, body);
    const store = useActivityStore.getState();
    store.set(session.id, applyAttention(store.activity[session.id], 'working', '', true));
    // Codex has no prompt hook, so the session is named here.
    if (session.agent === 'Codex' && !session.title) void invoke('terminal_auto_title', { id: session.id, prompt: body }).catch(() => undefined);
  }
}

export function markInterrupted(id: string) {
  useActivityStore.getState().set(id, { state: 'idle', since: Date.now(), unread: false, message: '' });
}

/** Esc is how both agents interrupt a turn. */
export async function interrupt(session: SessionInfo) {
  try {
    await invoke('terminal_write', { id: session.id, data: '\x1b' });
    markInterrupted(session.id);
  } catch (error) { notice(String(error)); }
}
