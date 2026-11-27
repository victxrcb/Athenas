/** Reads one agent's conversation from the computer, with the same adapters the desktop chat uses. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apply, createBuilder, snapshot, type Builder } from '../chat/builder';
import { claudeAdapter } from '../chat/claudeAdapter';
import { codexAdapter } from '../chat/codexAdapter';
import type { ChatItem, Line } from '../chat/model';
import { ApiError, api, type Chunk, type PermissionRequest } from './api';

const REFRESH = 1_500;
/** Pages read in a row when the file grew a lot since the last look. */
const MAX_PAGES = 20;

export type Conversation = {
  items: ChatItem[];
  requests: PermissionRequest[];
  loaded: boolean;
  /** The computer knows which file this session writes. */
  bound: boolean;
  /** Several Codex conversations could be this one; the choice is made on the computer. */
  ambiguous: boolean;
  hasEarlier: boolean;
  offline: boolean;
  /** Why nothing can be shown any more. */
  refusal: string | null;
};

const EMPTY: Conversation = { items: [], requests: [], loaded: false, bound: false, ambiguous: false, hasEarlier: false, offline: false, refusal: null };

type Cache = { builder: Builder; lines: Line[]; source: string; start: number; end: number; loaded: boolean };
const emptyCache = (): Cache => ({ builder: createBuilder(), lines: [], source: '', start: 0, end: 0, loaded: false });

export function mergeChunk(cache: Cache, agent: string, chunk: Chunk, earlier = false): { cache: Cache; changed: boolean } {
  const adapter = agent === 'Codex' ? codexAdapter : claudeAdapter;
  const replaced = chunk.reset || (cache.source !== '' && chunk.source !== '' && chunk.source !== cache.source);
  const base = replaced ? emptyCache() : cache;
  const first = !base.loaded;
  if (earlier && !replaced) {
    const lines = [...chunk.lines, ...base.lines];
    const builder = createBuilder();
    apply(builder, adapter, lines);
    return { cache: { ...base, builder, lines, start: chunk.start }, changed: true };
  }
  if (chunk.lines.length) {
    base.lines.push(...chunk.lines);
    apply(base.builder, adapter, chunk.lines);
  }
  return {
    cache: { ...base, source: chunk.source || base.source, start: first ? chunk.start : base.start, end: chunk.end, loaded: chunk.bound },
    changed: replaced || chunk.lines.length > 0,
  };
}

export function useConversation(sessionId: string, agent: string, onUnauthorized: () => void) {
  const [state, setState] = useState<Conversation>(EMPTY);
  const cache = useRef<Cache>(emptyCache());
  /** Reads run one after another, so a page is never applied twice. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const read = useCallback((earlier = false) => {
    const run = async () => {
      try {
        for (let page = 0; page < MAX_PAGES && alive.current; page++) {
          const known = cache.current;
          const { chunk, requests } = await api.conversation(sessionId, earlier
            ? { before: known.start, source: known.source }
            : { from: known.loaded ? known.end : null, source: known.source || null });
          if (!alive.current) return;
          const merged = mergeChunk(known, agent, chunk, earlier);
          cache.current = merged.cache;
          setState((current) => ({
            items: merged.changed ? snapshot(merged.cache.builder).items : current.items,
            requests,
            loaded: true,
            bound: chunk.bound,
            ambiguous: !chunk.bound && chunk.candidates.length > 0,
            hasEarlier: chunk.bound && merged.cache.start > 0,
            offline: false,
            refusal: null,
          }));
          if (earlier || !chunk.more) break;
        }
      } catch (failure) {
        if (!alive.current) return;
        if (failure instanceof ApiError && failure.status === 401) unauthorized.current();
        else if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) setState((current) => ({ ...current, requests: [], refusal: failure.message }));
        else setState((current) => ({ ...current, offline: true }));
      }
    };
    queue.current = queue.current.then(run);
    return queue.current;
  }, [sessionId, agent]);

  useEffect(() => {
    alive.current = true;
    let timer = 0;
    const loop = async () => {
      if (document.visibilityState === 'visible') await read();
      if (alive.current) timer = window.setTimeout(loop, REFRESH);
    };
    void loop();
    const wake = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', wake);
    return () => { alive.current = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [read]);

  return { ...state, refresh: useCallback(() => void read(), [read]), loadEarlier: useCallback(() => void read(true), [read]) };
}
