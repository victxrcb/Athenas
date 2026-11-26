import { describe, expect, it } from 'vitest';
import { attachmentReference, messageWithAttachments } from './attachments';
import { buildBlocks, findMatches, stableBlocks } from './blocks';
import { apply, createBuilder, snapshot, type Adapter } from './builder';
import { claudeAdapter } from './claudeAdapter';
import { codexAdapter, commandText } from './codexAdapter';
import { needsTerminal } from './commands';
import { mergeChanges, parseUnifiedDiff, splitRows, unifiedRows } from './diff';
import { fileTarget } from './actions';
import { snippet } from './MappingConversation';
import type { Line, ToolItem } from './model';

const lines = (records: any[]): Line[] => records.map((v, index) => ({ o: index * 100, v }));
const read = (adapter: Adapter, records: any[]) => {
  const builder = createBuilder();
  apply(builder, adapter, lines(records));
  return snapshot(builder);
};
const at = (second: number) => `2026-11-25T10:00:${String(second).padStart(2, '0')}.000Z`;
const tool = (id: string, name: string, input: unknown, second = 1) => ({ type: 'assistant', uuid: `a-${id}`, timestamp: at(second), message: { id: `m-${id}`, model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 } } });
const result = (id: string, content: string, toolUseResult: unknown, error = false, second = 3) => ({ type: 'user', uuid: `r-${id}`, timestamp: at(second), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] }, toolUseResult });

