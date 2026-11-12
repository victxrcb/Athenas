import { useEffect, useRef, useState } from 'react';
import { subscribeConfirm } from './confirm';

type Pending = { message: string; resolve: (ok: boolean) => void; labels?: { title?: string; confirm?: string; cancel?: string } };

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => subscribeConfirm(setPending), []);
  useEffect(() => { if (pending) confirmButton.current?.focus(); }, [pending]);
  if (!pending) return null;
  const answer = (ok: boolean) => { pending.resolve(ok); setPending(null); };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) answer(false); }} onKeyDown={(event) => { if (event.key === 'Escape') answer(false); }}>
    <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label="Confirmação">
      <span className="section-kicker">{pending.labels?.title ?? 'CONFIRMAÇÃO'}</span>
      <p>{pending.message}</p>
      <div className="modal-footer"><span /><div>
        <button type="button" className="button-quiet" onClick={() => answer(false)}>{pending.labels?.cancel ?? 'Cancelar'}</button>
        <button type="button" className="button-primary" ref={confirmButton} onClick={() => answer(true)}>{pending.labels?.confirm ?? 'Confirmar'}</button>
      </div></div>
    </div>
  </div>;
}
