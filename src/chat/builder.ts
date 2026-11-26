import type { ChatItem, Line, ToolItem, Transcript, TranscriptMeta } from './model';

/**
 * Accumulates conversation items incrementally. Items are replaced, never mutated, so the interface can
 * skip everything that did not change.
 */
export type Builder = {
  items: ChatItem[];
  index: Map<string, number>;
  /** Record identifiers already applied, so a repeated line changes nothing. */
  seen: Set<string>;
  meta: TranscriptMeta;
  /** Codex releases with completed items make the finished call records redundant. */
  richItems: boolean;
  /** Codex commands that outlived their call: later records refer to them by cell number. */
  cells: Map<string, string>;
  /** Item that a later call record continues, by that call's identifier. */
  calls: Map<string, string>;
};

export type Adapter = (builder: Builder, line: Line) => void;

export const createBuilder = (): Builder => ({ items: [], index: new Map(), seen: new Set(), meta: { turnOpen: false }, richItems: false, cells: new Map(), calls: new Map() });

export function put(builder: Builder, item: ChatItem) {
  const position = builder.index.get(item.id);
  if (position === undefined) {
    builder.index.set(item.id, builder.items.length);
    builder.items.push(item);
  } else builder.items[position] = item;
}

export function toolAt(builder: Builder, id: string): ToolItem | undefined {
  const position = builder.index.get(id);
  const item = position === undefined ? undefined : builder.items[position];
  return item?.type === 'tool' ? item : undefined;
}

/** Tools still waiting for a result when the turn is interrupted did not finish. */
export function cancelRunning(builder: Builder) {
  for (let index = builder.items.length - 1; index >= 0; index--) {
    const item = builder.items[index];
    if (item.type === 'user') break;
    if (item.type === 'tool' && item.status === 'running') builder.items[index] = { ...item, status: 'cancelled' };
  }
}

export function snapshot(builder: Builder): Transcript {
  const items = builder.richItems ? builder.items.filter((item) => item.type !== 'tool' || !item.fallback || item.status === 'running') : builder.items.slice();
  return { items, meta: { ...builder.meta } };
}

export function apply(builder: Builder, adapter: Adapter, lines: Line[]) {
  for (const line of lines) {
    // One malformed record must not hide the rest of the conversation.
    try { adapter(builder, line); } catch (error) { console.warn('Registro de conversa ignorado:', error); }
  }
}

export const time = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Joins the text blocks of a message or tool result. */
export function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && typeof block.text === 'string' && /text/i.test(String(block.type)) ? block.text : '')).filter(Boolean).join('\n');
}
