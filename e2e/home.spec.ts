import { expect, test } from '@playwright/test';

test('home and new session flow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Projetos recentes')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/home.png', fullPage: true });
  await page.getByRole('button', { name: 'Novo agente' }).click();
  await expect(page.getByRole('dialog', { name: 'Nova sessão' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/nova-sessao.png', fullPage: true });
  await page.getByLabel('Pasta', { exact: true }).fill('C:\\dev\\demo');
  await page.getByRole('button', { name: 'Abrir Claude Code' }).click();
  await expect(page.getByRole('status')).toContainText('Abra o aplicativo desktop');
});
