import { describe, expect, it } from 'vitest';
import { attentionText, loadNotificationsEnabled, setNotificationsEnabled, translateAgentMessage, workerTransitions } from './notifications';
import { DEFAULT_MASCOT, mascotPixels } from './mascot';

describe('notificações de agentes', () => {
  it('traduz os pedidos mais comuns dos agentes', () => {
    expect(translateAgentMessage('Claude needs your permission to use Bash')).toBe('Quer usar Bash');
    expect(translateAgentMessage('Approval requested: npm test')).toBe('Quer executar: npm test');
    expect(translateAgentMessage('Approval requested by worker-2: git push')).toBe('Quer executar: git push');
    expect(translateAgentMessage('Codex wants to edit 3 files')).toBe('Quer editar 3 arquivos');
    expect(translateAgentMessage('Question: qual branch?')).toBe('Pergunta: qual branch?');
    expect(translateAgentMessage('Corrigi o parser')).toBe('Corrigi o parser');
  });

  it('monta título e corpo com o local e um texto padrão', () => {
    expect(attentionText('Claude Code', 'done', '', 'Athenas')).toEqual({ title: 'Claude Code terminou', body: 'Athenas · Pronto para a próxima instrução.' });
    expect(attentionText('Codex', 'approval', 'Approval requested: rm -rf dist', null)).toEqual({ title: 'Codex precisa da sua aprovação', body: 'Quer executar: rm -rf dist' });
    expect(attentionText('Worker Claude', 'error', '', null).title).toBe('Worker Claude falhou');
    expect(attentionText('Codex', 'done', 'x'.repeat(400), null).body.length).toBeLessThanOrEqual(180);
  });

  it('anuncia só mudanças de status de workers depois da primeira leitura', () => {
    const workers = [
      { id: 'a', agent: 'claude', brief: 'A', status: 'completed' },
      { id: 'b', agent: 'codex', brief: 'B', status: 'awaiting_permission' },
      { id: 'c', agent: 'codex', brief: 'C', status: 'running' },
    ];
    expect(workerTransitions(null, workers)).toEqual([]);
    const previous = new Map([['a', 'running'], ['b', 'awaiting_permission'], ['c', 'queued']]);
    expect(workerTransitions(previous, workers).map((item) => [item.worker.id, item.kind])).toEqual([['a', 'done']]);
    expect(workerTransitions(new Map(), [{ id: 'd', agent: 'claude', brief: 'D', status: 'failed' }]).map((item) => item.kind)).toEqual(['error']);
  });

  it('guarda a preferência de ligar/desligar', () => {
    setNotificationsEnabled(false);
    expect(loadNotificationsEnabled()).toBe(false);
    setNotificationsEnabled(true);
    expect(loadNotificationsEnabled()).toBe(true);
  });

  it('desenha o mascote com o chapéu acima do corpo', () => {
    const plain = mascotPixels(DEFAULT_MASCOT);
    expect(plain.rows).toBe(9);
    const hat = mascotPixels({ ...DEFAULT_MASCOT, outfit: 'christmas', antennas: true });
    expect(hat.rows).toBe(13);
    expect(hat.pixels.every((pixel) => pixel.y >= 0 && pixel.y < hat.rows)).toBe(true);
    expect(hat.pixels.some((pixel) => pixel.key.startsWith('a'))).toBe(false);
  });
});
