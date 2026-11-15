/** Conversations indexed from `~/.claude/projects` and `~/.codex/sessions` (see `history.rs`). */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Conversation = {
  id: string; agent: string; folder: string; title: string; startedAt: number; updatedAt: number;
  prompts: number; tokens: Tokens; costUsd: number | null; model: string | null; snippet?: string | null;
};
export type PreviewMessage = { role: 'user' | 'assistant'; text: string; at: number | null };
export type UsageBucket = { hour: number; agent: string; folder: string; tokens: Tokens };
export type UsageReport = {
  buckets: UsageBucket[];
  top: { id: string; agent: string; folder: string; title: string; tokens: Tokens; costUsd: number | null; updatedAt: number }[];
  claudeCostUsd: number;
  conversations: number;
};

export const USAGE_AGENTS = ['Claude Code', 'Codex'] as const;

export const totalTokens = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

/** 950 → "950", 12 400 → "12,4 mil", 3 200 000 → "3,2 mi", 1,5 bi. */
export function compactTokens(value: number): string {
  const format = (number: number, unit: string) => `${number.toLocaleString('pt-BR', { maximumFractionDigits: number < 10 ? 1 : 0 })} ${unit}`;
  if (value >= 1e9) return format(value / 1e9, 'bi');
  if (value >= 1e6) return format(value / 1e6, 'mi');
  if (value >= 1e3) return format(value / 1e3, 'mil');
  return String(value);
}

export const formatUsd = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 10 ? 2 : 0 });

/** Local calendar day (YYYY-MM-DD) of a millisecond timestamp. */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export type DayUsage = { day: string; byAgent: Record<string, number>; total: number };

/** One entry per local day of the period, oldest first, including days without usage. */
export function usageByDay(buckets: UsageBucket[], days: number, now = Date.now()): DayUsage[] {
  const result: DayUsage[] = [];
  const index = new Map<string, DayUsage>();
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today); date.setDate(today.getDate() - offset);
    const entry: DayUsage = { day: dayKey(date.getTime()), byAgent: {}, total: 0 };
    result.push(entry);
    index.set(entry.day, entry);
  }
  for (const bucket of buckets) {
    const entry = index.get(dayKey(bucket.hour * 3_600_000));
    if (!entry) continue;
    const value = totalTokens(bucket.tokens);
    entry.byAgent[bucket.agent] = (entry.byAgent[bucket.agent] ?? 0) + value;
    entry.total += value;
  }
  return result;
}

export type FolderUsage = { folder: string; byAgent: Record<string, number>; total: number };

export function usageByFolder(buckets: UsageBucket[]): FolderUsage[] {
  const map = new Map<string, FolderUsage>();
  for (const bucket of buckets) {
    const key = bucket.folder.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
    const entry = map.get(key) ?? { folder: bucket.folder, byAgent: {}, total: 0 };
    const value = totalTokens(bucket.tokens);
    entry.byAgent[bucket.agent] = (entry.byAgent[bucket.agent] ?? 0) + value;
    entry.total += value;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}
