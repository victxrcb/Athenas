import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type SessionInfo, type WorkspaceSnapshot } from './store';

/** Deletes a session and drops any pane left without sessions, so the project view stays clean. */
export async function deleteSession(id: string) {
  await invoke('terminal_delete', { id });
  const sessions = await invoke<SessionInfo[]>('terminal_list');
  const state = useAppStore.getState();
  state.setSessions(sessions);
  for (const pane of state.workspace.panes) {
    if (pane.pinned || sessions.some((session) => session.paneId === pane.id)) continue;
    state.setWorkspace(await invoke<WorkspaceSnapshot>('pane_delete', { id: pane.id }));
  }
}
