import { create } from 'zustand';

export type Agent = 'Claude Code' | 'Codex' | 'Shell';
export type Mode = 'Normal' | 'Plan' | 'Auto-aceitar';
export type SessionInfo = { id: string; agent: Agent; folder: string; command: string; resumeId: string | null; paneId: string | null; status: string };
export type GroupInfo = { id: string; name: string };
export type ProjectInfo = { id: string; groupId: string | null; name: string; folder: string | null; layout: 'auto' | 'spotlight' | 'sidebar' | 'grid'; splitRatio: number; updatedAt: number };
export type PaneInfo = { id: string; projectId: string; position: number };
export type WorkspaceSnapshot = { groups: GroupInfo[]; projects: ProjectInfo[]; panes: PaneInfo[] };
export type MemorySnapshot = { totalBytes: number; groups: { groupId: string; bytes: number; suspended: boolean }[] };
export type Section = 'home' | 'git' | 'mcp' | 'skills';

type AppState = {
  sessionOpen: boolean;
  projectOpen: boolean;
  groupOpen: boolean;
  notice: string | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  workspace: WorkspaceSnapshot;
  memory: MemorySnapshot;
  setMemory: (memory: MemorySnapshot) => void;
  activeProjectId: string | null;
  paletteOpen: boolean;
  section: Section;
  setSection: (section: Section) => void;
  targetPaneId: string | null;
  openSessionInPane: (paneId: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setWorkspace: (workspace: WorkspaceSnapshot) => void;
  setActiveProjectId: (id: string | null) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  upsertSession: (session: SessionInfo) => void;
  setActiveSessionId: (id: string | null) => void;
  openSession: () => void;
  closeSession: () => void;
  openProject: () => void;
  closeProject: () => void;
  openGroup: () => void;
  closeGroup: () => void;
  setNotice: (message: string | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  sessionOpen: false, projectOpen: false, groupOpen: false, notice: null, sessions: [], activeSessionId: null,
  workspace: { groups: [], projects: [], panes: [] }, memory: { totalBytes: 0, groups: [] }, activeProjectId: null, paletteOpen: false, targetPaneId: null, section: 'home',
  setSection: (section) => set({ section }),
  setMemory: (memory) => set({ memory }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setWorkspace: (workspace) => set({ workspace }),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (session) => set((state) => ({ sessions: [...state.sessions.filter((item) => item.id !== session.id), session] })),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  openSession: () => set({ sessionOpen: true, targetPaneId: null }),
  openSessionInPane: (targetPaneId) => set({ sessionOpen: true, targetPaneId }),
  closeSession: () => set({ sessionOpen: false }),
  openProject: () => set({ projectOpen: true }),
  closeProject: () => set({ projectOpen: false }),
  openGroup: () => set({ groupOpen: true }),
  closeGroup: () => set({ groupOpen: false }),
  setNotice: (notice) => set({ notice }),
}));
