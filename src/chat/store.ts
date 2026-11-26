/**
 * Chat state shared by every view of a session (conversation, split view and mapping), so the same session
 * never has two copies that disagree.
 */
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import type { SessionInfo } from '../store';
import { apply, createBuilder, snapshot, type Adapter, type Builder } from './builder';
import { claudeAdapter, claudeTool } from './claudeAdapter';
import { codexAdapter } from './codexAdapter';
import type { ChatItem, Line, MessageItem, ToolItem, Transcript } from './model';

export type Candidate = { id: string; startedAt: number; preview: string };
export type Chunk = { bound: boolean; reset: boolean; source: string; start: number; end: number; more: boolean; lines: Line[]; candidates: Candidate[] };
export type LiveEvent = {
  event: string; at: number; messageId?: string; index?: number; final?: boolean; delta?: string; toolName?: string; toolUseId?: string;
  toolInput?: unknown; agentId?: string; model?: string; permissionMode?: string; effort?: string; durationMs?: number;
};
export type PermissionRequest = {
  id: string; sessionId: string; toolName: string; toolInput: any; suggestions: any[]; agentId: string | null; createdAt: number;
};
type LiveMessage = { id: string; parts: string[]; at: number };

export type SessionChat = {
  transcript: Transcript;
  start: number;
  end: number;
  source: string;
  bound: boolean;
  loaded: boolean;
  error: string | null;
  candidates: Candidate[];
  messages: LiveMessage[];
  tools: ToolItem[];
  outbox: MessageItem[];
  /** The agent has shown it accepts prompts (hook seen, or the user confirmed it). */
  ready: boolean;
  model?: string;
  permissionMode?: string;
  effort?: string;
  stoppedAt?: number;
  /** Changes whenever something happened that is worth reading the file again right away. */
  tick: number;
};

const EMPTY: SessionChat = {
  transcript: { items: [], meta: { turnOpen: false } }, start: 0, end: 0, source: '', bound: false, loaded: false, error: null, candidates: [],
  messages: [], tools: [], outbox: [], ready: false, tick: 0,
};

/** Conversations kept in memory; older ones are read again from disk when opened. */
const MAX_LOADED = 8;
/** Lines kept per conversation before the oldest are dropped (they can be loaded again). */
const MAX_LINES = 6_000;
const STALE_AFTER_STOP = 10_000;

type Cache = { builder: Builder; lines: Line[]; usedAt: number; busy: boolean };
const caches = new Map<string, Cache>();

const adapterFor = (agent: string): Adapter => (agent === 'Codex' ? codexAdapter : claudeAdapter);

function rebuild(agent: string, lines: Line[]): Builder {
  const builder = createBuilder();
  apply(builder, adapterFor(agent), lines);
  return builder;
}

