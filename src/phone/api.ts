/** Requests to the desktop app. The device cookie travels with them automatically. */
export type AgentCard = { id: string; agent: string; title: string | null; project: string | null; folder: string; tone: string; label: string; message: string; since: number | null };
export type Overview = { computer: string; theme: string | null; agents: AgentCard[] };
export type PairStatus = 'waiting' | 'paired' | 'denied' | 'expired';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const TIMEOUT = 10_000;

async function request<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT);
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
};
