import { beforeEach, describe, expect, it } from 'vitest';
import { loadTabOrder, moveTab, sanitizeTabOrder, saveTabOrder, sortTabs } from './tabOrder';

describe('ordem das abas de terminal', () => {
  beforeEach(() => localStorage.clear());

  it('move uma aba para a posição escolhida no mesmo painel', () => {
    const next = moveTab({ p1: ['a', 'b', 'c'] }, 'c', 'p1', ['a', 'b', 'c'], 'b');
    expect(next.p1).toEqual(['a', 'c', 'b']);
  });

  it('move uma aba entre painéis e permite soltá-la no final', () => {
    const next = moveTab({ p1: ['a', 'b'], p2: ['c'] }, 'a', 'p2', ['c'], null);
    expect(next.p1).toEqual(['b']);
    expect(next.p2).toEqual(['c', 'a']);
  });

  it('mantém novas abas no final da ordem salva', () => {
    expect(sortTabs({ p1: ['b', 'a'] }, 'p1', [{ id: 'a' }, { id: 'b' }, { id: 'new' }]).map((tab) => tab.id)).toEqual(['b', 'a', 'new']);
  });

  it('persiste a ordem e descarta dados inválidos ou duplicados', () => {
    saveTabOrder({ p1: ['a', 'b'] });
    expect(loadTabOrder()).toEqual({ p1: ['a', 'b'] });
    expect(sanitizeTabOrder({ p1: ['a', 2, 'a'], p2: ['a', 'c'], bad: 'x' })).toEqual({ p1: ['a'], p2: ['c'] });
  });
});
