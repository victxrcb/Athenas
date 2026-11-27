/** Tells the backend how each running agent looks on this screen, so the phone shows the same. */
import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { liveStatus, useActivityStore, type Activity } from '../activity';
import { translateAgentMessage } from '../notifications';
import { sameFolder } from '../path';
import { useAppStore, type SessionInfo, type WorkspaceSnapshot } from '../store';
import { loadTheme } from '../themes';

export type PublishedAgent = { id: string; project: string | null; tone: string; label: string; message: string; since: number | null; state: string };

export function publishedAgents(sessions: SessionInfo[], workspace: WorkspaceSnapshot, activity: Record<string, Activity>): PublishedAgent[] {
  return sessions
    .filter((session) => session.agent !== 'Shell' && (session.status === 'rodando' || session.status === 'iniciando'))
    .map((session) => {
      const pane = workspace.panes.find((item) => item.id === session.paneId);
      const project = workspace.projects.find((item) => (pane ? item.id === pane.projectId : sameFolder(item.folder, session.folder)));
      const current = activity[session.id];
      const status = liveStatus(session, current);
      // Only a pending request needs its text. A finished turn's message can quote the answer, so it stays here.
      const message = status.tone === 'waiting' ? translateAgentMessage(current?.message ?? '') : '';
      return { id: session.id, project: project?.name ?? null, tone: status.tone, label: status.label, message, since: current?.since ?? null, state: current?.state ?? '' };
    });
}

/** Mounted once by the app shell. */
export function useMobilePublish() {
  useEffect(() => {
    if (!isTauri()) return;
    let last = '';
    const publish = () => {
      const { sessions, workspace } = useAppStore.getState();
      const snapshot = { theme: loadTheme(), items: publishedAgents(sessions, workspace, useActivityStore.getState().activity) };
      const text = JSON.stringify(snapshot);
      if (text === last) return;
      last = text;
      // A failed report is sent again with the next change.
      void Promise.resolve(invoke('mobile_publish', { snapshot })).catch(() => { last = ''; });
    };
    const offApp = useAppStore.subscribe(publish);
    const offActivity = useActivityStore.subscribe(publish);
    window.addEventListener('athenas-theme', publish);
    publish();
    return () => { offApp(); offActivity(); window.removeEventListener('athenas-theme', publish); };
  }, []);
}
