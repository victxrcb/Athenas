import { blocksText, cancelRunning, put, text, time, toolAt, type Builder } from './builder';
import { hunkStats } from './diff';
import type { FileChange, Hunk, Line, Question, ToolItem, ToolKind } from './model';

const KINDS: Record<string, ToolKind> = {
  Bash: 'command', PowerShell: 'command', Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', LS: 'search', WebFetch: 'web', WebSearch: 'web', AskUserQuestion: 'question', ExitPlanMode: 'plan',
  Agent: 'agent', Task: 'agent',
};
const REJECTED = /^(The user doesn't want to proceed|\[Request interrupted)/;

export function readQuestions(input: any): Question[] | undefined {
  if (!Array.isArray(input?.questions)) return undefined;
  return input.questions.filter((item: any) => typeof item?.question === 'string').map((item: any) => ({
    question: item.question,
    header: text(item.header) || undefined,
    multiSelect: item.multiSelect === true,
    options: Array.isArray(item.options) ? item.options.filter((option: any) => typeof option?.label === 'string').map((option: any) => ({ label: option.label, description: text(option.description) || undefined })) : [],
  }));
}

/** The visible part of a tool call, built from its input. Also used for calls announced by hooks. */
export function claudeTool(id: string, name: string, input: any, at: number | null, offset: number | null): ToolItem {
  const mcp = name.startsWith('mcp__') ? name.split('__') : null;
  const kind: ToolKind = mcp ? 'mcp' : KINDS[name] ?? 'other';
  const filePath = text(input?.file_path) || text(input?.notebook_path) || undefined;
  const command = kind === 'command' ? text(input?.command) : undefined;
  const target = mcp ? `${mcp[1]} · ${mcp.slice(2).join('__')}`
    : command ?? (filePath || text(input?.pattern) || text(input?.url) || text(input?.query) || text(input?.description) || text(input?.skill) || (kind === 'question' ? text(input?.questions?.[0]?.question) : ''));
  return {
    type: 'tool', id, at, offset, name, kind, target, status: 'running', input,
    description: text(input?.description) || undefined, command, filePath,
    line: typeof input?.offset === 'number' ? input.offset : undefined,
    questions: kind === 'question' ? readQuestions(input) : undefined,
    plan: kind === 'plan' ? text(input?.plan) || undefined : undefined,
  };
}

function fileChange(result: any): FileChange | undefined {
  const path = text(result?.filePath);
  if (!path || !Array.isArray(result.structuredPatch)) return undefined;
  let hunks: Hunk[] = result.structuredPatch.filter((hunk: any) => Array.isArray(hunk?.lines)).map((hunk: any) => ({
    oldStart: Number(hunk.oldStart) || 0, newStart: Number(hunk.newStart) || 0, lines: hunk.lines.map(String),
  }));
  const created = result.type === 'create';
  // A new file has no patch; its content is the change.
  if (created && !hunks.length && typeof result.content === 'string') {
    hunks = [{ oldStart: 0, newStart: 1, lines: result.content.replace(/\n$/, '').split('\n').map((line: string) => `+${line}`) }];
  }
  return { path, type: created ? 'add' : 'update', hunks, ...hunkStats(hunks) };
}

function complete(builder: Builder, block: any, record: any, line: Line) {
  const tool = toolAt(builder, text(block.tool_use_id));
  if (!tool) return;
  const result = record.toolUseResult;
  const content = blocksText(block.content);
  const failed = block.is_error === true;
  const at = time(record.timestamp);
  const exit = failed ? /^(?:Error: )?Exit code (\d+)/.exec(content) : null;
  const next: ToolItem = {
    ...tool,
    status: failed ? (REJECTED.test(content) ? 'cancelled' : 'failed') : result?.interrupted ? 'cancelled' : 'done',
    offset: line.o,
    clipped: line.clipped || tool.clipped,
    durationMs: typeof result?.durationMs === 'number' ? result.durationMs : typeof result?.totalDurationMs === 'number' ? result.totalDurationMs : at && tool.at ? Math.max(0, at - tool.at) : undefined,
    exitCode: exit ? Number(exit[1]) : undefined,
    output: tool.kind === 'command' && typeof result?.stdout === 'string' ? result.stdout : content,
    stderr: typeof result?.stderr === 'string' && result.stderr ? result.stderr : undefined,
  };
  const change = failed ? undefined : fileChange(result);
  if (change) next.changes = [change];
  if (tool.kind === 'question' && result?.answers && typeof result.answers === 'object') next.answers = result.answers;
  if (tool.kind === 'read' && typeof result?.file?.startLine === 'number') next.line = result.file.startLine;
  put(builder, next);
}

const messageText = (content: unknown) => (Array.isArray(content) ? blocksText(content.filter((block: any) => block?.type === 'text')) : text(content));

const imagesIn = (content: unknown): string[] => (Array.isArray(content) ? content : [])
  .filter((block: any) => block?.type === 'image' && block.source?.type === 'base64' && /^image\/(png|jpe?g|gif|webp)$/.test(block.source.media_type))
  .map((block: any) => `data:${block.source.media_type};base64,${block.source.data}`);

function userRecord(builder: Builder, record: any, line: Line) {
  const content = record.message?.content;
  const at = time(record.timestamp);
  const id = text(record.uuid) || `o${line.o}`;
  if (record.isCompactSummary) {
    put(builder, { type: 'notice', id, at, offset: line.o, tone: 'info', text: 'Resumo da conversa compactada', detail: blocksText(content) });
    return;
  }
  const images = imagesIn(content);
  if (Array.isArray(content)) {
    for (const block of content) if (block?.type === 'tool_result') complete(builder, block, record, line);
  }
  const body = messageText(content);
  if (record.isMeta) return;
  const trimmed = body.trim();
  if (trimmed.startsWith('[Request interrupted')) {
    cancelRunning(builder);
    builder.meta.turnOpen = false;
    put(builder, { type: 'notice', id, at, offset: line.o, tone: 'warning', text: 'Interrompido pelo usuário' });
    return;
  }
  const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1].trim();
    put(builder, { type: 'user', id, at, offset: line.o, text: `${command[1]}${args ? ` ${args}` : ''}` });
    return;
  }
  const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(trimmed);
  if (output) {
    if (output[1].trim()) put(builder, { type: 'notice', id, at, offset: line.o, tone: 'info', text: 'Resultado do comando', detail: stripAnsi(output[1]) });
    return;
  }
  // Other tagged blocks are context injected by the CLI, not something the user wrote.
  if (/^<[a-z][\w-]*>/i.test(trimmed) || (!trimmed && !images.length)) return;
  builder.meta.turnOpen = true;
  put(builder, { type: 'user', id, at, offset: line.o, text: body, images: images.length ? images : undefined, clipped: line.clipped });
}

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();

