import { expect, test } from '@playwright/test';

test('mapping controls follow the active theme', async ({ page }) => {
  await page.goto('/');
  const navigation = page.getByRole('button', { name: 'Mapeamento', exact: true });
  await navigation.click();
  const architecture = page.getByRole('button', { name: 'Arquitetura', exact: true });
  const create = page.getByRole('button', { name: 'Novo agente no mapa' });
  const headingIcon = page.locator('.mapping-heading > span');

  for (const control of [navigation, architecture, create, headingIcon]) {
    await expect(control).toHaveCSS('color', 'rgb(237, 237, 237)');
  }

  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Ametista', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar configurações' }).click();
  const focusColor = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--focus)';
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(focusColor).not.toBe('rgb(237, 237, 237)');
  for (const control of [navigation, architecture, create, headingIcon]) {
    await expect(control).toHaveCSS('color', focusColor);
  }
});

test('mapping workspace adapts, connects the inspector and restores canvas preferences', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Mapeamento', exact: true }).click();
  await page.evaluate(async () => {
    // Vite serves the same store module used by App. These fixtures are scoped to the browser test.
    const storePath = '/src/store.ts';
    const activityPath = '/src/activity.ts';
    const { useAppStore } = await import(storePath);
    const { useActivityStore } = await import(activityPath);
    const folder = 'C:/workspace/project';
    const sessions = [
      { id: 'claude', agent: 'Claude Code', title: 'Implementação', folder, status: 'rodando' },
      { id: 'codex', agent: 'Codex', title: 'Revisão', folder, status: 'rodando' },
      { id: 'shell', agent: 'Shell', title: 'Testes locais', folder, status: 'concluído' },
    ];
    useAppStore.getState().setWorkspace({ groups: [], panes: [], projects: [
      { id: 'project', name: 'Agroboard', folder, groupId: null, layout: 'auto', splitRatio: .5, updatedAt: 1 },
    ] });
    for (const session of sessions) useAppStore.getState().upsertSession({ ...session, command: '', resumeId: null, paneId: null });
    useActivityStore.getState().set('claude', { state: 'working', since: Date.now(), message: '', unread: false });
    useActivityStore.getState().set('codex', { state: 'approval', since: Date.now(), message: '', unread: true });
    useAppStore.getState().setMemory({
      totalBytes: 384 * 1024 ** 2, appBytes: 128 * 1024 ** 2, groups: [], agents: [],
      sessions: { claude: { pid: 414, bytes: 192 * 1024 ** 2, cpuPercent: 8.5, runtimeSeconds: 600, suspended: false } },
    });
  });
  const card = page.getByRole('article', { name: 'Implementação · Trabalhando' });
  await expect(card).toBeVisible();
  await expect(page.locator('.mapping-edge')).toHaveCount(0);
  const box = await card.boundingBox();
  if (!box) throw new Error('Agent card is outside the workspace');
  await page.mouse.move(box.x + 35, box.y + 27);
  await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + 51, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('complementary', { name: 'Detalhes do agente' })).toContainText('192 MB');
  await expect(page.getByRole('complementary', { name: 'Detalhes do agente' })).toContainText('8.5%');
  await expect(page.getByRole('region', { name: 'Timeline de atividades' })).toContainText('Aguardando interação');

  await card.focus();
  await page.keyboard.press('l');
  await page.getByRole('article', { name: /Revisão/ }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('l');
  const edge = page.getByRole('button', { name: 'Inspecionar vínculo Implementação → Revisão' });
  await expect(edge).toBeVisible();

  await page.getByRole('button', { name: 'Expandir barra lateral' }).click();
  await expect(page.getByRole('button', { name: 'Recolher barra lateral' })).toBeVisible();
  await page.getByRole('button', { name: 'Recolher barra lateral' }).click();
  await page.getByLabel('Organização do canvas').selectOption('project');
  const group = page.getByRole('button', { name: /Agroboard 3/ });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await group.click();
  await expect(card).toHaveCount(0);
  await group.click();
  await expect(card).toBeVisible();

  for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080], [2560, 1440], [3440, 1440], [850, 480]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Ajustar todos à tela' }).click();
    const toolbar = await page.getByRole('button', { name: 'Opções do mapa' }).boundingBox();
    const canvas = await page.getByRole('region', { name: 'Canvas de agentes' }).boundingBox();
    expect(toolbar && toolbar.x + toolbar.width).toBeLessThanOrEqual(width);
    expect(canvas?.height).toBeGreaterThan(160);
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await card.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Ajustar todos à tela' }).click();
  await page.screenshot({ path: testInfo.outputPath('mapping-1366.png') });

  await page.getByRole('button', { name: 'Expandir canvas' }).click();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeHidden();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recolher minimapa' }).click();
  await page.getByRole('button', { name: 'Atividade', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Mapeamento', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arquitetura', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Organização do canvas')).toHaveValue('project');
  await expect(page.getByRole('button', { name: 'Atividade', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.mapping-minimap')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('xterm keeps its instance, scrollback attachment and input across mapping modes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Mapeamento', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const mocksPath = '/node_modules/@tauri-apps/api/mocks.js';
    const storePath = '/src/store.ts';
    const { mockIPC } = await import(mocksPath);
    const { useAppStore } = await import(storePath);
    const commands: { command: string; args: { id?: string; data?: string } }[] = [];
    Object.defineProperty(window, 'mappingTestCommands', { value: commands });
    mockIPC((command: string, args: { id?: string; data?: string }) => {
      commands.push({ command, args });
      if (command === 'terminal_scrollback') return btoa('scrollback from IPC\r\n');
      if (command === 'agent_links_list') return [];
      return null;
    }, { shouldMockEvents: true });
    useAppStore.getState().upsertSession({
      id: 'shell-pty', title: 'Terminal de teste', agent: 'Shell', status: 'rodando',
      folder: 'C:/workspace', command: 'cmd', resumeId: null, paneId: null,
    });
  });
  await page.getByRole('button', { name: 'Mapeamento', exact: true }).click();
  const card = page.getByRole('article', { name: 'Terminal de teste · Ativo' });
  await card.locator('header').dblclick();
  const textarea = page.locator('.mapping-terminal-content textarea.xterm-helper-textarea');
  await expect(textarea).toBeVisible();
  await textarea.evaluate((element) => element.setAttribute('data-instance', 'first'));
  await page.getByRole('button', { name: 'Minimizar janela' }).click();
  await expect(textarea).toBeHidden();
  await page.getByRole('button', { name: 'Restaurar janela', exact: true }).click();
  await expect(textarea).toBeVisible();
  await page.getByRole('button', { name: 'Arquitetura', exact: true }).click();
  await expect(textarea).toBeHidden();
  await card.locator('header').dblclick();
  await expect(textarea).toHaveAttribute('data-instance', 'first');
  await textarea.focus();
  await page.keyboard.type('dir');
  await page.keyboard.press('Control+f');
  await expect(page.getByRole('textbox', { name: 'Buscar no terminal' })).toBeVisible();
  const count = () => page.evaluate(() => {
    const commands = (window as unknown as { mappingTestCommands: { command: string; args: { id?: string; data?: string } }[] }).mappingTestCommands;
    return {
      scrollbacks: commands.filter((item) => item.command === 'terminal_scrollback').length,
      input: commands.filter((item) => item.command === 'terminal_write' && item.args.id === 'shell-pty').map((item) => item.args.data).join(''),
    };
  });
  const commands = await count();
  expect(commands.scrollbacks).toBeGreaterThan(0);
  await expect.poll(count).toEqual({ scrollbacks: commands.scrollbacks, input: 'dir' });
});
