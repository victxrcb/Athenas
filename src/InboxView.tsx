import { CalendarClock, Check, CheckCheck, Clock3, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { translateAgentMessage, openTarget } from './notifications';
import { useActivityStore } from './activity';
import { ago, dismissKeys, useInboxItems, type InboxItem } from './inbox';
import { REPEAT_LABELS, formatWhen, scheduleAction, useScheduleStore, type ScheduledPrompt } from './schedule';
import { displayPath, sameFolder } from './path';
import { useAppStore } from './store';
import './inbox.css';

const KIND_LABEL: Record<InboxItem['kind'], string> = { approval: 'Aguardando você', done: 'Terminou', error: 'Falhou' };
const KIND_TONE: Record<InboxItem['kind'], string> = { approval: 'waiting', done: 'done', error: 'error' };
const STATUS_LABEL: Record<ScheduledPrompt['status'], string> = { pending: 'Agendado', sent: 'Enviado', failed: 'Falhou', cancelled: 'Cancelado' };

export function InboxView() {
  const items = useInboxItems();
  const schedules = useScheduleStore((state) => state.items);
  const openEditor = useScheduleStore((state) => state.open);
  const { workspace, setNotice } = useAppStore();
  const place = (folder: string) => workspace.projects.find((project) => sameFolder(project.folder, folder))?.name ?? (displayPath(folder).split(/[\\/]/).filter(Boolean).at(-1) || '');
  const dismiss = (item: InboxItem) => {
    if (item.source === 'session') {
      // Approvals are answered in the terminal; dismissing just stops listing them.
      const store = useActivityStore.getState();
      const current = store.activity[item.id];
      if (current) store.set(item.id, { ...current, state: current.state === 'approval' ? 'idle' : current.state, unread: false });
    } else dismissKeys([item.key]);
  };
  const run = (task: Promise<unknown>) => { void task.catch((error) => setNotice(String(error))); };
  const pending = schedules.filter((item) => item.status === 'pending');
  const past = schedules.filter((item) => item.status !== 'pending').slice(0, 20);

  const scheduleRow = (item: ScheduledPrompt) => <div className={`schedule-row status-${item.status}`} key={item.id}>
    <span className="inbox-icon"><AgentIcon agent={item.agent} size={15} /></span>
    <div className="inbox-text">
      <strong>{item.label}</strong>
      <p title={item.text}>{item.text}</p>
      <small>{item.status === 'pending' ? `Envia ${formatWhen(item.runAt)}` : item.lastRunAt ? `${STATUS_LABEL[item.status]} ${formatWhen(item.lastRunAt)}` : STATUS_LABEL[item.status]}
        {item.repeat !== 'none' && <> · {REPEAT_LABELS[item.repeat]}</>}
        {item.lastError && <span className="inbox-error"> · {item.lastError}</span>}</small>
    </div>
    <span className={`inbox-pill ${item.status}`}>{STATUS_LABEL[item.status]}</span>
    <div className="inbox-actions">
      {item.status !== 'cancelled' && <button className="icon-button small" title={item.status === 'failed' ? 'Tentar de novo' : 'Enviar agora'} aria-label={item.status === 'failed' ? 'Tentar de novo' : 'Enviar agora'} onClick={() => run(scheduleAction('schedule_run_now', item.id))}>{item.status === 'failed' ? <RotateCcw size={14} /> : <Play size={14} />}</button>}
      {item.status === 'pending' && <button className="icon-button small" title="Cancelar" aria-label="Cancelar agendamento" onClick={() => run(scheduleAction('schedule_cancel', item.id))}><X size={14} /></button>}
      <button className="icon-button small" title="Excluir" aria-label="Excluir agendamento" onClick={() => run(scheduleAction('schedule_delete', item.id))}><Trash2 size={14} /></button>
    </div>
  </div>;

  return <div className="tools-content inbox-view">
    <div className="tools-heading">
      <div><span className="section-kicker">Pendências</span><h1>Caixa de entrada</h1><p>{items.length ? `${items.length} item(ns) esperando por você.` : 'Nada esperando por você agora.'}</p></div>
      <div className="heading-actions">
        {items.length > 0 && <button className="button-quiet" onClick={() => items.forEach(dismiss)}><CheckCheck size={15} /> Limpar tudo</button>}
        <button className="button-primary" onClick={() => openEditor({ target: 'session' })}><CalendarClock size={15} /> Agendar prompt</button>
      </div>
    </div>
    <section className="inbox-section">
      {items.length ? items.map((item) => <div className={`inbox-row tone-${KIND_TONE[item.kind]}`} key={item.key}>
        <span className="inbox-icon"><AgentIcon agent={item.agent} size={15} /></span>
        <button className="inbox-text inbox-open" onClick={() => { openTarget(`${item.source}:${item.id}`); if (item.source === 'worker') dismissKeys([item.key]); }}>
          <strong>{item.source === 'worker' ? `Worker · ${item.title}` : item.title}</strong>
          {item.detail && <p>{translateAgentMessage(item.detail)}</p>}
          <small>{place(item.folder)}{place(item.folder) ? ' · ' : ''}{ago(item.at)}</small>
        </button>
        <span className={`inbox-pill ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        <div className="inbox-actions"><button className="icon-button small" title="Dispensar" aria-label="Dispensar" onClick={() => dismiss(item)}><Check size={14} /></button></div>
      </div>)
        : <div className="empty-panel"><CheckCheck size={20} /><strong>Tudo em dia.</strong><p>Pedidos de aprovação e turnos terminados aparecem aqui enquanto você não os vê.</p></div>}
    </section>
    <div className="inbox-subheading"><h2><Clock3 size={15} /> Prompts agendados</h2><span>{pending.length} na fila</span></div>
    <section className="inbox-section">
      {pending.length ? pending.map(scheduleRow) : <div className="empty-panel compact"><p>Nenhum prompt na fila. Use <b>Agendar prompt</b> ou o botão de relógio no painel de um agente.</p></div>}
    </section>
    {past.length > 0 && <>
      <div className="inbox-subheading"><h2>Já executados</h2></div>
      <section className="inbox-section muted">{past.map(scheduleRow)}</section>
    </>}
  </div>;
}
