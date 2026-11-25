import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowUp, ChevronDown, FileText, Layers, Plus, Square, X } from 'lucide-react';
import { AgentIcon } from '../AgentIcon';
import { ContextMenu } from '../ContextMenu';
import type { SessionInfo } from '../store';
import { notice } from './actions';
import { addAttachments, attachImage, clearAttachments, messageWithAttachments, removeAttachment, useSessionAttachments } from './attachments';
import { needsTerminal, slashCommands } from './commands';
import { ContextPopover, type ContextInfo } from './Context';
import { pushHistory, setDraft, useChatPrefs } from './prefs';
import { interrupt, sendMessage } from './send';
import type { SessionChat } from './store';

type Suggestion = { value: string; detail?: string };
const NO_HISTORY: string[] = [];

export async function chooseFiles(sessionId: string) {
  if (!isTauri()) return notice('O seletor de arquivos funciona no aplicativo desktop.');
  try {
    const chosen = await open({ multiple: true, title: 'Anexar arquivos' });
    const paths = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    addAttachments(sessionId, paths.map((path) => ({ path })));
  } catch (error) { notice(String(error)); }
}

/** Files dropped on the composer arrive as native paths from the window. */
function useFileDrop(sessionId: string, target: React.RefObject<HTMLElement | null>) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const inside = (position: { x: number; y: number }) => {
      const box = target.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return Boolean(box && position.x / scale >= box.left && position.x / scale <= box.right && position.y / scale >= box.top && position.y / scale <= box.bottom);
    };
    const listener = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'leave') return setOver(false);
      const here = inside(payload.position);
      setOver(payload.type !== 'drop' && here);
      if (payload.type === 'drop' && here) addAttachments(sessionId, payload.paths.map((path) => ({ path })));
    });
    return () => { void listener.then((off) => off()).catch(() => undefined); };
  }, [sessionId, target]);
  return over;
}

