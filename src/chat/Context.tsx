import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { FileText, GitBranch, Folder, Paperclip, X } from 'lucide-react';
import { displayPath, sameFolder } from '../path';
import { useAppStore, type SessionInfo } from '../store';
import { openFile } from './actions';
import { removeAttachment, useSessionAttachments } from './attachments';
import type { SessionChat } from './store';

export type ContextInfo = { folder: string; branch: string | null; instructions: string[]; commands: string[] };

export function useContextInfo(sessionId: string, refresh: unknown): ContextInfo | null {
  const [info, setInfo] = useState<ContextInfo | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<ContextInfo>('chat_context', { sessionId }).then((value) => { if (active && value) setInfo(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [sessionId, refresh]);
  return info;
}

const number = (value: number) => value.toLocaleString('pt-BR');

export function ContextPopover({ session, chat, info, onAddFiles, onClose, placement }: {
  session: SessionInfo; chat: SessionChat; info: ContextInfo | null; onAddFiles: () => void; onClose: () => void; placement: 'above' | 'below';
}) {
  const root = useRef<HTMLDivElement>(null);
  const files = useSessionAttachments(session.id);
  const project = useAppStore((state) => state.workspace.projects.find((item) => sameFolder(item.folder, session.folder)));
  const meta = chat.transcript.meta;
  const usage = meta.usage;
  useEffect(() => {
    root.current?.focus();
    const outside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!root.current?.contains(target) && !target.closest?.('[data-context-toggle]')) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [onClose]);
  const model = chat.model ?? meta.model;
  const mode = chat.permissionMode ?? meta.permissionMode;
  return <div className={`chat-popover ${placement}`} role="dialog" aria-label="Contexto do agente" ref={root} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header><strong>Contexto</strong><button type="button" className="icon-button small" aria-label="Fechar contexto" onClick={onClose}><X size={14} /></button></header>
    <dl>
      <dt><Folder size={12} /> Diretório</dt><dd><code>{displayPath(info?.folder ?? session.folder)}</code></dd>
      <dt>Projeto</dt><dd>{project?.name ?? 'Sessão avulsa'}</dd>
      <dt><GitBranch size={12} /> Branch</dt><dd><code>{info?.branch ?? meta.branch ?? 'não é um repositório Git'}</code></dd>
      <dt>Modelo</dt><dd>{model ?? 'ainda não informado'}</dd>
      {mode && <><dt>Permissões</dt><dd><code>{mode}</code></dd></>}
    </dl>
    <h4>Instruções do projeto</h4>
    {info?.instructions.length ? <ul>{info.instructions.map((name) => <li key={name}><button type="button" onClick={() => void openFile(session.id, name)}><FileText size={12} /> {name}</button></li>)}</ul> : <p className="chat-muted">Nenhum arquivo de instruções na pasta.</p>}
    <h4>Anexos da próxima mensagem</h4>
    {files.length ? <ul>{files.map((file) => <li key={file.path}><span title={file.path}><Paperclip size={12} /> {file.path.split(/[\\/]/).pop()}</span><button type="button" className="icon-button small" aria-label="Remover anexo" onClick={() => removeAttachment(session.id, file.path)}><X size={12} /></button></li>)}</ul> : <p className="chat-muted">Nenhum anexo.</p>}
    {session.status === 'rodando' && <button type="button" className="button-quiet button-sm" onClick={onAddFiles}><Paperclip size={12} /> Adicionar arquivos</button>}
    <h4>Tokens informados pelo agente</h4>
    {usage ? <>
      <dl>
        <dt>Entrada (última requisição)</dt><dd><code>{number(usage.inputTokens)}</code></dd>
        <dt>Em cache</dt><dd><code>{number(usage.cachedTokens)}</code></dd>
        <dt>Saída</dt><dd><code>{number(usage.outputTokens)}</code></dd>
        {usage.contextWindow && <><dt>Janela de contexto</dt><dd><code>{number(usage.contextWindow)}</code></dd></>}
      </dl>
      {usage.contextWindow ? <meter min={0} max={usage.contextWindow} value={Math.min(usage.inputTokens, usage.contextWindow)} aria-label="Uso da janela de contexto" /> : null}
    </> : <p className="chat-muted">O agente ainda não registrou uso de tokens.</p>}
  </div>;
}
