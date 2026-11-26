import { blocksText, cancelRunning, put, text, time, toolAt, type Builder } from './builder';
import { hunkStats, parseUnifiedDiff } from './diff';
import type { FileChange, Line, ToolItem, ToolStatus } from './model';

const status = (value: unknown, exit?: unknown): ToolStatus => {
  if (value === 'failed' || (typeof exit === 'number' && exit !== 0)) return 'failed';
  if (value === 'declined' || value === 'aborted' || value === 'interrupted') return 'cancelled';
  return value === 'in_progress' ? 'running' : 'done';
};

const duration = (value: any): number | undefined => (typeof value?.secs === 'number' ? value.secs * 1000 + Math.round((value.nanos ?? 0) / 1e6) : undefined);

/** `["powershell.exe", "-Command", "npm test"]` → `npm test`; other forms are shown as they ran. */
export function commandText(command: unknown): string {
  if (!Array.isArray(command)) return text(command);
  const flag = command.findIndex((part) => /^(-command|-c|-lc|\/c)$/i.test(String(part)));
  return flag > 0 && flag === command.length - 2 ? String(command[flag + 1]) : command.map(String).join(' ');
}

export function codexChanges(changes: unknown): FileChange[] {
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes as Record<string, any>).map(([path, change]) => {
    const type: FileChange['type'] = change?.type === 'add' || change?.type === 'delete' ? change.type : 'update';
    const hunks = type === 'update'
      ? parseUnifiedDiff(text(change?.unified_diff))
      : [{ oldStart: type === 'delete' ? 1 : 0, newStart: type === 'add' ? 1 : 0, lines: text(change?.content).replace(/\n$/, '').split('\n').map((line) => `${type === 'add' ? '+' : '-'}${line}`) }];
    return { path, type, hunks, movedTo: text(change?.move_path) || undefined, ...hunkStats(hunks) };
  });
}

function completedItem(builder: Builder, item: any, line: Line, at: number | null) {
  if (!item || typeof item !== 'object') return;
  builder.richItems = true;
  const id = text(item.id) || `o${line.o}`;
  const base = { id, at, offset: line.o, clipped: line.clipped };
  const tool = (fields: Omit<ToolItem, 'type' | 'id' | 'at' | 'offset' | 'clipped'>) => put(builder, { type: 'tool', ...base, ...fields });
  switch (item.type) {
    case 'UserMessage': {
      const body = blocksText(item.content);
      if (!body.trim() || body.trimStart().startsWith('<')) return;
      addMessage(builder, 'user', body, base);
      break;
    }
    case 'AgentMessage': {
      const body = blocksText(item.content);
      if (body.trim()) addMessage(builder, 'assistant', body, base);
      break;
    }
    case 'CommandExecution': {
      const command = commandText(item.command);
      tool({ name: 'Comando', kind: 'command', target: command, command, cwd: text(item.cwd) || undefined, status: status(item.status, item.exit_code), output: text(item.aggregated_output), exitCode: typeof item.exit_code === 'number' ? item.exit_code : undefined, durationMs: duration(item.duration), input: { command: item.command } });
      break;
    }
    case 'FileChange': {
      const changes = codexChanges(item.changes);
      tool({ name: 'Alteração de arquivos', kind: 'edit', target: changes.map((change) => change.path).join(', '), filePath: changes[0]?.path, status: status(item.status), changes: item.status === 'failed' ? undefined : changes, output: text(item.stdout), stderr: text(item.stderr) || undefined });
      break;
    }
    case 'McpToolCall':
      tool({ name: 'MCP', kind: 'mcp', target: `${text(item.server)} · ${text(item.tool)}`, status: status(item.status), input: item.arguments, output: blocksText(item.result?.content) || (item.error ? JSON.stringify(item.error) : ''), durationMs: duration(item.duration) });
      break;
    case 'Extension':
    case 'WebSearch': {
      const web = String(item.kind ?? item.type).toLowerCase().includes('web');
      tool({ name: text(item.kind) || 'Extensão', kind: web ? 'web' : 'other', target: text(item.query) || text(item.action?.url) || text(item.revisedPrompt) || text(item.kind), status: status(item.status), output: Array.isArray(item.results) ? item.results.map((result: any) => [result.title, result.url].filter(Boolean).join(' — ')).filter(Boolean).join('\n') : text(item.savedPath) });
      break;
    }
    case 'ImageView':
      tool({ name: 'Imagem', kind: 'read', target: text(item.path), filePath: text(item.path) || undefined, status: 'done' });
      break;
    case 'ContextCompaction':
      put(builder, { type: 'notice', ...base, tone: 'info', text: 'Conversa compactada' });
      break;
    case 'Reasoning':
      break;
    default:
      tool({ name: text(item.type), kind: 'other', target: '', status: status(item.status), input: item });
  }
}