export function Composer({ session, chat, info, working, blocked, onTerminal }: {
  session: SessionInfo; chat: SessionChat; info: ContextInfo | null; working: boolean;
  /** Why sending is not possible right now. */
  blocked: string | null; onTerminal: () => void;
}) {
  const value = useChatPrefs((state) => state.drafts[session.id] ?? '');
  const history = useChatPrefs((state) => state.history[session.id] ?? NO_HISTORY);
  const files = useSessionAttachments(session.id);
  const surface = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  const [recall, setRecall] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [context, setContext] = useState(false);
  const [menu, setMenu] = useState<{ kind: 'model' | 'effort'; x: number; y: number } | null>(null);
  const dragging = useFileDrop(session.id, surface);
  const model = chat.model ?? chat.transcript.meta.model;
  const effort = chat.effort ?? chat.transcript.meta.effort;
  const mode = chat.permissionMode ?? chat.transcript.meta.permissionMode;
  const closeContext = useCallback(() => setContext(false), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const slash = /^\/([\w:-]*)$/.exec(value);
  const mention = /(?:^|\s)@([^\s@"]*)$/.exec(value.slice(0, caret));
  const suggestions: Suggestion[] = dismissed === value ? []
    : slash ? slashCommands(session.agent, info?.commands).filter((item) => item.name.startsWith(slash[1])).map((item) => ({ value: `/${item.name}`, detail: item.terminal ? `${item.detail} · abre no terminal` : item.detail }))
    : mention ? mentions.map((path) => ({ value: path })) : [];

  useEffect(() => {
    const query = mention?.[1];
    if (query === undefined || !isTauri()) { setMentions([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void invoke<string[]>('chat_files', { sessionId: session.id, query }).then((found) => { if (active) setMentions(found); }).catch(() => undefined);
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [session.id, mention?.[1]]);
  useEffect(() => setSelected(0), [value]);
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
  }, [value]);

  const change = (next: string, position = next.length) => { setDraft(session.id, next); setCaret(position); };
  const accept = (suggestion: Suggestion) => {
    if (slash) change(`${suggestion.value} `);
    else {
      const start = caret - (mention?.[1].length ?? 0) - 1;
      const inserted = /\s/.test(suggestion.value) || session.agent !== 'Claude Code' ? `"${suggestion.value}" ` : `@${suggestion.value} `;
      const next = value.slice(0, start) + inserted + value.slice(caret);
      change(next, start + inserted.length);
      window.setTimeout(() => input.current?.setSelectionRange(start + inserted.length, start + inserted.length));
    }
    input.current?.focus();
  };
  const ready = Boolean(value.trim() || files.length) && !blocked && !sending;
  const submit = async () => {
    if (!ready) return;
    const body = messageWithAttachments(value, files, session.agent, session.folder);
    setSending(true);
    const sent = await sendMessage(session, body);
    setSending(false);
    if (!sent) return;
    if (value.trim()) pushHistory(session.id, value.trim());
    setRecall(null);
    change('');
    clearAttachments(session.id);
    if (needsTerminal(session.agent, body)) onTerminal();
    input.current?.focus();
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); return setSelected((selected + 1) % suggestions.length); }
      if (event.key === 'ArrowUp') { event.preventDefault(); return setSelected((selected + suggestions.length - 1) % suggestions.length); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return setDismissed(value); }
      // A command typed in full is sent by Enter instead of being completed again.
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !(slash && suggestions.some((item) => item.value === value)))) { event.preventDefault(); return accept(suggestions[Math.min(selected, suggestions.length - 1)]); }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) { event.preventDefault(); return void submit(); }
    if (event.key === 'ArrowUp' && history.length && (value === '' || (recall !== null && input.current?.selectionStart === 0))) {
      event.preventDefault();
      const next = recall === null ? history.length - 1 : Math.max(0, recall - 1);
      setRecall(next); change(history[next]); return;
    }
    if (event.key === 'ArrowDown' && recall !== null && input.current?.selectionStart === value.length) {
      event.preventDefault();
      const next = recall + 1;
      setRecall(next < history.length ? next : null); change(history[next] ?? '');
    }
  };
  const paste = (event: React.ClipboardEvent) => {
    const images = [...event.clipboardData.items].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    images.forEach((image) => void attachImage(session.id, image));
  };
  const openInTerminal = async (command: string) => { if (await sendMessage(session, command)) onTerminal(); };
  const showStop = working && !value.trim() && !files.length;
  const menuButton = (kind: 'model' | 'effort') => (event: React.MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ kind, x: box.left, y: box.top - 90 });
  };

  return <div className="chat-composer-wrap">
    <div className={`chat-composer ${dragging ? 'dragging' : ''} ${blocked ? 'blocked' : ''}`} ref={surface}>
      {suggestions.length > 0 && <ul className="chat-suggestions" role="listbox" aria-label={slash ? 'Comandos' : 'Arquivos'}>
        {suggestions.map((item, index) => <li key={item.value} role="option" aria-selected={index === selected}>
          <button type="button" tabIndex={-1} onMouseDown={(event) => { event.preventDefault(); accept(item); }} onMouseEnter={() => setSelected(index)}>
            {!slash && <FileText size={12} />}<span>{item.value}</span>{item.detail && <small>{item.detail}</small>}
          </button>
        </li>)}
      </ul>}
      {files.length > 0 && <ul className="chat-attachments" aria-label="Anexos">
        {files.map((file) => {
          const name = file.path.split(/[\\/]/).pop() ?? file.path;
          return <li key={file.path} title={file.path}>{file.preview ? <img src={file.preview} alt="" /> : <FileText size={14} />}<span>{file.preview ? 'Imagem' : name}</span>
            <button type="button" aria-label={`Remover ${name}`} onClick={() => removeAttachment(session.id, file.path)}><X size={12} /></button></li>;
        })}
      </ul>}
      <textarea ref={input} rows={1} value={value} aria-label={`Mensagem para ${session.agent}`} placeholder={blocked ?? (working ? `${session.agent} está trabalhando. A próxima mensagem entra na fila…` : `Mensagem para ${session.agent}…`)}
        onChange={(event) => { setRecall(null); setDismissed(null); change(event.target.value, event.target.selectionStart); }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)} onKeyDown={keyDown} onPaste={paste} />
      <div className="chat-composer-bar">
        <button type="button" title="Anexar arquivos" aria-label="Anexar arquivos" onClick={() => void chooseFiles(session.id)}><Plus size={16} /></button>
        <button type="button" data-context-toggle aria-expanded={context} onClick={() => setContext(!context)}><Layers size={13} /> <span>Contexto</span></button>
        <span className="chat-chip agent" title="O agente de uma sessão não muda; abra outra sessão para usar outro."><AgentIcon agent={session.agent} size={13} /> <span>{session.agent}</span></span>
        <button type="button" className="chat-model" disabled={Boolean(blocked) || working} title={working ? 'Troque o modelo depois que o turno terminar' : 'Modelo'} aria-haspopup="menu" onClick={menuButton('model')}><span>{model ?? 'Modelo'}</span> <ChevronDown size={12} /></button>
        <button type="button" className="chat-effort" disabled={Boolean(blocked) || working} title="Nível de raciocínio" aria-haspopup="menu" onClick={menuButton('effort')}><span>{effort ? `Raciocínio: ${effort}` : 'Raciocínio'}</span> <ChevronDown size={12} /></button>
        {mode && <button type="button" className="chat-mode" title={session.agent === 'Claude Code' ? 'Modo de permissão. Alterne com Shift+Tab no terminal.' : 'Política de aprovação. Altere com /approvals no terminal.'} onClick={onTerminal}><span>{mode}</span></button>}
        <span className="chat-spacer" />
        {showStop
          ? <button type="button" className="chat-send stop" aria-label="Interromper" title="Interromper (Esc no agente)" onClick={() => void interrupt(session)}><Square size={13} fill="currentColor" /></button>
          : <button type="button" className="chat-send" aria-label="Enviar" title="Enviar (Enter)" disabled={!ready} onClick={() => void submit()}><ArrowUp size={16} /></button>}
        {working && !showStop && <button type="button" className="chat-send stop secondary" aria-label="Interromper" title="Interromper" onClick={() => void interrupt(session)}><Square size={11} fill="currentColor" /></button>}
      </div>
      {context && <ContextPopover session={session} chat={chat} info={info} placement="above" onAddFiles={() => void chooseFiles(session.id)} onClose={closeContext} />}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} autoFocus onClose={closeMenu} items={[
        { label: menu.kind === 'model' ? `Atual: ${model ?? 'não informado'}` : `Atual: ${effort ?? 'não informado'}`, disabled: true, onSelect: () => undefined },
        { type: 'separator' },
        { label: menu.kind === 'model' || session.agent === 'Codex' ? 'Trocar no terminal (/model)' : 'Trocar no terminal (/effort)', onSelect: () => void openInTerminal(menu.kind === 'model' || session.agent === 'Codex' ? '/model' : '/effort') },
      ]} />, document.body)}
    </div>
    <p className="chat-hint">Enter envia · Shift+Enter quebra a linha · / comandos · @ arquivos</p>
  </div>;
}
