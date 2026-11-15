import { useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { Select } from './Select';
import { chooseFolder } from './folder';
import { displayPath, sameFolder } from './path';
import { sessionLabel } from './activity';
import { REPEAT_LABELS, createSchedule, toLocalInput, useScheduleStore, type ScheduleRepeat } from './schedule';
import { useAppStore, type Agent } from './store';

const AGENTS: Agent[] = ['Claude Code', 'Codex', 'Shell'];

/** Picks the target (an open session or a new one), the prompt, the time and the repetition. */
export function ScheduleModal() {
  const draft = useScheduleStore((state) => state.draft);
  const close = useScheduleStore((state) => state.close);
  const { sessions, workspace, activeProjectId, setNotice } = useAppStore();
  const [target, setTarget] = useState<'session' | 'new'>('session');
  const [sessionId, setSessionId] = useState('');
  const [agent, setAgent] = useState<Agent>('Claude Code');
  const [folder, setFolder] = useState('');
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [repeat, setRepeat] = useState<ScheduleRepeat>('none');
  const [saving, setSaving] = useState(false);
  const running = sessions.filter((session) => session.status === 'rodando' || session.resumeId);

  useEffect(() => {
    if (!draft) return;
    const project = workspace.projects.find((item) => item.id === activeProjectId);
    setTarget(draft.target);
    setSessionId(draft.sessionId ?? running.find((session) => session.status === 'rodando')?.id ?? '');
    setAgent((draft.agent as Agent) ?? 'Claude Code');
    setFolder(displayPath(draft.folder ?? project?.folder ?? ''));
    setText('');
    setRepeat('none');
    setWhen(toLocalInput(new Date(Date.now() + 30 * 60_000)));
    // Only when the editor opens; the lists may change while it is open.
  }, [draft]);

  if (!draft) return null;
  const quick = (label: string, date: Date) => <button type="button" className="button-quiet button-sm" onClick={() => setWhen(toLocalInput(date))}>{label}</button>;
  const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const tomorrowAt = (hour: number) => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(hour, 0, 0, 0); return date; };
  const projectName = (sessionFolder: string) => workspace.projects.find((project) => sameFolder(project.folder, sessionFolder))?.name ?? displayPath(sessionFolder).split(/[\\/]/).filter(Boolean).at(-1) ?? '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const runAt = Math.floor(new Date(when).getTime() / 1000);
    if (!Number.isFinite(runAt)) { setNotice('Escolha data e horário.'); return; }
    setSaving(true);
    try {
      await createSchedule({ target, sessionId: target === 'session' ? sessionId : null, agent: target === 'new' ? agent : null, folder: target === 'new' ? folder.trim() : null, text, runAt, repeat });
      close();
      setNotice('Prompt agendado.');
    } catch (error) { setNotice(String(error)); }
    finally { setSaving(false); }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
    <form className="modal schedule-modal" role="dialog" aria-modal="true" aria-label="Agendar prompt" onSubmit={submit}>
      <div className="modal-top"><span className="section-kicker"><CalendarClock size={13} /> Agendar prompt</span><button type="button" className="icon-button" aria-label="Fechar" onClick={close}><X size={16} /></button></div>
      <h2>Envie mais tarde.</h2><p className="modal-intro">O texto é digitado no agente no horário escolhido, como se você tivesse enviado.</p>
      <div className="schedule-target segmented" role="radiogroup" aria-label="Destino">
        <button type="button" role="radio" aria-checked={target === 'session'} className={target === 'session' ? 'active' : ''} onClick={() => setTarget('session')}>Sessão existente</button>
        <button type="button" role="radio" aria-checked={target === 'new'} className={target === 'new' ? 'active' : ''} onClick={() => setTarget('new')}>Nova sessão</button>
      </div>
      {target === 'session'
        ? <div className="form-field"><span>Agente</span>{running.length
          ? <Select label="Sessão" value={sessionId} onChange={setSessionId} placeholder="Escolha a sessão"
            options={running.map((session) => ({ value: session.id, label: `${sessionLabel(session)} · ${projectName(session.folder)}${session.status === 'rodando' ? '' : ' (encerrada)'}`, icon: <AgentIcon agent={session.agent} size={13} /> }))} />
          : <p className="schedule-hint">Nenhuma sessão aberta. Escolha "Nova sessão".</p>}
          <small className="schedule-hint">Se a sessão estiver fechada na hora, o prompt vai para a sessão que retomou a mesma conversa (Claude Code). Sem nenhuma, o envio falha e fica na caixa de entrada.</small></div>
        : <div className="form-grid">
          <div className="select-field"><span>Agente</span><Select label="Agente" value={agent} onChange={(value) => setAgent(value as Agent)} options={AGENTS.map((item) => ({ value: item, label: item, icon: <AgentIcon agent={item} size={13} /> }))} /></div>
          <label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={'C:\\caminho\\do\\projeto'} aria-label="Pasta" /><button type="button" className="button-quiet" onClick={async () => { const chosen = await chooseFolder(); if (chosen) setFolder(chosen); }}>Escolher</button></div></label>
        </div>}
      <label className="form-field"><span>Prompt</span><textarea className="schedule-text" value={text} onChange={(event) => setText(event.target.value)} rows={5} placeholder="Ex.: rode os testes e corrija o que falhar" required /></label>
      <div className="form-field"><span>Quando</span>
        <div className="schedule-when"><input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} aria-label="Data e horário" required />
          {quick('Em 15 min', inMinutes(15))}{quick('Em 1 h', inMinutes(60))}{quick('Amanhã 9h', tomorrowAt(9))}</div></div>
      <div className="form-field"><span>Repetir</span><Select label="Repetir" value={repeat} onChange={(value) => setRepeat(value as ScheduleRepeat)} options={Object.entries(REPEAT_LABELS).map(([value, label]) => ({ value, label }))} /></div>
      <div className="modal-footer"><span /><div><button type="button" className="button-quiet" onClick={close}>Cancelar</button><button className="button-primary" type="submit" disabled={saving || (target === 'session' && !sessionId) || !text.trim()}>Agendar</button></div></div>
    </form>
  </div>;
}