const STRING_LITERAL = /\b(?:cmd|command)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/;
const PATCHED_FILE = /\*\*\* (?:Add|Update|Delete) File: (.+?)(?=\\r|\\n|["'`\r\n]|$)/gm;
const BACKGROUND = 'um comando em execução';

const unquote = (literal: string) => literal.slice(1, -1).replace(/\\(.)/g, (_, char) => (char === 'n' ? '\n' : char === 't' ? '\t' : char));

type CallSummary = Pick<ToolItem, 'kind' | 'target'> & { command?: string; filePath?: string };

/**
 * What an unfinished call is doing. Recent releases wrap every tool in a script run by `exec`, so the
 * tools it names are read from the script; older ones record the tool and its arguments directly.
 */
export function describeCall(name: string, raw: string): CallSummary {
  const script = [...raw.matchAll(/\btools\.([\w-]+)\s*\(/g)];
  const tool = name === 'exec' ? script[0]?.[1] ?? '' : name;
  const more = script.length > 1 ? ` (+${script.length - 1})` : '';
  if (tool === 'apply_patch') {
    const files = [...raw.matchAll(PATCHED_FILE)].map((match) => match[1].replace(/\\\\/g, '\\'));
    return { kind: 'edit', target: files.length > 1 ? `${files.length} arquivos` : files[0] ?? 'arquivos', filePath: files.length === 1 ? files[0] : undefined };
  }
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    return { kind: 'mcp', target: `${server} · ${rest.join('__')}${more}` };
  }
  if (tool === 'web__run') return { kind: 'web', target: `a web${more}` };
  if (tool === 'write_stdin') return { kind: 'other', target: BACKGROUND };
  let command = '';
  const literal = STRING_LITERAL.exec(name === 'exec' ? raw.slice(script[0]?.index ?? raw.length) : '');
  if (literal) command = unquote(literal[1]);
  else if (name !== 'exec') {
    try { const input = JSON.parse(raw); command = commandText(input.cmd ?? input.command ?? input.action?.command); } catch { /* not a command */ }
  }
  if (command) return { kind: 'command', target: `${command}${more}`, command };
  // The command is built at run time, so the script does not show it.
  if (tool === 'exec_command') return { kind: 'other', target: `comandos no terminal${more}` };
  return { kind: 'other', target: tool || 'um script' };
}

/** Marks the call records still open when their turn ends. */
function finishCalls(builder: Builder) {
  builder.items.forEach((item, index) => {
    if (item.type === 'tool' && item.fallback && item.status === 'running') builder.items[index] = { ...item, status: 'done' };
  });
}

/** Codex logs the same message as an item, an event and a response; keep one. */
function addMessage(builder: Builder, role: 'user' | 'assistant', body: string, base: { id: string; at: number | null; offset: number; clipped?: boolean }) {
  // The copies are written next to each other; anything in between means it was said again.
  for (let index = builder.items.length - 1; index >= 0; index--) {
    const item = builder.items[index];
    if (item.type !== role) break;
    if (item.text.trim() === body.trim()) return;
  }
  put(builder, { type: role, ...base, text: body });
}

export function codexAdapter(builder: Builder, line: Line) {
  const record = line.v;
  const payload = record?.payload;
  if (!payload) return;
  const key = typeof record.ordinal === 'number' ? `n${record.ordinal}:${record.type}` : null;
  if (key) {
    if (builder.seen.has(key)) return;
    builder.seen.add(key);
  }
  const at = time(record.timestamp);
  const base = { id: `o${line.o}`, at, offset: line.o, clipped: line.clipped };
  if (record.type === 'session_meta') {
    builder.meta.cwd = text(payload.cwd) || builder.meta.cwd;
    builder.meta.version = text(payload.cli_version) || undefined;
    builder.meta.branch = text(payload.git?.branch) || builder.meta.branch;
  } else if (record.type === 'turn_context') {
    builder.meta.model = text(payload.model) || builder.meta.model;
    builder.meta.effort = text(payload.effort) || builder.meta.effort;
    builder.meta.permissionMode = [text(payload.approval_policy), text(payload.sandbox_policy?.type)].filter(Boolean).join(' · ') || builder.meta.permissionMode;
  } else if (record.type === 'event_msg') {
    switch (payload.type) {
      // A turn cut off without a closing record leaves nothing running in the next one.
      case 'task_started': builder.meta.turnOpen = true; finishCalls(builder); break;
      case 'task_complete': builder.meta.turnOpen = false; finishCalls(builder); break;
      case 'turn_aborted':
        builder.meta.turnOpen = false;
        cancelRunning(builder);
        // Calls made before a message sent during the turn are still open too.
        finishCalls(builder);
        put(builder, { type: 'notice', ...base, tone: 'warning', text: payload.reason === 'interrupted' ? 'Interrompido pelo usuário' : 'Turno cancelado' });
        break;
      case 'item_completed': completedItem(builder, payload.item, line, at); break;
      case 'user_message': {
        const body = text(payload.message);
        if (body.trim() && !body.trimStart().startsWith('<')) addMessage(builder, 'user', body, base);
        break;
      }
      case 'agent_message': {
        const body = text(payload.message);
        if (body.trim()) addMessage(builder, 'assistant', body, base);
        break;
      }
      case 'token_count': {
        const usage = payload.info?.last_token_usage;
        if (usage) builder.meta.usage = { inputTokens: Number(usage.input_tokens) || 0, cachedTokens: Number(usage.cached_input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0, contextWindow: Number(payload.info.model_context_window) || undefined };
        break;
      }
      case 'error':
      case 'stream_error':
        put(builder, { type: 'notice', ...base, tone: 'error', text: text(payload.message) || 'Erro do Codex' });
        break;
    }
  } else if (record.type === 'response_item') {
    if (payload.type === 'message') {
      const body = blocksText(payload.content);
      if (body.trim()) addMessage(builder, 'assistant', body, { ...base, id: text(payload.id) || base.id });
      return;
    }
    const callId = text(payload.call_id);
    if (!callId) return;
    const id = builder.calls.get(callId) ?? `call:${callId}`;
    if (payload.type.endsWith('_output')) {
      const previous = toolAt(builder, id);
      if (!previous) return;
      const output = blocksText(payload.output) || text(payload.output);
      // The command outlived this call; it stays in progress until a later `wait` reports its end.
      const cell = /^Script running with cell ID (\S+)/.exec(output)?.[1];
      if (cell) { builder.cells.set(cell, id); return; }
      put(builder, { ...previous, status: previous.kind === 'question' ? previous.status : 'done', output });
      return;
    }
    const raw = text(payload.arguments) || text(payload.input) || (payload.action ? JSON.stringify(payload.action) : '');
    if (payload.name === 'wait') {
      let cell = '';
      try { cell = String(JSON.parse(raw).cell_id ?? ''); } catch { /* shown as an unknown wait */ }
      const waited = builder.cells.get(cell);
      if (waited) { builder.calls.set(callId, waited); return; }
      put(builder, { type: 'tool', ...base, id, name: 'wait', kind: 'other', target: BACKGROUND, status: 'running', input: raw, fallback: true });
      return;
    }
    if (String(payload.name).startsWith('request_user_input')) {
      // The only structured question Codex records; answering it happens in the terminal.
      let questions: any[] = [];
      try { questions = JSON.parse(raw).questions ?? []; } catch { /* shown as raw input */ }
      put(builder, {
        type: 'tool', ...base, id, name: 'Pergunta', kind: 'question', target: text(questions[0]?.question) || text(questions[0]?.title), status: 'done', input: raw,
        questions: questions.map((item: any) => ({ question: text(item?.question) || text(item?.title), header: text(item?.header) || undefined, multiSelect: false, options: Array.isArray(item?.options) ? item.options.map((option: any) => ({ label: text(option?.label) || text(option), description: text(option?.description) || undefined })) : [] })).filter((item) => item.question),
      });
      return;
    }
    const name = text(payload.name) || (payload.action ? 'shell' : 'Ferramenta');
    put(builder, { type: 'tool', ...base, id, name, ...describeCall(name, raw), status: 'running', input: raw, fallback: true });
  }
}
