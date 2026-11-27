import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import * as push from './push';

/** The notifications block of the agent list. `registered` is what the computer knows about this device. */
export function Notifications({ registered, onChange }: { registered: boolean; onChange: () => void }) {
  const [local, setLocal] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { let active = true; void push.subscribed().then((value) => { if (active) setLocal(value); }).catch(() => setLocal(false)); return () => { active = false; }; }, [registered]);
  if (!push.supported()) return <p className="phone-muted">Este navegador não recebe notificações. Abra a página no Chrome.</p>;
  const on = registered && local === true;
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setLocal(await push.subscribed());
      setMessage(done);
      onChange();
    } catch (failure) {
      setMessage(failure instanceof ApiError || failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  return <section className="phone-notifications" aria-label="Notificações">
    <div>
      <span>{on ? 'Notificações ligadas' : 'Avisar quando um agente terminar ou precisar de você'}</span>
      <div className="phone-actions">
        {on ? <>
          <button type="button" disabled={busy} onClick={() => void run(api.pushTest, 'Aviso de teste enviado. Ele deve chegar em alguns segundos.')}>Testar</button>
          <button type="button" disabled={busy} onClick={() => void run(push.disable, 'Notificações desligadas.')}>Desligar</button>
        </> : <button type="button" className="primary" disabled={busy || local === null} onClick={() => void run(push.enable, 'Notificações ligadas.')}>Ligar notificações</button>}
      </div>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
