/** The "Celular" block of the settings: turns phone access on, pairs a phone and revokes devices. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Check, Circle, Copy, RefreshCw, Smartphone } from 'lucide-react';
import { confirmAction } from '../confirm';
import { useAppStore } from '../store';
import { QrCode } from './QrCode';
import './mobile.css';

export type MobileView = {
  enabled: boolean;
  url: string | null;
  error: string | null;
  pairing: { url: string; expiresAt: number } | null;
  request: { id: string; name: string; verification: string } | null;
  devices: { id: string; name: string; createdAt: number; lastSeenAt: number; control: boolean; notifications: boolean }[];
  actions: { at: number; device: string; agent: string; action: string; detail: string }[];
  pushError: string | null;
};
export type TailscaleStatus = { installed: boolean; running: boolean; https: boolean; dnsName: string | null };

const POLL = 1_500;
const ACTIONS: Record<string, string> = { sent: 'enviou mensagem para', interrupted: 'interrompeu', allowed: 'aprovou em', denied: 'recusou em', answered: 'respondeu em' };

export function lastSeen(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 2) return 'agora há pouco';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return <li data-done={done}>{done ? <Check size={13} aria-label="Pronto" /> : <Circle size={13} aria-label="Pendente" />}<span>{children}</span></li>;
}

export function MobileSettings() {
  const setNotice = useAppStore((state) => state.setNotice);
  const [view, setView] = useState<MobileView | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const latest = useRef<MobileView | null>(null);
  latest.current = view;

  const call = useCallback(async (command: string, args?: Record<string, unknown>) => {
    try { setView(await invoke<MobileView>(command, args)); } catch (error) { setNotice(String(error)); }
  }, [setNotice]);
  const checkTailscale = useCallback(() => {
    void invoke<TailscaleStatus>('mobile_tailscale').then(setTailscale).catch((error) => setNotice(String(error)));
  }, [setNotice]);

  useEffect(() => {
    if (!isTauri()) return;
    checkTailscale();
    void call('mobile_state');
    const timer = window.setInterval(() => { setNow(Date.now()); void call('mobile_state'); }, POLL);
    return () => {
      window.clearInterval(timer);
      // Nobody is left to confirm a phone, so an open code stops working.
      if (latest.current?.pairing || latest.current?.request) void invoke('mobile_pairing_cancel').catch(() => undefined);
    };
  }, [call, checkTailscale]);

  if (!isTauri()) return <div className="mobile-settings"><span>Celular</span><div className="mobile-box"><small>Disponível no aplicativo desktop.</small></div></div>;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    await call('mobile_set_enabled', { enabled });
    checkTailscale();
    setBusy(false);
  };
  const revoke = async (id: string, name: string) => {
    if (await confirmAction(`O aparelho “${name}” perde o acesso imediatamente.`, { title: 'Revogar acesso?', confirm: 'Revogar' })) await call('mobile_revoke', { deviceId: id });
  };
  const control = async (id: string, name: string, allow: boolean) => {
    // Taking the permission away needs no question; giving it does.
    if (allow && !await confirmAction(`“${name}” poderá ler as conversas, enviar mensagens, interromper e aprovar comandos neste computador.`, { title: 'Liberar este aparelho?', confirm: 'Liberar' })) return;
    await call('mobile_set_control', { deviceId: id, allow });
  };
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => setNotice('Link copiado. Ele vale por 2 minutos.')).catch((error) => setNotice(String(error)));
  const seconds = view?.pairing ? Math.max(0, Math.ceil((view.pairing.expiresAt - now) / 1000)) : 0;

  return <div className="mobile-settings">
    <span>Celular</span>
    <div className="mobile-box">
      <label className="mobile-toggle">
        <input type="checkbox" checked={view?.enabled ?? false} disabled={!view || busy} onChange={(event) => void toggle(event.target.checked)} />
        <span>Permitir acesso pelo celular<small>{busy ? 'Aplicando…' : 'Acompanhe os agentes em execução pela sua rede Tailscale. Vale na hora, sem precisar salvar.'}</small></span>
      </label>
      {view?.error && <p className="mobile-error" role="alert">{view.error}</p>}
      {view && !view.url && <>
        <ul className="mobile-steps">
          <Step done={tailscale?.installed ?? false}>Tailscale instalado</Step>
          <Step done={tailscale?.running ?? false}>Conectado à sua conta</Step>
          <Step done={tailscale?.https ?? false}>HTTPS Certificates ativado no painel do Tailscale</Step>
        </ul>
        <div className="mobile-actions">
          <button type="button" className="button-quiet button-sm" onClick={checkTailscale}><RefreshCw size={12} /> Verificar de novo</button>
          {view.enabled && <button type="button" className="button-quiet button-sm" disabled={busy} onClick={() => void toggle(true)}>Tentar publicar</button>}
        </div>
      </>}
      {view?.url && <>
        <p className="mobile-address">Endereço: <code>{view.url}</code></p>
        {view.request ? <div className="mobile-request" role="alertdialog" aria-label="Pedido de pareamento">
          <strong>Permitir “{view.request.name}”?</strong>
          <p>Confira se o celular mostra o número <b>{view.request.verification}</b>.</p>
          <div className="mobile-actions">
            <button type="button" className="button-quiet button-sm" onClick={() => void call('mobile_pairing_decide', { requestId: view.request!.id, allow: false })}>Recusar</button>
            <button type="button" className="button-primary button-sm" onClick={() => void call('mobile_pairing_decide', { requestId: view.request!.id, allow: true })}>Permitir</button>
          </div>
        </div> : view.pairing ? <div className="mobile-pairing">
          <QrCode value={view.pairing.url} label="QR code de pareamento" />
          <div>
            <strong>Escaneie com o celular</strong>
            <p>Abra o link no Chrome, com o Tailscale ligado. O código vale uma vez e expira em {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}.</p>
            <div className="mobile-actions">
              <button type="button" className="button-quiet button-sm" onClick={() => copy(view.pairing!.url)}><Copy size={12} /> Copiar link</button>
              <button type="button" className="button-quiet button-sm" onClick={() => void call('mobile_pairing_cancel')}>Cancelar</button>
            </div>
          </div>
        </div> : <div className="mobile-actions"><button type="button" className="button-primary button-sm" onClick={() => void call('mobile_pairing_start')}><Smartphone size={12} /> Parear celular</button></div>}
      </>}
      {view && view.devices.length > 0 && <div className="mobile-devices">
        <small>Aparelhos pareados</small>
        <ul>{view.devices.map((device) => <li key={device.id}>
          <Smartphone size={13} aria-hidden="true" />
          <span>{device.name}<small>Último acesso {lastSeen(device.lastSeenAt, now)} · {device.notifications ? 'notificações ligadas' : 'sem notificações'}</small></span>
          <button type="button" className="button-quiet button-sm danger" onClick={() => void revoke(device.id, device.name)}>Revogar</button>
          <label className="mobile-control">
            <input type="checkbox" checked={device.control} onChange={(event) => void control(device.id, device.name, event.target.checked)} />
            Pode conversar e aprovar
          </label>
        </li>)}</ul>
      </div>}
      {view?.pushError && <p className="mobile-error" role="alert">Última notificação: {view.pushError}</p>}
      {view && view.actions.length > 0 && <div className="mobile-devices">
        <small>Últimas ações pelo celular</small>
        <ul>{view.actions.map((item, index) => <li key={`${item.at}-${index}`}>
          <span>{item.device} {ACTIONS[item.action] ?? item.action} “{item.agent}”<small title={item.detail}>{new Date(item.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{item.detail && ` · ${item.detail}`}</small></span>
        </li>)}</ul>
      </div>}
    </div>
  </div>;
}
