import { describe, expect, it } from 'vitest';
import { compactTokens, usageByDay, usageByFolder, type UsageBucket } from './history';
import { niceMax } from './HistoryView';

const bucket = (hour: number, agent: string, folder: string, input: number): UsageBucket => ({ hour, agent, folder, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });

describe('histórico e consumo', () => {
  it('abrevia contagens de tokens em português', () => {
    expect(compactTokens(950)).toBe('950');
    expect(compactTokens(12_400)).toBe('12 mil');
    expect(compactTokens(3_200_000)).toBe('3,2 mi');
    expect(compactTokens(1_500_000_000)).toBe('1,5 bi');
  });

  it('agrupa por dia local, inclusive dias sem uso', () => {
    const now = new Date(2026, 10, 15, 18, 0).getTime();
    const hourOf = (date: Date) => Math.floor(date.getTime() / 3_600_000);
    const days = usageByDay([
      bucket(hourOf(new Date(2026, 10, 15, 9)), 'Claude Code', 'C:/a', 10),
      bucket(hourOf(new Date(2026, 10, 15, 10)), 'Codex', 'C:/a', 5),
      bucket(hourOf(new Date(2026, 10, 13, 23)), 'Claude Code', 'C:/a', 7),
      bucket(hourOf(new Date(2026, 9, 1, 12)), 'Claude Code', 'C:/a', 99),
    ], 3, now);
    expect(days.map((day) => [day.day, day.total])).toEqual([['2026-11-13', 7], ['2026-11-14', 0], ['2026-11-15', 15]]);
    expect(days[2].byAgent).toEqual({ 'Claude Code': 10, Codex: 5 });
  });

  it('soma por pasta sem diferenciar barras e maiúsculas', () => {
    const folders = usageByFolder([bucket(1, 'Codex', 'C:\\Proj\\', 4), bucket(2, 'Claude Code', 'c:/proj', 6), bucket(3, 'Codex', 'D:/outro', 1)]);
    expect(folders.map((item) => item.total)).toEqual([10, 1]);
  });

  it('arredonda o topo do eixo', () => {
    expect(niceMax(48_000_000)).toBe(50_000_000);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(0)).toBe(1);
  });
});
