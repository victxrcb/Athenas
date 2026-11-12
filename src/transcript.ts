/**
 * Turns a worker transcript (Codex `exec --json` events, Claude `-p --output-format json|stream-json`,
 * or plain stderr) into typed entries so the board can tell messages, commands, tools and logs apart.
 */
export type TranscriptEntry =
  | { kind: 'message'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'command'; id: string; command: string; output: string; exitCode: number | null; running: boolean }
  | { kind: 'files'; id: string; changes: { path: string; kind: string }[] }
  | { kind: 'tool'; id: string; name: string; detail: string; output: string; running: boolean; failed: boolean }
  | { kind: 'todo'; id: string; items: { text: string; done: boolean }[] }
  | { kind: 'result'; id: string; text: string; failed: boolean; meta: string[] }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'log'; id: string; text: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2));
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function toolContent(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : text(part))).join('\n');
  return text(content);
}

function summarizeInput(input: unknown): string {
  if (!isObject(input)) return text(input);
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return JSON.stringify(input);
}

export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const byId = new Map<string, number>();
  let log: string[] = [];
  let counter = 0;
  const nextId = () => `e${counter++}`;
  const flushLog = () => {
    if (log.length) entries.push({ kind: 'log', id: nextId(), text: log.join('\n') });
    log = [];
  };
  const upsert = (key: string, entry: TranscriptEntry) => {
    const index = byId.get(key);
    if (index === undefined) { byId.set(key, entries.length); entries.push(entry); }
    else entries[index] = { ...entry, id: entries[index].id };
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try { event = trimmed.startsWith('{') ? JSON.parse(trimmed) : undefined; } catch { event = undefined; }
    if (!isObject(event)) { log.push(line); continue; }
    flushLog();
    const type = event.type;

    // Codex: item.started / item.updated / item.completed carry the same item id.
    if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && isObject(event.item)) {
      const item = event.item;
      const key = `codex:${text(item.id) || nextId()}`;
      const done = type === 'item.completed';
      switch (item.type) {
        case 'agent_message': upsert(key, { kind: 'message', id: nextId(), text: text(item.text) }); break;
        case 'reasoning': upsert(key, { kind: 'reasoning', id: nextId(), text: text(item.text) }); break;
        case 'command_execution':
          upsert(key, { kind: 'command', id: nextId(), command: text(item.command), output: text(item.aggregated_output),
            exitCode: num(item.exit_code), running: !done && item.status !== 'completed' && item.status !== 'failed' });
          break;
        case 'file_change':
          upsert(key, { kind: 'files', id: nextId(), changes: Array.isArray(item.changes)
            ? item.changes.filter(isObject).map((change) => ({ path: text(change.path), kind: text(change.kind) || 'update' })) : [] });
          break;
        case 'mcp_tool_call':
          upsert(key, { kind: 'tool', id: nextId(), name: [text(item.server), text(item.tool)].filter(Boolean).join(' · ') || 'MCP',
            detail: item.arguments === undefined ? '' : summarizeInput(item.arguments), output: item.result === undefined ? '' : toolContent(item.result),
            running: !done, failed: item.status === 'failed' });
          break;
        case 'web_search':
          upsert(key, { kind: 'tool', id: nextId(), name: 'Busca na web', detail: text(item.query), output: '', running: !done, failed: false });
          break;
        case 'todo_list':
          upsert(key, { kind: 'todo', id: nextId(), items: Array.isArray(item.items)
            ? item.items.filter(isObject).map((todo) => ({ text: text(todo.text), done: todo.completed === true })) : [] });
          break;
        case 'error': upsert(key, { kind: 'error', id: nextId(), text: text(item.message) }); break;
        default: upsert(key, { kind: 'log', id: nextId(), text: trimmed });
      }
      continue;
    }
    if (type === 'turn.completed' && isObject(event.usage)) {
      const usage = event.usage;
      const meta = [`${num(usage.input_tokens) ?? 0} tokens de entrada`, `${num(usage.output_tokens) ?? 0} de saída`];
      entries.push({ kind: 'result', id: nextId(), text: '', failed: false, meta });
      continue;
    }
    if (type === 'turn.failed') { entries.push({ kind: 'error', id: nextId(), text: text(isObject(event.error) ? event.error.message : event.error) || 'Turno falhou.' }); continue; }
    if (type === 'error') { entries.push({ kind: 'error', id: nextId(), text: text(event.message) }); continue; }
    if (type === 'thread.started' || type === 'turn.started') continue;

    // Claude stream-json: assistant turns hold text and tool_use blocks; user turns hold tool_result.
    if ((type === 'assistant' || type === 'user') && isObject(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isObject(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) entries.push({ kind: 'message', id: nextId(), text: block.text });
        else if (block.type === 'thinking' && typeof block.thinking === 'string') entries.push({ kind: 'reasoning', id: nextId(), text: block.thinking });
        else if (block.type === 'tool_use') {
          const name = text(block.name);
          const key = `claude:${text(block.id)}`;
          if (name === 'Bash' && isObject(block.input)) upsert(key, { kind: 'command', id: nextId(), command: text(block.input.command), output: '', exitCode: null, running: true });
          else upsert(key, { kind: 'tool', id: nextId(), name, detail: summarizeInput(block.input), output: '', running: true, failed: false });
        } else if (block.type === 'tool_result') {
          const index = byId.get(`claude:${text(block.tool_use_id)}`);
          const target = index === undefined ? undefined : entries[index];
          const output = toolContent(block.content);
          const failed = block.is_error === true;
          if (target?.kind === 'command') entries[index!] = { ...target, output, running: false, exitCode: failed ? 1 : 0 };
          else if (target?.kind === 'tool') entries[index!] = { ...target, output, running: false, failed };
        }
      }
      continue;
    }
    if (type === 'system') continue;

    // Claude json / stream-json final summary.
    if (type === 'result') {
      const meta: string[] = [];
      const duration = num(event.duration_ms);
      const turns = num(event.num_turns);
      const cost = num(event.total_cost_usd);
      if (duration !== null) meta.push(`${(duration / 1000).toFixed(1)} s`);
      if (turns !== null) meta.push(`${turns} ${turns === 1 ? 'turno' : 'turnos'}`);
      if (cost !== null) meta.push(`$${cost.toFixed(4)}`);
      if (Array.isArray(event.permission_denials) && event.permission_denials.length) meta.push(`${event.permission_denials.length} permissão(ões) negada(s)`);
      entries.push({ kind: 'result', id: nextId(), text: text(event.result), failed: event.is_error === true, meta });
      continue;
    }
    entries.push({ kind: 'log', id: nextId(), text: trimmed });
  }
  flushLog();
  return entries;
}

/** Splits a unified diff into per-file sections with typed lines. */
export type DiffLine = { kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'; text: string };
export type DiffFile = { path: string; added: number; removed: number; lines: DiffLine[] };

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: match?.[2] ?? line.slice(11), added: 0, removed: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      if (!line) continue;
      current = { path: 'alterações', added: 0, removed: 0, lines: [] };
      files.push(current);
    }
    if (line.startsWith('@@')) current.lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+++') || line.startsWith('---') || /^(index|new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(line)) current.lines.push({ kind: 'meta', text: line });
    else if (line.startsWith('+')) { current.added++; current.lines.push({ kind: 'add', text: line }); }
    else if (line.startsWith('-')) { current.removed++; current.lines.push({ kind: 'del', text: line }); }
    else current.lines.push({ kind: 'context', text: line });
  }
  for (const file of files) while (file.lines.length && file.lines.at(-1)?.kind === 'context' && !file.lines.at(-1)?.text) file.lines.pop();
  return files;
}
