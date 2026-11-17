import { useEffect, useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import codexIcon from './assets/brand/codex-icon.png';
import { loadMascot, mascotPixels } from './mascot';
import { displayPath } from './path';
import { useAppStore, type SessionInfo } from './store';
import { sessionOnScreen } from './activity';

/** Desktop notifications when an agent finishes a turn or waits for approval. */
export type AttentionKind = 'done' | 'approval' | 'error';
type AttentionEvent = { sessionId: string; kind: AttentionKind; message: string };
export type WorkerLike = { id: string; agent: string; brief: string; status: string; error?: string | null; permissionRequest?: string | null; project?: string; branch?: string; finishedAt?: number | null };

const KEY = 'athenas-notifications';
const EVENT = 'athenas-notifications';

export function loadNotificationsEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* applies until restart */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const subscribe = (callback: () => void) => { window.addEventListener(EVENT, callback); return () => window.removeEventListener(EVENT, callback); };
export const useNotificationsEnabled = () => useSyncExternalStore(subscribe, loadNotificationsEnabled, () => true);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Agent prompts arrive in English; show the common ones in Portuguese and keep anything else as is. */
export function translateAgentMessage(message: string): string {
  const text = message.trim().replace(/\s+/g, ' ');
  const rules: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/needs your permission to use (.+)$/i, (m) => `Quer usar ${m[1]}`],
    [/^Approval requested(?: by [^:]+)?: (.+)$/i, (m) => `Quer executar: ${m[1]}`],
    [/^Approval requested.*$/i, () => 'Pediu aprovação'],
    [/^Codex wants to edit (.+)$/i, (m) => `Quer editar ${m[1].replace(/\bfiles\b/, 'arquivos')}`],
    [/^Question: (.+)$/i, (m) => `Pergunta: ${m[1]}`],
    [/^Plan mode prompt: (.+)$/i, (m) => `Plano: ${m[1]}`],
  ];
  for (const [pattern, render] of rules) {
    const match = text.match(pattern);
    if (match) return render(match);
  }
  return text;
}

export function attentionText(agent: string, kind: AttentionKind, message: string, place: string | null): { title: string; body: string } {
  const detail = translateAgentMessage(message);
  const title = kind === 'approval' ? `${agent} precisa da sua aprovação` : kind === 'error' ? `${agent} falhou` : `${agent} terminou`;
  const fallback = kind === 'approval' ? 'Aguardando sua resposta.' : kind === 'error' ? 'A execução terminou com erro.' : 'Pronto para a próxima instrução.';
  const body = clip(detail || fallback, 180);
  return { title, body: place ? `${place} · ${body}` : body };
}

const WORKER_EVENTS: Record<string, AttentionKind> = { completed: 'done', failed: 'error', awaiting_permission: 'approval' };

/** Workers whose status just moved into one of the announced states. The first poll only records a baseline. */
export function workerTransitions(previous: Map<string, string> | null, workers: WorkerLike[]): { worker: WorkerLike; kind: AttentionKind }[] {
  if (!previous) return [];
  return workers.flatMap((worker) => {
    const kind = WORKER_EVENTS[worker.status];
    return kind && previous.get(worker.id) !== worker.status ? [{ worker, kind }] : [];
  });
}

function sessionPlace(session: SessionInfo): string {
  const { workspace } = useAppStore.getState();
  const pane = workspace.panes.find((item) => item.id === session.paneId);
  const project = workspace.projects.find((item) => item.id === pane?.projectId);
  const place = project?.name ?? displayPath(session.folder).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return session.title ? `${place} · ${session.title}` : place;
}

const iconCache = new Map<string, Promise<string | null>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
}