function cacheFor(id: string): Cache {
  let cache = caches.get(id);
  if (!cache) {
    cache = { builder: createBuilder(), lines: [], usedAt: Date.now(), busy: false };
    caches.set(id, cache);
    if (caches.size > MAX_LOADED) {
      const oldest = [...caches.entries()].filter(([key, item]) => key !== id && !item.busy).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (oldest) {
        caches.delete(oldest[0]);
        useChatStore.setState((state) => { const sessions = { ...state.sessions }; delete sessions[oldest[0]]; return { sessions }; });
      }
    }
  }
  cache.usedAt = Date.now();
  return cache;
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const liveText = (message: LiveMessage) => message.parts.join('');

/** An image placeholder, or an absolute image path (quoted when it has spaces). */
const IMAGE_REFERENCE = /\[Image #\d+\]|"(?:[a-z]:[\\/]|\/)[^"\n]*\.(?:png|jpe?g|gif|webp|bmp)"|(?:[a-z]:[\\/]|\/)[^\s"]*\.(?:png|jpe?g|gif|webp|bmp)/gi;
/** The agents record a sent image path as `[Image #1]`, possibly elsewhere in the text, so user messages are compared without either. */
const typed = (value: string) => value.replace(IMAGE_REFERENCE, '').replace(/\s+/g, '');

/** True when the file already holds this text, written around the same time. */
function recorded(items: ChatItem[], type: 'user' | 'assistant', value: string, since: number, tolerance = 15_000): boolean {
  if (!normalize(value)) return true;
  const comparable = type === 'user' ? typed : normalize;
  const wanted = comparable(value).slice(0, 160);
  for (let index = items.length - 1; index >= 0 && index >= items.length - 60; index--) {
    const item = items[index];
    if (item.type !== type || (item.at !== null && item.at < since - tolerance)) continue;
    const found = comparable(item.text);
    // A message made only of images matches only another one without text.
    if (wanted ? found.includes(wanted) : !found) return true;
  }
  return false;
}

/** Drops live overlays the conversation file has caught up with. */
function reconcile(chat: SessionChat, now = Date.now()): SessionChat {
  const items = chat.transcript.items;
  const ids = new Set(items.map((item) => item.id));
  const stale = chat.stoppedAt !== undefined && now - chat.stoppedAt > STALE_AFTER_STOP;
  const messages = chat.messages.filter((message) => !(stale && message.at <= chat.stoppedAt!) && !recorded(items, 'assistant', liveText(message), message.at));
  const tools = chat.tools.filter((tool) => !ids.has(tool.id) && !(stale && (tool.at ?? 0) <= chat.stoppedAt!));
  const outbox = chat.outbox.filter((message) => !recorded(items, 'user', message.text, message.at ?? 0, 2_000));
  return {
    ...chat,
    // Nothing left to expire once the file caught up.
    stoppedAt: messages.length || tools.length ? chat.stoppedAt : undefined,
    messages: messages.length === chat.messages.length ? chat.messages : messages,
    tools: tools.length === chat.tools.length ? chat.tools : tools,
    outbox: outbox.length === chat.outbox.length ? chat.outbox : outbox,
  };
}

export function applyLiveEvent(chat: SessionChat, event: LiveEvent): SessionChat {
  const next: SessionChat = { ...chat, ready: true };
  if (event.permissionMode) next.permissionMode = event.permissionMode;
  if (event.effort) next.effort = event.effort;
  if (event.model) next.model = event.model;
  switch (event.event) {
    case 'UserPromptSubmit':
      next.messages = []; next.tools = []; next.stoppedAt = undefined; next.tick++;
      break;
    case 'MessageDisplay': {
      if (event.agentId || !event.messageId || typeof event.delta !== 'string') break;
      const position = next.messages.findIndex((message) => message.id === event.messageId);
      const previous = next.messages[position] ?? { id: event.messageId, parts: [], at: event.at };
      // Hooks run in the background, so batches can arrive out of order; the index restores it.
      const parts = previous.parts.slice();
      parts[event.index ?? parts.length] = event.delta;
      const message = { ...previous, parts };
      next.messages = position < 0 ? [...next.messages, message] : next.messages.map((item, index) => (index === position ? message : item));
      if (event.final) next.tick++;
      break;
    }
    case 'PreToolUse':
      if (event.agentId || !event.toolUseId || next.tools.some((tool) => tool.id === event.toolUseId)) break;
      next.tools = [...next.tools, claudeTool(event.toolUseId, event.toolName ?? 'Ferramenta', event.toolInput, event.at, null)];
      next.tick++;
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      next.tools = next.tools.map((tool) => (tool.id === event.toolUseId ? { ...tool, status: event.event === 'PostToolUse' ? 'done' : 'failed', durationMs: event.durationMs } : tool));
      next.tick++;
      break;
    case 'Stop':
    case 'StopFailure':
      next.stoppedAt = event.at;
      next.tools = next.tools.map((tool) => (tool.status === 'running' ? { ...tool, status: 'cancelled' } : tool));
      next.tick++;
      break;
    default:
      next.tick++;
  }
  return reconcile(next);
}

/** What the conversation shows: the file, followed by what has only been announced live. */
export function composeItems(chat: SessionChat): ChatItem[] {
  if (!chat.messages.length && !chat.tools.length && !chat.outbox.length) return chat.transcript.items;
  const live: ChatItem[] = [
    ...chat.outbox,
    ...chat.messages.map((message): ChatItem => ({ type: 'assistant', id: `live:${message.id}`, at: message.at, offset: null, text: liveText(message), streaming: true })),
    ...chat.tools,
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return [...chat.transcript.items, ...live];
}

type ChatStore = {
  sessions: Record<string, SessionChat>;
  permissions: PermissionRequest[];
};

export const useChatStore = create<ChatStore>(() => ({ sessions: {}, permissions: [] }));

function update(id: string, change: (chat: SessionChat) => SessionChat) {
  useChatStore.setState((state) => {
    const current = state.sessions[id] ?? EMPTY;
    const next = change(current);
    return next === current && state.sessions[id] ? state : { sessions: { ...state.sessions, [id]: next } };
  });
}

export const sessionChat = (state: ChatStore, id: string) => state.sessions[id] ?? EMPTY;

export function receiveLive(batch: { sessionId: string; event: LiveEvent }[]) {
  useChatStore.setState((state) => {
    const sessions = { ...state.sessions };
    for (const { sessionId, event } of batch) sessions[sessionId] = applyLiveEvent(sessions[sessionId] ?? EMPTY, event);
    return { sessions };
  });
}

/** Applies a page of the conversation file. Returns whether more lines are already waiting. */
export function receiveChunk(id: string, agent: string, chunk: Chunk, earlier = false): boolean {
  const cache = cacheFor(id);
  const current = useChatStore.getState().sessions[id] ?? EMPTY;
  const replaced = chunk.reset || (current.source !== '' && chunk.source !== '' && chunk.source !== current.source);
  const first = !current.loaded || replaced;
  let changed = replaced;
  if (replaced) { cache.builder = createBuilder(); cache.lines = []; }
  let start = first ? chunk.start : current.start;
  const end = earlier ? current.end : chunk.end;
  if (earlier) {
    cache.lines = [...chunk.lines, ...cache.lines];
    cache.builder = rebuild(agent, cache.lines);
    start = chunk.start;
    changed = true;
  } else if (chunk.lines.length) {
    cache.lines.push(...chunk.lines);
    apply(cache.builder, adapterFor(agent), chunk.lines);
    changed = true;
    if (cache.lines.length > MAX_LINES) {
      cache.lines = cache.lines.slice(-Math.floor(MAX_LINES * 0.8));
      cache.builder = rebuild(agent, cache.lines);
      start = cache.lines[0].o;
    }
  }
  const candidatesChanged = chunk.candidates.length !== current.candidates.length || chunk.candidates.some((item, index) => item.id !== current.candidates[index].id);
  const unchanged = !changed && current.loaded && current.bound === chunk.bound && current.source === chunk.source && current.end === end && !candidatesChanged && !current.error
    && current.stoppedAt === undefined;
  if (unchanged) return chunk.more;
  update(id, (chat) => reconcile({
    ...chat,
    ...(replaced ? { messages: [], tools: [] } : null),
    transcript: changed ? snapshot(cache.builder) : chat.transcript,
    bound: chunk.bound, source: chunk.source || (replaced ? '' : chat.source), start, end, loaded: chunk.bound, error: null,
    candidates: candidatesChanged ? chunk.candidates : chat.candidates,
  }));
  return chunk.more;
}

export async function readSession(session: SessionInfo): Promise<void> {
  const cache = cacheFor(session.id);
  if (cache.busy) return;
  cache.busy = true;
  try {
    for (let page = 0; page < 40; page++) {
      const chat = useChatStore.getState().sessions[session.id] ?? EMPTY;
      const chunk = await invoke<Chunk>('chat_read', { sessionId: session.id, from: chat.loaded ? chat.end : null, before: null, source: chat.source || null });
      if (!receiveChunk(session.id, session.agent, chunk)) break;
    }
  } catch (error) {
    update(session.id, (chat) => (chat.error === String(error) ? chat : { ...chat, error: String(error) }));
  } finally { cache.busy = false; }
}

export async function loadEarlier(session: SessionInfo): Promise<void> {
  const cache = cacheFor(session.id);
  const chat = useChatStore.getState().sessions[session.id];
  if (!chat || cache.busy || chat.start <= 0) return;
  cache.busy = true;
  try {
    const chunk = await invoke<Chunk>('chat_read', { sessionId: session.id, from: null, before: chat.start, source: chat.source || null });
    receiveChunk(session.id, session.agent, chunk, !chunk.reset);
  } catch (error) {
    update(session.id, (current) => ({ ...current, error: String(error) }));
  } finally { cache.busy = false; }
}

export function addOutbox(id: string, body: string) {
  const at = Date.now();
  update(id, (chat) => ({ ...chat, tick: chat.tick + 1, outbox: [...chat.outbox, { type: 'user', id: `outbox:${at}`, at, offset: null, text: body, pending: true }] }));
}

export const markReady = (id: string) => update(id, (chat) => ({ ...chat, ready: true }));

export function forgetChat(id: string) {
  caches.delete(id);
  useChatStore.setState((state) => { const sessions = { ...state.sessions }; delete sessions[id]; return { sessions }; });
}
