import { isTauri } from '@tauri-apps/api/core';
import { confirmAction } from './confirm';

const PENDING_KEY = 'athenas.update.deferred';
const RECHECK_MS = 30 * 60 * 1000;
let busy = false;

const read = () => { try { return localStorage.getItem(PENDING_KEY); } catch { return null; } };
const write = (value: string | null) => { try { value ? localStorage.setItem(PENDING_KEY, value) : localStorage.removeItem(PENDING_KEY); } catch { /* storage unavailable */ } };

async function install(update: { downloadAndInstall: () => Promise<void> }, notify: (message: string) => void) {
  notify('Baixando atualização… o app reiniciará ao terminar.');
  await update.downloadAndInstall();
  write(null);
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

async function checkOnce(notify: (message: string) => void, startup: boolean) {
  if (busy) return;
  busy = true;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) { write(null); return; }
    // The user chose "Depois" last session: apply it now, on this launch.
    if (startup && read()) { await install(update, notify); return; }
    // Already deferred in this session: do not nag again until the next launch.
    if (read()) return;
    const now = await confirmAction(`A versão ${update.version} do Athenas Agent está disponível. Atualizar agora reinicia o app; se escolher "Depois", a atualização é instalada na próxima vez que você abrir o app.`, { title: 'ATUALIZAÇÃO DISPONÍVEL', confirm: 'Atualizar agora', cancel: 'Depois' });
    if (now) await install(update, notify);
    else write(update.version);
  } catch (error) {
    console.warn('Falha ao verificar atualizações', error);
  } finally { busy = false; }
}

// Checks GitHub Releases at launch and every 30 min while the app stays open.
export function startUpdateChecks(notify: (message: string) => void): () => void {
  if (!isTauri() || import.meta.env.DEV) return () => {};
  void checkOnce(notify, true);
  const timer = window.setInterval(() => void checkOnce(notify, false), RECHECK_MS);
  return () => window.clearInterval(timer);
}
