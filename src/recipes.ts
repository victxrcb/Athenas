import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type Agent, type Mode, type ProjectInfo, type SessionInfo, type WorkspaceSnapshot } from './store';
import { sameFolder } from './path';

/** Sessions a project opens with one click, or by itself when opened (`autostart`). */
export type RecipeItem = { agent: Agent; mode: Mode; startup?: string | null };
export type Recipe = { autostart: boolean; items: RecipeItem[] };

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** The project's open sessions as recipe items, so "save what I have open" is one click. */
export function recipeFromSessions(sessions: SessionInfo[], project: ProjectInfo): RecipeItem[] {
  return sessions
    .filter((session) => session.status === 'rodando' && sameFolder(session.folder, project.folder))
    .slice(0, 8)
    .map((session) => ({ agent: session.agent, mode: 'Normal' as Mode, startup: null }));
}

/** Opens each item in its own pane of the project; a Shell item types its command once the shell is up. */
export async function runRecipe(project: ProjectInfo, recipe: Recipe): Promise<number> {
  if (!project.folder) throw new Error('O projeto precisa de uma pasta para abrir sessões.');
  const state = useAppStore.getState();
  let started = 0;
  for (const item of recipe.items) {
    const snapshot = await invoke<WorkspaceSnapshot>('pane_create', { projectId: project.id });
    state.setWorkspace(snapshot);
    const paneId = snapshot.panes.filter((pane) => pane.projectId === project.id).at(-1)?.id ?? null;
    const prompt = item.agent !== 'Shell' && item.startup?.trim() ? item.startup.trim() : null;
    const session = await invoke<SessionInfo>('terminal_start', {
      agent: item.agent, folder: project.folder, command: '', resumeId: null, paneId, resume: false,
      mode: item.agent === 'Shell' ? 'Normal' : item.mode, initialPrompt: prompt, cols: 100, rows: 30, title: null,
    });
    state.upsertSession(session);
    started += 1;
    if (item.agent === 'Shell' && item.startup?.trim()) {
      const command = item.startup.trim();
      // The shell needs a moment to print its prompt; typed earlier, the command can be lost.
      void wait(900).then(() => invoke('terminal_write', { id: session.id, data: `${command}\r` })).catch(() => undefined);
    }
  }
  return started;
}

export async function saveRecipe(project: ProjectInfo, recipe: Recipe | null) {
  useAppStore.getState().setWorkspace(await invoke<WorkspaceSnapshot>('project_set_recipe', { id: project.id, recipe }));
}

const autoStarted = new Set<string>();

/** Runs the recipe the first time a project with `autostart` is opened in this app run, if nothing runs there yet. */
export function maybeAutostart(project: ProjectInfo | undefined) {
  if (!project?.recipe?.autostart || autoStarted.has(project.id)) return;
  autoStarted.add(project.id);
  const running = useAppStore.getState().sessions.some((session) => session.status === 'rodando' && sameFolder(session.folder, project.folder));
  if (running) return;
  void runRecipe(project, project.recipe).catch((error) => useAppStore.getState().setNotice(`Receita de "${project.name}": ${error}`));
}
