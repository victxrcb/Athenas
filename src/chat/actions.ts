/** Side effects a conversation can trigger. Everything an agent wrote is treated as untrusted. */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useAppStore } from '../store';

export const notice = (message: string) => useAppStore.getState().setNotice(message);

export async function copyText(value: string, done = 'Copiado.') {
  try {
    await navigator.clipboard.writeText(value);
    notice(done);
  } catch { notice('Não foi possível copiar.'); }
}

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)/i;

/** `src/app.ts:12`, `src/app.ts#L12` → path and line; anything with a scheme is not a file. */
export function fileTarget(value: string): { path: string; line?: number } | null {
  let target = value;
  try { target = decodeURIComponent(value); } catch { /* keep the raw text */ }
  if (/^[a-z][\w+.-]+:/i.test(target) || target.startsWith('#') || target.startsWith('//')) return null;
  const match = /^(.*?)(?:(?::|#L)(\d+)(?:[-:]L?\d+)?)?$/.exec(target);
  return match?.[1] ? { path: match[1], line: match[2] ? Number(match[2]) : undefined } : null;
}

export async function openFile(sessionId: string, path: string, line?: number) {
  if (!isTauri()) return notice('Abra o aplicativo desktop para abrir arquivos.');
  try { await invoke('chat_open_file', { sessionId, path, line: line ?? null }); }
  catch (error) { notice(String(error)); }
}

/** Only web links and files of the session folder open; the webview itself never navigates. */
export async function openLink(sessionId: string, href: string) {
  const file = fileTarget(href);
  if (file) return openFile(sessionId, file.path, file.line);
  if (!isTauri()) return notice('Abra o aplicativo desktop para abrir links.');
  try {
    if (LOCAL.test(href)) await invoke('open_local_url', { url: LOCAL.exec(href)![0] });
    else if (href.startsWith('https://')) await invoke('git_open_url', { url: href });
    else notice('Só links https, endereços locais e arquivos do projeto podem ser abertos.');
  } catch (error) { notice(String(error)); }
}

export async function exportMarkdown(content: string, name: string) {
  if (!isTauri()) return notice('Abra o aplicativo desktop para exportar.');
  try {
    if (await invoke<boolean>('chat_export', { content, name })) notice('Arquivo salvo.');
  } catch (error) { notice(String(error)); }
}