function assistantRecord(builder: Builder, record: any, line: Line) {
  const message = record.message ?? {};
  const content = Array.isArray(message.content) ? message.content : [];
  const at = time(record.timestamp);
  const id = text(record.uuid) || `o${line.o}`;
  if (record.isApiErrorMessage) {
    builder.meta.turnOpen = false;
    put(builder, { type: 'notice', id, at, offset: line.o, tone: 'error', text: blocksText(content) || 'Erro na resposta do modelo' });
    return;
  }
  const model = text(message.model);
  if (model && !model.startsWith('<')) builder.meta.model = model;
  const usage = message.usage;
  if (usage && model !== '<synthetic>') {
    const cached = Number(usage.cache_read_input_tokens) || 0;
    const total = (Number(usage.input_tokens) || 0) + cached + (Number(usage.cache_creation_input_tokens) || 0);
    if (total > 0) builder.meta.usage = { inputTokens: total, cachedTokens: cached, outputTokens: Number(usage.output_tokens) || 0 };
  }
  content.forEach((block: any, position: number) => {
    if (block?.type === 'text' && text(block.text).trim()) {
      put(builder, { type: 'assistant', id: `${id}:${position}`, at, offset: line.o, text: block.text, clipped: line.clipped });
    } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
      put(builder, { ...claudeTool(block.id, text(block.name), block.input, at, line.o), clipped: line.clipped });
    }
  });
  if (message.stop_reason === 'end_turn') builder.meta.turnOpen = false;
  else if (content.length) builder.meta.turnOpen = true;
}

export function claudeAdapter(builder: Builder, line: Line) {
  const record = line.v;
  if (!record || typeof record !== 'object') return;
  if (typeof record.uuid === 'string') {
    if (builder.seen.has(record.uuid)) return;
    builder.seen.add(record.uuid);
  }
  if (typeof record.cwd === 'string') builder.meta.cwd = record.cwd;
  if (typeof record.gitBranch === 'string' && record.gitBranch) builder.meta.branch = record.gitBranch;
  if (typeof record.version === 'string') builder.meta.version = record.version;
  switch (record.type) {
    case 'user': userRecord(builder, record, line); break;
    case 'attachment': {
      if (record.attachment?.type !== 'queued_command') break;
      // A queued message with images is recorded as content blocks instead of plain text.
      const prompt = messageText(record.attachment.prompt);
      const images = imagesIn(record.attachment.prompt);
      if ((prompt.trim() || images.length) && !prompt.trimStart().startsWith('<')) {
        put(builder, { type: 'user', id: text(record.uuid) || `o${line.o}`, at: time(record.timestamp), offset: line.o, text: prompt, images: images.length ? images : undefined, clipped: line.clipped });
      }
      break;
    }
    case 'assistant': assistantRecord(builder, record, line); break;
    case 'ai-title': builder.meta.title = text(record.aiTitle) || builder.meta.title; break;
    case 'custom-title': builder.meta.title = text(record.customTitle) || builder.meta.title; break;
    case 'permission-mode': builder.meta.permissionMode = text(record.permissionMode) || builder.meta.permissionMode; break;
    case 'pr-link':
      if (typeof record.prUrl === 'string') put(builder, { type: 'pr', id: `pr:${record.prUrl}`, at: time(record.timestamp), offset: line.o, number: Number(record.prNumber), url: record.prUrl, repository: text(record.prRepository) });
      break;
    case 'system': {
      const base = { id: text(record.uuid) || `o${line.o}`, at: time(record.timestamp), offset: line.o, type: 'notice' as const };
      if (record.subtype === 'turn_duration') builder.meta.turnOpen = false;
      else if (record.subtype === 'compact_boundary') put(builder, { ...base, tone: 'info', text: 'Conversa compactada' });
      else if (record.subtype === 'api_error') put(builder, { ...base, tone: 'error', text: text(record.content) || 'Falha ao falar com o modelo' });
      else if (record.subtype === 'informational' && record.level === 'warning') put(builder, { ...base, tone: 'warning', text: stripAnsi(text(record.content)) });
      break;
    }
  }
}
