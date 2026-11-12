import { describe, expect, it } from 'vitest';
import { parseDiff, parseTranscript } from './transcript';
import { formatDuration, sessionStatus, workerStatus } from './status';

describe('worker status', () => {
  it('maps every backend state without reporting cancellations or permission waits as failures', () => {
    expect(workerStatus('aborted')).toMatchObject({ tone: 'cancelled', label: 'Cancelado' });
    expect(workerStatus('awaiting_permission')).toMatchObject({ tone: 'waiting', label: 'Aguardando você' });
    expect(workerStatus('landed').label).toBe('Integrado');
    expect(workerStatus('failed').tone).toBe('error');
    expect(workerStatus('running').live).toBe(true);
    expect(workerStatus('something_new')).toMatchObject({ tone: 'idle', label: 'something_new' });
  });

  it('maps terminal session states', () => {
    expect(sessionStatus('rodando')).toMatchObject({ tone: 'running', live: true });
    expect(sessionStatus('concluído').label).toBe('Encerrado');
    expect(sessionStatus('erro').tone).toBe('error');
  });

  it('formats elapsed time', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
  });
});

describe('transcript parser', () => {
  it('reads Codex exec --json events and merges started/completed items', () => {
    const raw = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Lendo o projeto"}}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"ok","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}]}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Pronto."}}',
      'warning: stderr line',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    ].join('\n');
    const entries = parseTranscript(raw);
    expect(entries.map((entry) => entry.kind)).toEqual(['reasoning', 'command', 'files', 'message', 'log', 'result']);
    expect(entries[1]).toMatchObject({ kind: 'command', command: 'npm test', output: 'ok', exitCode: 0, running: false });
  });

  it('reads the Claude json result and stream-json tool calls', () => {
    const single = parseTranscript('{"type":"result","subtype":"success","is_error":false,"duration_ms":2500,"num_turns":3,"result":"Feito","total_cost_usd":0.01}');
    expect(single).toEqual([expect.objectContaining({ kind: 'result', text: 'Feito', failed: false, meta: ['2.5 s', '3 turnos', '$0.0100'] })]);
    const stream = parseTranscript([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Vou rodar"},{"type":"tool_use","id":"u1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":"a.txt"}]}}',
    ].join('\n'));
    expect(stream[1]).toMatchObject({ kind: 'command', command: 'ls', output: 'a.txt', running: false });
  });

  it('groups plain lines into one log block', () => {
    expect(parseTranscript('linha 1\nlinha 2\n')).toEqual([{ kind: 'log', id: 'e0', text: 'linha 1\nlinha 2' }]);
  });
});

describe('diff parser', () => {
  it('splits files and counts changes', () => {
    const files = parseDiff('diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n context\n');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'x.ts', added: 1, removed: 1 });
    expect(files[0].lines.map((line) => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'del', 'add', 'context']);
  });
});
