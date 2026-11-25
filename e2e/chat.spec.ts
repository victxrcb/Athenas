import { expect, test, type Page } from '@playwright/test';

/** Stands in for the desktop backend so the real interface can be driven in a browser. Test data only. */
async function mockDesktop(page: Page, theme?: string) {
  await page.addInitScript((chosen) => {
    if (chosen) localStorage.setItem('athenas-theme', chosen);
    const at = (second: number) => new Date(Date.now() - 600_000 + second * 1000).toISOString();
    const session = { id: 's1', agent: 'Claude Code', folder: 'C:/workspace/agroboard', command: 'claude', resumeId: 'r1', paneId: null, status: 'rodando', title: 'Corrigir filtro de safra' };
    const use = (id: string, name: string, input: unknown, second: number) => ({ type: 'assistant', uuid: `a${id}`, timestamp: at(second), message: { id: `m${id}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1200, cache_read_input_tokens: 41000, cache_creation_input_tokens: 300, output_tokens: 220 } } });
    const done = (id: string, toolUseResult: unknown, second: number, content = 'ok') => ({ type: 'user', uuid: `r${id}`, timestamp: at(second), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult });
    const say = (id: string, text: string, second: number) => ({ type: 'assistant', uuid: id, timestamp: at(second), message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
    const records = [
      { type: 'user', uuid: 'u1', timestamp: at(0), gitBranch: 'fix/filtro-safra', cwd: 'C:/workspace/agroboard', message: { content: 'O filtro de safra está ignorando o talhão selecionado.\nPode investigar e corrigir?' } },
      say('t0', 'Vou analisar como o filtro monta a consulta.', 2),
      use('1', 'Read', { file_path: 'C:/workspace/agroboard/package.json' }, 3), done('1', { file: { startLine: 1 } }, 4),
      use('2', 'Grep', { pattern: 'filtroSafra' }, 5), done('2', {}, 6),
      use('3', 'Edit', { file_path: 'C:/workspace/agroboard/src/filters/safra.ts' }, 7),
      done('3', { filePath: 'C:/workspace/agroboard/src/filters/safra.ts', structuredPatch: [{ oldStart: 12, oldLines: 4, newStart: 12, newLines: 5, lines: [' export function filtroSafra(query: Query) {', '-  return query.where({ safra: query.safra });', '+  const { safra, talhao } = query;', '+  return query.where({ safra, talhao });', ' }'] }] }, 8),
      use('4', 'Bash', { command: 'npm run test', description: 'Executar os testes' }, 9), done('4', { stdout: '✓ 164 testes passaram\n  Duração 12 s', stderr: '' }, 31),
      say('t1', '## Corrigido\n\nO filtro usava apenas a **safra** e descartava o talhão. Ajustei `filtroSafra` para enviar os dois campos:\n\n```ts\nconst { safra, talhao } = query;\nreturn query.where({ safra, talhao });\n```\n\n| Cenário | Antes | Depois |\n|---|---|---|\n| Safra sem talhão | correto | correto |\n| Safra com talhão | ignorava o talhão | filtra os dois |\n\n- [x] Testes executados\n- [ ] Validar com dados reais', 33),
      { type: 'pr-link', prNumber: 42, prUrl: 'https://github.com/exemplo/agroboard/pull/42', prRepository: 'exemplo/agroboard', timestamp: at(34) },
    ];
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    let served = false;
    const w = window as any;
    w.isTauri = true;
    w.__emit = (event: string, payload: unknown) => (listeners.get(event) ?? []).forEach((id) => callbacks.get(id)?.({ event, id, payload }));
    w.__calls = [];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback: (callback: (value: unknown) => void) => { const id = next++; callbacks.set(id, callback); return id; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any) => {
        w.__calls.push([command, args]);
        if (command === 'plugin:event|listen') { listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]); return args.handler; }
        if (command === 'terminal_list') return [session];
        if (command === 'workspace_list') return { groups: [], panes: [], projects: [{ id: 'p', groupId: null, name: 'Agroboard', folder: session.folder, layout: 'auto', splitRatio: .5, updatedAt: 1 }] };
        if (command === 'chat_read') {
          const lines = served || args.from ? [] : records.map((v, o) => ({ o, v }));
          served = true;
          return { bound: true, reset: false, source: 'conv', start: 0, end: 100, more: false, candidates: [], lines };
        }
        if (command === 'chat_context') return { folder: session.folder, branch: 'fix/filtro-safra', instructions: ['CLAUDE.md'], commands: [] };
        if (command === 'chat_permissions') return [];
        if (command === 'terminal_scrollback') return btoa('terminal');
        if (command === 'settings_get') return { claudeCommand: 'claude', codexCommand: 'codex', shellCommand: 'powershell.exe', workerLimit: 3, scrollbackMb: 5, fontSize: 13, reducedEffects: false };
        if (command === 'group_metrics') return { totalBytes: 0, appBytes: 0, groups: [], agents: [] };
        if (command === 'agent_quotas' || command.endsWith('_list')) return [];
        if (command === 'orchestration_list') return { workers: [] };
        return null;
      },
    };
  }, theme);
}

async function openSession(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__calls.some(([command]: [string]) => command === 'terminal_list'));
  await page.evaluate(async () => {
    const path = '/src/store.ts';
    const { useAppStore } = await import(path);
    useAppStore.getState().setActiveSessionId('s1');
  });
  await expect(page.getByRole('heading', { name: 'Corrigido' })).toBeVisible();
}

for (const [width, height] of [[1280, 720], [1920, 1080]] as const) {
  test(`conversation fits ${width}x${height} with working steps, diff and approval`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    // xterm 5.5 raises this when React's development double mount disposes a terminal; it also happens without the chat.
    page.on('pageerror', (error) => { if (!error.message.includes("reading 'dimensions'")) errors.push(error.message); });
    await page.setViewportSize({ width, height });
    await mockDesktop(page);
    await openSession(page);
    const overflow = () => page.evaluate(() => {
      const scroller = document.querySelector('.chat-scroll')!;
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, scroller.scrollWidth - scroller.clientWidth);
    });
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.getByRole('textbox', { name: 'Mensagem para Claude Code' })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`chat-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: /4 etapas executadas/ }).click();
    await page.getByRole('button', { name: /Executou Executar os testes/ }).click();
    await expect(page.getByText('✓ 164 testes passaram')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`steps-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Ver alterações' }).click();
    const dialog = page.getByRole('dialog', { name: 'Alterações do agente' });
    await expect(dialog).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`diff-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.evaluate(() => (window as any).__emit('agent-permissions', [{ id: 'p1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm install zod', description: 'Instalar a biblioteca de validação' }, agentId: null, createdAt: Date.now(), suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }] }] }]));
    await expect(page.getByRole('alertdialog', { name: 'Autorização necessária' })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`approval-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Ver contexto' }).click();
    await expect(page.getByRole('dialog', { name: 'Contexto do agente' })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`context-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Dividido' }).click();
    await expect(page.locator('.surface-terminal .xterm')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`split-${width}.png`), animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

for (const theme of ['preto-branco', 'ametista']) {
  test(`chat highlights follow the ${theme} theme`, async ({ page }, testInfo) => {
    await mockDesktop(page, theme);
    await openSession(page);
    await page.getByRole('textbox', { name: 'Mensagem para Claude Code' }).fill('Rodar de novo');
    const expected = await page.evaluate((token) => {
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = `var(${token})`;
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, theme === 'preto-branco' ? '--accent' : '--focus');
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toHaveCSS('background-color', expected);
    await page.screenshot({ path: testInfo.outputPath(`chat-${theme}.png`), animations: 'disabled' });
  });
}

test('conversation follows a light theme and the mapping opens it', async ({ page }, testInfo) => {
  await mockDesktop(page, 'pergaminho');
  await openSession(page);
  await page.screenshot({ path: testInfo.outputPath('chat-light.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Mapeamento', exact: true }).click();
  await page.getByRole('article', { name: /Corrigir filtro de safra/ }).click();
  await expect(page.getByRole('heading', { name: 'Conversa' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mapping-inspector.png'), animations: 'disabled' });
  await page.getByRole('complementary', { name: 'Detalhes do agente' }).getByRole('button', { name: 'Abrir conversa' }).click();
  await expect(page.getByRole('region', { name: 'Conversa com Claude Code' })).toBeVisible();
});
