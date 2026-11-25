/** Arranges items into what the conversation draws: messages, folded action groups and change summaries. */
import type { ChatItem, FileChange, MessageItem, NoticeItem, PullRequestItem, ToolItem } from './model';

export type Block =
  | { type: 'user'; id: string; item: MessageItem }
  | { type: 'assistant'; id: string; item: MessageItem; lead: boolean }
  | { type: 'tools'; id: string; tools: ToolItem[] }
  | { type: 'changes'; id: string; changes: FileChange[] }
  | { type: 'notice'; id: string; item: NoticeItem }
  | { type: 'pr'; id: string; item: PullRequestItem };

export function buildBlocks(items: ChatItem[]): Block[] {
  const blocks: Block[] = [];
  let tools: ToolItem[] = [];
  let changes: FileChange[] = [];
  let changesFrom = '';
  let lead = true;
  const flushTools = () => {
    if (tools.length) blocks.push({ type: 'tools', id: `tools:${tools[0].id}`, tools });
    tools = [];
  };
  const endTurn = () => {
    flushTools();
    if (changes.length) blocks.push({ type: 'changes', id: `changes:${changesFrom}`, changes });
    changes = [];
  };
  for (const item of items) {
    if (item.type === 'tool') {
      tools.push(item);
      if (item.changes?.length) {
        if (!changes.length) changesFrom = item.id;
        changes.push(...item.changes);
      }
      continue;
    }
    if (item.type === 'user') {
      endTurn();
      blocks.push({ type: 'user', id: item.id, item });
      lead = true;
      continue;
    }
    flushTools();
    if (item.type === 'assistant') {
      blocks.push({ type: 'assistant', id: item.id, item, lead });
      lead = false;
    } else if (item.type === 'notice') blocks.push({ type: 'notice', id: item.id, item });
    else if (item.type === 'pr') blocks.push({ type: 'pr', id: item.id, item });
  }
  endTurn();
  return blocks;
}

const shallowEqual = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Reuses the previous array of an unchanged group so memoized components skip it. */
export function stableBlocks(previous: Block[], next: Block[]): Block[] {
  const old = new Map(previous.map((block) => [block.id, block]));
  return next.map((block) => {
    const before = old.get(block.id);
    if (!before || before.type !== block.type) return block;
    if (block.type === 'tools') return shallowEqual((before as typeof block).tools, block.tools) ? before : block;
    if (block.type === 'changes') return shallowEqual((before as typeof block).changes, block.changes) ? before : block;
    if (block.type === 'assistant') return (before as typeof block).item === block.item && (before as typeof block).lead === block.lead ? before : block;
    return (before as Extract<Block, { item: ChatItem }>).item === block.item ? before : block;
  });
}

export function itemText(item: ChatItem): string {
  if (item.type === 'tool') return [item.name, item.target, item.description, item.command, item.output, item.stderr, item.filePath].filter(Boolean).join('\n');
  if (item.type === 'notice') return `${item.text}\n${item.detail ?? ''}`;
  if (item.type === 'pr') return `Pull request #${item.number} ${item.repository}`;
  return item.text;
}

export function findMatches(items: ChatItem[], query: string): string[] {
  const wanted = query.trim().toLocaleLowerCase('pt-BR');
  return wanted ? items.filter((item) => itemText(item).toLocaleLowerCase('pt-BR').includes(wanted)).map((item) => item.id) : [];
}
