import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export async function chooseFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const chosen = await open({ directory: true, multiple: false, title: 'Escolher pasta do projeto' });
  return typeof chosen === 'string' ? chosen : null;
}
