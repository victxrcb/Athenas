import { useState } from 'react';
import { liveStatus, renameSession, sessionLabel, useActivityStore } from './activity';
import { useAppStore, type SessionInfo } from './store';
import { StatusBadge, StatusDot, type StatusInfo } from './status';
import { AgentIcon } from './AgentIcon';

export function useLiveStatus(session: SessionInfo): StatusInfo {
  const activity = useActivityStore((state) => state.activity[session.id]);
  return liveStatus(session, activity);
}

export function LiveBadge({ session }: { session: SessionInfo }) {
  return <StatusBadge info={useLiveStatus(session)} />;
}

/** Agent icon, editable name and live status dot: the content of a session tab. */
export function SessionChip({ session, iconSize = 12 }: { session: SessionInfo; iconSize?: number }) {
  const info = useLiveStatus(session);
  return <><AgentIcon agent={session.agent} size={iconSize} /><SessionName session={session} /><StatusDot info={info} /></>;
}

/** Session name that turns into an input on double-click; Enter saves, Esc cancels, empty restores the agent name. */
export function SessionName({ session, className }: { session: SessionInfo; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const label = sessionLabel(session);
  if (!editing) {
    return <span className={`session-title ${className ?? ''}`} title={`${label} — clique duas vezes para renomear`}
      onDoubleClick={(event) => { event.stopPropagation(); setDraft(session.title ?? ''); setEditing(true); }}>{label}</span>;
  }
  const save = () => {
    setEditing(false);
    if ((draft.trim() || null) === (session.title ?? null)) return;
    void renameSession(session.id, draft).catch((error) => useAppStore.getState().setNotice(String(error)));
  };
  return <input className="session-title-input" autoFocus value={draft} maxLength={60} placeholder={session.agent} aria-label="Nome da sessão"
    onChange={(event) => setDraft(event.target.value)}
    onClick={(event) => event.stopPropagation()}
    onBlur={save}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Enter') save();
      if (event.key === 'Escape') setEditing(false);
    }} />;
}
