import { blocksText, cancelRunning, put, text, time, type Builder } from './builder';
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
      case 'task_started': builder.meta.turnOpen = true; break;
      case 'task_complete': builder.meta.turnOpen = false; break;
      case 'turn_aborted':
        builder.meta.turnOpen = false;
        cancelRunning(builder);
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
    const id = `call:${callId}`;
    if (payload.type.endsWith('_output')) {
      const position = builder.index.get(id);
      const previous = position === undefined ? undefined : builder.items[position];
      if (previous?.type === 'tool') put(builder, { ...previous, status: previous.kind === 'question' ? previous.status : 'done', output: blocksText(payload.output) || text(payload.output) });
      return;
    }
    const raw = text(payload.arguments) || text(payload.input) || (payload.action ? JSON.stringify(payload.action) : '');
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
    put(builder, { type: 'tool', ...base, id, name: text(payload.name) || 'Ferramenta', kind: 'other', target: text(payload.name), status: 'running', input: raw, fallback: true });
  }
}