describe('Claude Code transcript', () => {
  it('pairs tools with their results and keeps the real command output', () => {
    const transcript = read(claudeAdapter, [
      { type: 'user', uuid: 'u1', timestamp: at(0), gitBranch: 'master', cwd: 'C:\\p', message: { role: 'user', content: 'Rode os testes' } },
      tool('t1', 'Bash', { command: 'npm test', description: 'Rodar testes' }),
      result('t1', '164 passed', { stdout: '164 passed', stderr: 'aviso', interrupted: false }),
      tool('t2', 'Bash', { command: 'false' }),
      result('t2', 'Exit code 2\nfalhou', 'Error: Exit code 2', true),
      { type: 'assistant', uuid: 'a9', timestamp: at(9), message: { id: 'm9', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '**Pronto**' }] } },
    ]);
    expect(transcript.items.map((item) => item.type)).toEqual(['user', 'tool', 'tool', 'assistant']);
    const [, first, second] = transcript.items as ToolItem[];
    expect(first).toMatchObject({ status: 'done', kind: 'command', command: 'npm test', output: '164 passed', stderr: 'aviso', durationMs: 2000 });
    expect(first.exitCode).toBeUndefined();
    expect(second).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(transcript.meta).toMatchObject({ model: 'claude-haiku-5-5', branch: 'master', turnOpen: false, usage: { inputTokens: 105, cachedTokens: 90, outputTokens: 7 } });
  });

  it('attributes file changes only to the patches the editing tools reported', () => {
    const transcript = read(claudeAdapter, [
      tool('e', 'Edit', { file_path: 'C:\\p\\a.ts', old_string: 'a', new_string: 'b' }),
      result('e', 'ok', { filePath: 'C:\\p\\a.ts', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-a', '+b'] }] }),
      tool('w', 'Write', { file_path: 'C:\\p\\novo.ts', content: 'um\ndois\n' }),
      result('w', 'ok', { type: 'create', filePath: 'C:\\p\\novo.ts', content: 'um\ndois\n', structuredPatch: [] }),
      tool('s', 'Bash', { command: 'sed -i s/a/b/ c.ts' }),
      result('s', '', { stdout: '', stderr: '' }),
    ]);
    const changes = mergeChanges(transcript.items.flatMap((item) => (item.type === 'tool' ? item.changes ?? [] : [])));
    expect(changes.map((change) => [change.path, change.type, change.added, change.removed])).toEqual([['C:\\p\\a.ts', 'update', 1, 1], ['C:\\p\\novo.ts', 'add', 2, 0]]);
  });

  it('reads questions, commands and interruptions, and ignores injected context and repeats', () => {
    const question = { questions: [{ question: 'Cor?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul' }] }] };
    const prompt = { type: 'user', uuid: 'u', timestamp: at(0), message: { content: 'Oi' } };
    const transcript = read(claudeAdapter, [
      prompt, prompt,
      { type: 'user', uuid: 'meta', isMeta: true, message: { content: 'contexto' } },
      { type: 'user', uuid: 'tag', message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', uuid: 'cmd', message: { content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } },
      tool('q', 'AskUserQuestion', question),
      result('q', 'ok', { ...question, answers: { 'Cor?': 'Azul' } }),
      tool('b', 'Bash', { command: 'sleep 9' }),
      { type: 'user', uuid: 'stop', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]);
    expect(transcript.items.map((item) => (item.type === 'user' ? item.text : item.type === 'tool' ? `${item.name}:${item.status}` : item.type))).toEqual(['Oi', '/model opus', 'AskUserQuestion:done', 'Bash:cancelled', 'notice']);
    expect((transcript.items[2] as ToolItem).answers).toEqual({ 'Cor?': 'Azul' });
  });

  it('shows messages queued while the agent was busy', () => {
    const transcript = read(claudeAdapter, [{ type: 'attachment', uuid: 'q', timestamp: at(1), attachment: { type: 'queued_command', prompt: 'depois rode os testes' } }]);
    expect(transcript.items).toMatchObject([{ type: 'user', text: 'depois rode os testes' }]);
  });

  it('shows queued messages that carry images', () => {
    const prompt = [{ type: 'text', text: '[Image #1]ajuste a cor' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
    const transcript = read(claudeAdapter, [{ type: 'attachment', uuid: 'q', timestamp: at(1), attachment: { type: 'queued_command', prompt } }]);
    expect(transcript.items).toMatchObject([{ type: 'user', text: '[Image #1]ajuste a cor', images: ['data:image/png;base64,AAAA'] }]);
  });

  it('survives malformed records', () => {
    expect(read(claudeAdapter, [null, { type: 'assistant' }, { type: 'user', uuid: 'u', message: { content: 'ok' } }]).items).toHaveLength(1);
  });
});

describe('Codex rollout', () => {
  const item = (ordinal: number, value: unknown) => ({ type: 'event_msg', ordinal, timestamp: at(ordinal), payload: { type: 'item_completed', item: value } });

  it('normalizes messages, commands, file changes and usage', () => {
    const transcript = read(codexAdapter, [
      { type: 'session_meta', ordinal: 0, payload: { id: 'x', cwd: 'C:\\p', cli_version: '0.172.0', git: { branch: 'main' } } },
      { type: 'turn_context', ordinal: 1, payload: { model: 'gpt', effort: 'high', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started' } },
      item(3, { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'Arrume o bug' }] }),
      { type: 'response_item', ordinal: 4, payload: { type: 'custom_tool_call', call_id: 'c', name: 'exec', input: 'x' } },
      item(5, { type: 'CommandExecution', id: 'cmd', command: ['powershell.exe', '-Command', 'npm test'], cwd: 'C:\\p', status: 'failed', exit_code: 1, aggregated_output: 'boom', duration: { secs: 2, nanos: 500000000 } }),
      item(6, { type: 'FileChange', id: 'f', status: 'completed', changes: { 'C:\\p\\a.ts': { type: 'update', unified_diff: '@@ -1,2 +1,2 @@\n x\n-a\n+b\n' }, 'C:\\p\\b.ts': { type: 'add', content: 'um\n' } } }),
      { type: 'response_item', ordinal: 7, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Feito' }] } },
      item(8, { type: 'AgentMessage', id: 'm', content: [{ type: 'Text', text: 'Feito' }] }),
      { type: 'event_msg', ordinal: 9, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }, model_context_window: 200000 } } },
      { type: 'event_msg', ordinal: 10, payload: { type: 'task_complete' } },
    ]);
    expect(transcript.items.map((entry) => entry.type)).toEqual(['user', 'tool', 'tool', 'assistant']);
    expect(transcript.items[1]).toMatchObject({ command: 'npm test', status: 'failed', exitCode: 1, durationMs: 2500, output: 'boom' });
    expect((transcript.items[2] as ToolItem).changes?.map((change) => [change.type, change.added, change.removed])).toEqual([['update', 1, 1], ['add', 1, 0]]);
    expect(transcript.meta).toMatchObject({ model: 'gpt', effort: 'high', branch: 'main', permissionMode: 'on-request · workspace-write', turnOpen: false, usage: { inputTokens: 1000, contextWindow: 200000 } });
  });

  it('keeps older call records when there are no completed items', () => {
    const transcript = read(codexAdapter, [
      { type: 'event_msg', payload: { type: 'user_message', message: 'Oi' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ]);
    expect(transcript.items.map((entry) => (entry.type === 'tool' ? `${entry.name}:${entry.status}:${entry.output}` : entry.type))).toEqual(['user', 'shell:done:ok', 'notice']);
  });

  it('keeps a message the user repeats and drops only its copies', () => {
    const say = (ordinal: number, type: string, message: string) => ({ type: 'event_msg', ordinal, payload: { type, message } });
    const transcript = read(codexAdapter, [say(1, 'user_message', 'continue'), say(2, 'user_message', 'continue'), say(3, 'agent_message', 'ok'), say(4, 'user_message', 'continue'), say(5, 'agent_message', 'ok')]);
    expect(transcript.items.map((entry) => entry.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('shows the command that ran', () => {
    expect(commandText(['bash', '-lc', 'ls'])).toBe('ls');
    expect(commandText(['git', 'status'])).toBe('git status');
  });
});

describe('presentation helpers', () => {
  it('numbers diff lines and pairs them side by side', () => {
    const [hunk] = parseUnifiedDiff('--- a\n+++ b\n@@ -10,3 +10,3 @@\n a\n-b\n+c\n+d\n');
    expect(unifiedRows(hunk).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([['context', 10, 10], ['remove', 11, undefined], ['add', undefined, 11], ['add', undefined, 12]]);
    expect(splitRows(hunk).map(([left, right]) => [left?.text, right?.text])).toEqual([['a', 'a'], ['b', 'c'], [undefined, 'd']]);
  });

  it('groups consecutive actions, summarizes changes per turn and keeps unchanged groups', () => {
    const transcript = read(claudeAdapter, [
      { type: 'user', uuid: 'u', message: { content: 'vai' } },
      tool('a', 'Read', { file_path: 'a' }), result('a', 'x', {}),
      tool('b', 'Edit', { file_path: 'b' }), result('b', 'ok', { filePath: 'b', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['+n'] }] }),
      { type: 'assistant', uuid: 'z', message: { content: [{ type: 'text', text: 'Fim' }] } },
    ]);
    const blocks = buildBlocks(transcript.items);
    expect(blocks.map((block) => block.type)).toEqual(['user', 'tools', 'assistant', 'changes']);
    expect(stableBlocks(blocks, buildBlocks(transcript.items))).toEqual(blocks);
    expect(stableBlocks(blocks, buildBlocks(transcript.items))[1]).toBe(blocks[1]);
    expect(findMatches(transcript.items, 'FIM')).toEqual(['z:0']);
  });

  it('references attachments the way each agent reads them', () => {
    expect(attachmentReference('C:\\p\\src\\a.ts', 'Claude Code', '\\\\?\\C:\\p')).toBe('@src/a.ts');
    expect(attachmentReference('C:\\outro\\a b.png', 'Claude Code', 'C:\\p')).toBe('"C:\\outro\\a b.png"');
    expect(attachmentReference('C:\\p\\a.ts', 'Codex', 'C:\\p')).toBe('"C:\\p\\a.ts"');
    expect(messageWithAttachments(' oi ', [{ path: 'C:\\p\\a' }], 'Codex', 'C:\\p')).toBe('oi\n\n"C:\\p\\a"');
  });

  it('previews a message without Markdown noise', () => {
    const message = ['## Corrigido', '', 'A **safra** e o `talhão`.', '', '```ts', 'x', '```', '', '| A | B |', '|---|---|', '- [x] feito'].join('\n');
    expect(snippet(message)).toBe('Corrigido A safra e o talhão. feito');
  });

  it('knows which commands need the terminal and which links are files', () => {
    expect(needsTerminal('Claude Code', '/model')).toBe(true);
    expect(needsTerminal('Claude Code', '/model opus')).toBe(false);
    expect(fileTarget('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(fileTarget('src/a.ts#L3-L9')).toEqual({ path: 'src/a.ts', line: 3 });
    expect(fileTarget('https://x.dev')).toBeNull();
    expect(fileTarget('javascript:alert(1)')).toBeNull();
  });
});
