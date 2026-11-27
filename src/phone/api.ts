/** Requests to the desktop app. The device cookie travels with them automatically. */
import type { Chunk, PermissionRequest } from '../chat/store';

export type { Chunk, PermissionRequest };
export type AgentCard = { id: string; agent: string; title: string | null; project: string | null; folder: string; tone: string; label: string; message: string; since: number | null; state: string };
export type Overview = { computer: string; theme: string | null; agents: AgentCard[]; canControl: boolean; notifications: boolean };
export type PairStatus = 'waiting' | 'paired' | 'denied' | 'expired';
export type Decision = { behavior: 'allow' | 'deny' | 'answer'; answers?: Record<string, string> };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const TIMEOUT = 10_000;
/** A first page of a long conversation over mobile data. */
const SLOW_TIMEOUT = 30_000;

async function request<T>(path: string, body?: unknown, timeout = TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError((data as { error?: string } | null)?.error ?? 'O computador recusou o pedido.', response.status);
    return data as T;
  } finally { window.clearTimeout(timer); }
}

export const api = {
  agents: () => request<Overview>('/api/agents'),
  pair: (code: string, name: string) => request<{ requestId: string; verification: string }>('/api/pair', { code, name }),
  pairStatus: (requestId: string) => request<{ status: PairStatus }>('/api/pair/status', { requestId }),
  logout: () => request<null>('/api/logout', {}),
  conversation: (sessionId: string, page: { from?: number | null; before?: number | null; source?: string | null }) =>
    request<{ chunk: Chunk; requests: PermissionRequest[] }>('/api/conversation', { sessionId, from: page.from ?? null, before: page.before ?? null, source: page.source ?? null }, SLOW_TIMEOUT),
  send: (sessionId: string, messageId: string, text: string) => request<unknown>('/api/send', { sessionId, messageId, text }, SLOW_TIMEOUT),
  interrupt: (sessionId: string) => request<unknown>('/api/interrupt', { sessionId }),
  decide: (sessionId: string, requestId: string, decision: Decision) => request<unknown>('/api/decide', { sessionId, requestId, decision }),
  pushKey: () => request<{ publicKey: string }>('/api/push/key'),
  pushSubscribe: (subscription: { endpoint: string; p256dh: string; auth: string }) => request<unknown>('/api/push/subscribe', subscription),
  pushUnsubscribe: () => request<unknown>('/api/push/unsubscribe', {}),
  pushTest: () => request<unknown>('/api/push/test', {}, SLOW_TIMEOUT),
};
