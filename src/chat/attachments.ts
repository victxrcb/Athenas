/** Files waiting to be sent with the next message of each session. */
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { displayPath } from '../path';
import { notice } from './actions';

export type Attachment = { path: string; preview?: string };

export const useAttachments = create<{ files: Record<string, Attachment[]> }>(() => ({ files: {} }));
const NONE: Attachment[] = [];
export const useSessionAttachments = (id: string) => useAttachments((state) => state.files[id] ?? NONE);

export function addAttachments(id: string, added: Attachment[]) {
  useAttachments.setState(({ files }) => {
    const current = files[id] ?? [];
    return { files: { ...files, [id]: [...current, ...added.filter((item) => !current.some((existing) => existing.path === item.path))].slice(0, 20) } };
  });
}
export const removeAttachment = (id: string, path: string) => useAttachments.setState(({ files }) => ({ files: { ...files, [id]: (files[id] ?? []).filter((item) => item.path !== path) } }));
export const clearAttachments = (id: string) => useAttachments.setState(({ files }) => ({ files: { ...files, [id]: [] } }));

/** Pasted images are saved as PNG files the agent can read, the same way the terminal view does it. */
export async function attachImage(id: string, image: Blob) {
  try {
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const preview = canvas.toDataURL('image/png');
    const path = await invoke<string>('terminal_save_image', { data: preview.split(',')[1] });
    addAttachments(id, [{ path, preview }]);
  } catch (error) { notice(String(error)); }
}

/** `@relative/path` for Claude Code files inside the folder; a quoted full path otherwise. */
export function attachmentReference(path: string, agent: string, cwd: string): string {
  const full = displayPath(path);
  const normal = full.replace(/\\/g, '/');
  const base = `${displayPath(cwd).replace(/\\/g, '/').replace(/\/$/, '')}/`;
  if (agent === 'Claude Code' && normal.toLowerCase().startsWith(base.toLowerCase())) {
    const relative = normal.slice(base.length);
    if (!/\s/.test(relative)) return `@${relative}`;
  }
  return `"${full}"`;
}

export const messageWithAttachments = (body: string, files: Attachment[], agent: string, cwd: string) =>
  [body.trim(), files.map((file) => attachmentReference(file.path, agent, cwd)).join(' ')].filter(Boolean).join('\n\n');
