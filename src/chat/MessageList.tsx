import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, History } from 'lucide-react';
import type { Block } from './blocks';
import { AssistantMessage, Notice, PullRequest, UserMessage } from './Messages';
import { ChangeSummary, ToolGroup, type ChatScope } from './Tools';

const PAGE = 120;
const NEAR_BOTTOM = 80;
/** Reading position of each session while the app is open; absent means following the newest message. */
const positions = new Map<string, number>();

const BlockView = memo(function BlockView({ block, agent, scope, busy, matchId, onReuse }: {
  block: Block; agent: string; scope: ChatScope; busy: boolean; matchId?: string; onReuse: (text: string) => void;
}) {
  const matched = matchId !== undefined && (block.type === 'tools' ? block.tools.some((tool) => tool.id === matchId) : block.type !== 'changes' && block.item.id === matchId);
  return <div className={`chat-block block-${block.type} ${matched ? 'matched' : ''}`} data-matched={matched || undefined}>
    {block.type === 'user' ? <UserMessage item={block.item} scope={scope} busy={busy} onReuse={onReuse} />
      : block.type === 'assistant' ? <AssistantMessage item={block.item} agent={agent} scope={scope} lead={block.lead} />
      : block.type === 'tools' ? <ToolGroup tools={block.tools} scope={scope} matchId={matched ? matchId : undefined} />
      : block.type === 'changes' ? <ChangeSummary changes={block.changes} scope={scope} />
      : block.type === 'notice' ? <Notice item={block.item} scope={scope} />
      : <PullRequest item={block.item} scope={scope} />}
  </div>;
});

export function MessageList({ blocks, agent, scope, busy, matchId, hasEarlier, onLoadEarlier, onReuse, children }: {
  blocks: Block[]; agent: string; scope: ChatScope; busy: boolean; matchId?: string; hasEarlier: boolean;
  onLoadEarlier: () => void; onReuse: (text: string) => void; children?: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(!positions.has(scope.sessionId));
  const restore = useRef<number | undefined>(positions.get(scope.sessionId));
  /** Distance from the bottom to keep while older messages are inserted above. */
  const anchor = useRef<number | null>(null);
  const [away, setAway] = useState(!following.current);
  const [limit, setLimit] = useState(PAGE);
  const matchIndex = matchId === undefined ? -1 : blocks.findIndex((block) => (block.type === 'tools' ? block.tools.some((tool) => tool.id === matchId) : block.type !== 'changes' && block.item.id === matchId));
  const first = Math.max(0, Math.min(blocks.length - limit, matchIndex < 0 ? Infinity : matchIndex));
  const visible = blocks.slice(first);

  const toBottom = () => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  };
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (anchor.current !== null) {
      box.scrollTop = box.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (restore.current !== undefined && blocks.length) {
      box.scrollTop = restore.current;
      restore.current = undefined;
    } else if (following.current) toBottom();
  }, [blocks, first, children]);
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    // Text that grows after rendering (images, expanded output) must not push the newest line away.
    const observer = new ResizeObserver(() => { if (following.current) toBottom(); });
    observer.observe(content.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (matchId === undefined) return;
    following.current = false;
    setAway(true);
    const frame = requestAnimationFrame(() => scroller.current?.querySelector('[data-matched]')?.scrollIntoView?.({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [matchId]);

  const onScroll = () => {
    const box = scroller.current;
    if (!box || !box.clientHeight) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    following.current = near;
    setAway(!near);
    if (near) positions.delete(scope.sessionId);
    else positions.set(scope.sessionId, box.scrollTop);
  };
  const older = () => {
    const box = scroller.current;
    if (box) anchor.current = box.scrollHeight - box.scrollTop;
    following.current = false;
    setLimit((current) => current + PAGE);
    if (first === 0) onLoadEarlier();
  };

  return <div className="chat-scroll-area">
    <div className="chat-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Conversa">
      <div className="chat-column" ref={content}>
        {(first > 0 || hasEarlier) && <button type="button" className="chat-earlier" onClick={older}><History size={13} /> Mostrar mensagens anteriores</button>}
        {visible.map((block) => <BlockView key={block.id} block={block} agent={agent} scope={scope} busy={busy} matchId={matchId} onReuse={onReuse} />)}
        {children}
      </div>
    </div>
    {away && <button type="button" className="chat-to-bottom" onClick={() => { following.current = true; positions.delete(scope.sessionId); setAway(false); toBottom(); }}><ArrowDown size={14} /> Ir para o fim</button>}
  </div>;
}
