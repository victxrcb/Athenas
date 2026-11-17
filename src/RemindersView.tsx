import { useState } from 'react';
import { Bell, BellRing, Check, Clock3, Plus, StickyNote } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { createReminder, deleteReminder, reminderDateValue, reminderWhen, useReminderStore } from './reminders';
import { useAppStore } from './store';
import './reminders.css';

export function RemindersView() {
  const items = useReminderStore((state) => state.items);
  const setNotice = useAppStore((state) => state.setNotice);
  const [text, setText] = useState('');
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState(reminderDateValue);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    if (!isTauri()) { setNotice('Abra o aplicativo desktop para salvar lembretes.'); return; }
    const scheduledAt = schedule ? Math.floor(new Date(when).getTime() / 1000) : null;
    if (schedule && (!Number.isFinite(scheduledAt) || scheduledAt! <= Date.now() / 1000)) { setNotice('Escolha uma data e hora no futuro.'); return; }
    setSaving(true);
    try {
      await createReminder(text, scheduledAt);
      setText(''); setSchedule(false); setWhen(reminderDateValue());
    } catch (error) { setNotice(String(error)); }
    finally { setSaving(false); }
  };
  const remove = (id: string) => { void deleteReminder(id).catch((error) => setNotice(String(error))); };

  return <div className="tools-content reminders-view">
    <div className="tools-heading">
      <div><span className="section-kicker">Anotações pessoais</span><h1>Lembretes</h1><p>Post-its rápidos, com alarme somente quando você quiser.</p></div>
    </div>
    <form className="reminder-composer" onSubmit={submit}>
      <div className="reminder-composer-icon"><StickyNote size={20} /></div>
      <label className="reminder-text-field"><span>Novo lembrete</span><textarea autoFocus value={text} maxLength={4000} onChange={(event) => setText(event.target.value)} placeholder="O que você não pode esquecer?" /></label>
      <div className="reminder-options">
        <label className="settings-check"><input type="checkbox" checked={schedule} onChange={(event) => setSchedule(event.target.checked)} /> <Bell size={14} /> Agendar notificação</label>
        {schedule && <label className="reminder-date"><span>Data e hora</span><input type="datetime-local" value={when} min={reminderDateValue(new Date())} onChange={(event) => setWhen(event.target.value)} required /></label>}
        <button className="button-primary" disabled={saving || !text.trim()}><Plus size={15} /> Adicionar lembrete</button>
      </div>
    </form>

    <div className="reminders-summary"><h2>Seus post-its</h2><span>{items.length} {items.length === 1 ? 'lembrete' : 'lembretes'}</span></div>
    {items.length ? <section className="reminder-grid">{items.map((item) => {
      const scheduled = item.scheduledAt !== null;
      const notified = item.notifiedAt !== null;
      return <article className={`reminder-card ${notified ? 'notified' : ''}`} key={item.id}>
        <div className="reminder-pin" />
        <p>{item.text}</p>
        <footer>
          <span className={scheduled && !notified ? 'scheduled' : ''}>{scheduled ? <>{notified ? <BellRing size={13} /> : <Clock3 size={13} />}{notified ? 'Notificado' : reminderWhen(item.scheduledAt!)}</> : <>Sem horário</>}</span>
          <button className="reminder-done" aria-label="Concluir e apagar lembrete" title="Concluir e apagar" onClick={() => remove(item.id)}><Check size={15} /> Concluir</button>
        </footer>
      </article>;
    })}</section> : <div className="empty-panel reminder-empty"><StickyNote size={23} /><strong>Nenhum post-it por aqui.</strong><p>Adicione um lembrete simples ou escolha uma data para ser notificado.</p></div>}
  </div>;
}