/** Renders the agent's mark (the user's mascot for Claude) as a PNG for the notification, base64 without prefix. */
async function renderAgentIcon(agent: string): Promise<string | null> {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#141418';
  context.beginPath(); context.roundRect(0, 0, size, size, 28); context.fill();
  const area = 88;
  if (agent === 'Claude Code') {
    const { rows, pixels } = mascotPixels(loadMascot());
    const cell = Math.floor(area / Math.max(13, rows));
    const left = Math.round((size - cell * 13) / 2);
    const top = Math.round((size - cell * rows) / 2);
    for (const pixel of pixels) {
      context.globalAlpha = pixel.opacity ?? 1;
      context.fillStyle = pixel.fill;
      context.fillRect(left + pixel.x * cell, top + pixel.y * cell, cell, cell);
    }
    context.globalAlpha = 1;
  } else if (agent === 'Codex') {
    const image = await loadImage(codexIcon);
    const offset = (size - area) / 2;
    context.drawImage(image, offset, offset, area, area);
  } else {
    // Lucide "terminal" glyph on its 24-unit grid.
    const scale = area / 24;
    context.translate((size - area) / 2, (size - area) / 2);
    context.scale(scale, scale);
    context.strokeStyle = '#e8e8e8'; context.lineWidth = 2; context.lineCap = 'round'; context.lineJoin = 'round';
    context.beginPath(); context.moveTo(4, 17); context.lineTo(10, 11); context.lineTo(4, 5); context.moveTo(12, 19); context.lineTo(20, 19); context.stroke();
  }
  return canvas.toDataURL('image/png').split(',')[1] ?? null;
}

function agentIcon(agent: string): Promise<string | null> {
  const key = agent === 'Claude Code' ? `${agent}:${JSON.stringify(loadMascot())}` : agent;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = renderAgentIcon(agent).catch(() => null);
    iconCache.set(key, icon);
  }
  return icon;
}

const recent = new Map<string, number>();

async function notify(agent: string, title: string, body: string, target: string, dedupeKey: string) {
  if (!loadNotificationsEnabled()) return;
  const now = Date.now();
  if (now - (recent.get(dedupeKey) ?? 0) < 4000) return;
  recent.set(dedupeKey, now);
  try {
    await invoke('notify_show', { title, body, iconPng: await agentIcon(agent), target });
  } catch (error) {
    console.warn('Notificação não exibida:', error);
  }
}

/** Announces worker transitions found by the orchestrator poll. */
export function notifyWorkers(transitions: { worker: WorkerLike; kind: AttentionKind }[]) {
  if (!transitions.length) return;
  if (document.hasFocus() && useAppStore.getState().section === 'orchestrator') return;
  for (const { worker, kind } of transitions) {
    const agent = worker.agent === 'codex' ? 'Codex' : worker.agent === 'claude' ? 'Claude Code' : 'Shell';
    const label = worker.agent === 'codex' ? 'Codex' : worker.agent === 'claude' ? 'Claude' : worker.agent;
    const detail = kind === 'approval' ? worker.permissionRequest ?? '' : kind === 'error' ? worker.error ?? '' : '';
    const { title, body } = attentionText(`Worker ${label}`, kind, detail || worker.brief, null);
    void notify(agent, title, body, `worker:${worker.id}`, `worker:${worker.id}:${kind}`);
  }
}

export function openTarget(target: string) {
  const state = useAppStore.getState();
  const [kind, id] = target.split(':');
  if (kind === 'worker') { state.setSection('orchestrator'); return; }
  if (kind === 'reminder') { state.setSection('reminders'); state.setActiveProjectId(null); state.setActiveSessionId(null); return; }
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  state.setSection('home');
  const pane = state.workspace.panes.find((item) => item.id === session.paneId);
  if (pane) { state.setActiveSessionId(null); state.setActiveProjectId(pane.projectId); }
  else { state.setActiveProjectId(null); state.setActiveSessionId(session.id); }
}

/** Listens for agent attention events from the backend and turns them into desktop notifications. */
export function useAgentNotifications() {
  useEffect(() => {
    if (!isTauri()) return;
    const attention = listen<AttentionEvent>('agent-attention', ({ payload }) => {
      // "working" only moves the live status; it is never announced.
      if ((payload.kind as string) === 'working') return;
      const session = useAppStore.getState().sessions.find((item) => item.id === payload.sessionId);
      if (!session || sessionOnScreen(session)) return;
      const { title, body } = attentionText(session.agent, payload.kind, payload.message, sessionPlace(session));
      void notify(session.agent, title, body, `session:${session.id}`, `session:${session.id}:${payload.kind}`);
    });
    const open = listen<string>('notification-open', ({ payload }) => openTarget(payload));
    return () => { void attention.then((unlisten) => unlisten()); void open.then((unlisten) => unlisten()); };
  }, []);
}
