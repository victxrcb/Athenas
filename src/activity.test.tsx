import { beforeEach, describe, expect, it } from 'vitest';
import { applyAttention, createInputTracker, liveStatus, sessionLabel, useActivityStore } from './activity';
import { ago, inboxItems } from './inbox';
import { formatWhen, toLocalInput } from './schedule';
import type { SessionInfo } from './store';

const session = (patch: Partial<SessionInfo> = {}): SessionInfo => ({ id: 's1', agent: 'Codex', folder: 'C:/proj', command: 'codex', resumeId: null, paneId: null, status: 'rodando', title: null, ...patch });

describe('estado ao vivo das sessões', () => {
  beforeEach(() => useActivityStore.setState({ activity: {}, urls: {}, workers: [] }));

  it('marca terminou como não lido só quando a sessão não está na tela', () => {
    expect(applyAttention(undefined, 'done', '', false, 10)).toEqual({ state: 'done', since: 10, unread: true, message: '' });
    expect(applyAttention(undefined, 'done', '', true, 10).unread).toBe(false);
    expect(applyAttention(undefined, 'approval', 'Quer usar Bash', true, 10)).toMatchObject({ state: 'approval', unread: true });
    expect(applyAttention(undefined, 'working', 'prompt', false, 10)).toMatchObject({ state: 'working', unread: false });
  });

  it('mostra o status ao vivo e o nome da sessão', () => {
    expect(liveStatus(session(), { state: 'working', since: 0, unread: false, message: '' }).label).toBe('Trabalhando');
    expect(liveStatus(session(), { state: 'approval', since: 0, unread: true, message: '' }).tone).toBe('waiting');
    expect(liveStatus(session(), { state: 'done', since: 0, unread: true, message: '' }).label).toBe('Terminou');
    expect(liveStatus(session({ status: 'erro' }), { state: 'working', since: 0, unread: false, message: '' }).label).toBe('Erro');
    expect(sessionLabel(session({ title: '  Login  ' }))).toBe('Login');
    expect(sessionLabel(session())).toBe('Codex');
  });

  it('interpreta digitação: Enter envia, tecla responde aprovação e Esc interrompe', () => {
    const track = createInputTracker(session());
    track('rode'); track(' os testes'); track('\x7f'); track('\r');
    expect(useActivityStore.getState().activity.s1.state).toBe('working');
    useActivityStore.getState().set('s1', { state: 'approval', since: 1, unread: true, message: '' });
    track('1');
    expect(useActivityStore.getState().activity.s1.state).toBe('working');
    track('\x1b');
    expect(useActivityStore.getState().activity.s1.state).toBe('idle');
    // Shell sessions never get a live state.
    createInputTracker(session({ id: 's2', agent: 'Shell' }))('ls\r');
    expect(useActivityStore.getState().activity.s2).toBeUndefined();
  });
});

describe('caixa de entrada', () => {
  it('lista decisões primeiro e respeita o que foi dispensado', () => {
    const now = 1_000_000_000;
    const items = inboxItems(
      [session({ id: 'a' }), session({ id: 'b', title: 'Deploy' }), session({ id: 'c' }), session({ id: 'd', status: 'concluído' })],
      {
        a: { state: 'done', since: now - 10, unread: true, message: '' },
        b: { state: 'approval', since: now - 100, unread: true, message: 'Quer usar Bash' },
        c: { state: 'done', since: now - 5, unread: false, message: '' },
        d: { state: 'approval', since: now, unread: true, message: '' },
      },
      [
        { id: 'w1', agent: 'claude', brief: 'Corrigir bug\nmais', status: 'failed', finishedAt: now / 1000 - 60 },
        { id: 'w2', agent: 'codex', brief: 'Antigo', status: 'completed', finishedAt: now / 1000 - 13 * 3600 },
        { id: 'w3', agent: 'codex', brief: 'Dispensado', status: 'completed', finishedAt: now / 1000 - 60 },
      ],
      { 'worker:w3:completed': true },
      now,
    );
    expect(items.map((item) => `${item.source}:${item.id}:${item.kind}`)).toEqual(['session:b:approval', 'worker:w1:error', 'session:a:done']);
    expect(items[0].title).toBe('Deploy');
    expect(items[1].title).toBe('Corrigir bug');
  });

  it('formata tempos relativos e horários de agendamento', () => {
    const now = new Date(2026, 10, 15, 14, 0);
    expect(ago(now.getTime() - 30_000, now.getTime())).toBe('agora');
    expect(ago(now.getTime() - 5 * 60_000, now.getTime())).toBe('há 5 min');
    expect(formatWhen(new Date(2026, 10, 15, 16, 30).getTime() / 1000, now)).toBe('hoje às 16:30');
    expect(formatWhen(new Date(2026, 10, 16, 9, 0).getTime() / 1000, now)).toBe('amanhã às 09:00');
    expect(toLocalInput(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05T07:03');
  });
});
