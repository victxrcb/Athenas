import { create } from 'zustand';

export type Agent = 'Claude Code' | 'Codex' | 'Shell';
export type Mode = 'Normal' | 'Plan' | 'Auto-aceitar';
export type SessionInfo = { id: string; agent: Agent; folder: string; command: string; resumeId: string | null; paneId: string | null; status: string; title?: string | null };
export type GroupInfo = { id: string; name: string };
export type ProjectInfo = { id: string; groupId: string | null; name: string; folder: string | null; layout: 'auto' | 'spotlight' | 'sidebar' | 'grid'; splitRatio: number; icon?: string | null; repoUrl?: string | null; updatedAt: number; recipe?: import('./recipes').Recipe | null };
export type PaneInfo = { id: string; projectId: string; position: number; pinned: boolean };
export type WorkspaceSnapshot = { groups: GroupInfo[]; projects: ProjectInfo[]; panes: PaneInfo[] };
export type AgentUsage = { agent: string; sessions: number; bytes: number; cpuPercent: number };
export type MemorySnapshot = { totalBytes: number; appBytes: number; groups: { groupId: string; bytes: number; suspended: boolean }[]; agents: AgentUsage[] };
export type Preferences = { claudeCommand: string; codexCommand: string; shellCommand: string; workerLimit: number; scrollbackMb: number; fontSize: number; reducedEffects: boolean };
export type Section = 'home' | 'git' | 'mcp' | 'skills' | 'orchestrator' | 'mapping' | 'inbox' | 'history' | 'reminders';
/** Live orchestrator counters shown in navigation; polled once by the app shell. */
export type WorkerSummary = { active: number; waiting: number };

type AppState = {
  sessionOpen: boolean;
  projectOpen: boolean;
  groupOpen: boolean;
  notice: string | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  workspace: WorkspaceSnapshot;
  memory: MemorySnapshot;
  preferences: Preferences;
  setPreferences: (preferences: Preferences) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setMemory: (memory: MemorySnapshot) => void;
  workerSummary: WorkerSummary;
  setWorkerSummary: (summary: WorkerSummary) => void;
  activeProjectId: string | null;
  paletteOpen: boolean;
  section: Section;
  setSection: (section: Section) => void;
  targetPaneId: string | null;
  mappingSession: { projectId: string | null; onCreated: (session: SessionInfo) => void } | null;
  openMappingSession: (projectId: string | null, onCreated: (session: SessionInfo) => void) => void;
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
  workspace: { groups: [], projects: [], panes: [] }, memory: { totalBytes: 0, appBytes: 0, groups: [], agents: [] }, preferences: { claudeCommand: 'claude', codexCommand: 'codex', shellCommand: 'powershell.exe', workerLimit: 3, scrollbackMb: 5, fontSize: 13, reducedEffects: false }, settingsOpen: false, workerSummary: { active: 0, waiting: 0 }, activeProjectId: null, paletteOpen: false, targetPaneId: null, section: 'home',
  setPreferences: (preferences) => set({ preferences }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSection: (section) => set({ section }),
  setMemory: (memory) => set({ memory }),
  setWorkerSummary: (workerSummary) => set((state) => (state.workerSummary.active === workerSummary.active && state.workerSummary.waiting === workerSummary.waiting ? state : { workerSummary })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setWorkspace: (workspace) => set({ workspace }),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setSessions: (sessions) => set({ sessions }),
  // Updates keep the session's place in the list; new sessions go to the end.
  upsertSession: (session) => set((state) => (state.sessions.some((item) => item.id === session.id)
    ? { sessions: state.sessions.map((item) => (item.id === session.id ? session : item)) }
    : { sessions: [...state.sessions, session] })),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  mappingSession: null,
  openMappingSession: (projectId, onCreated) => set({ sessionOpen: true, targetPaneId: null, mappingSession: { projectId, onCreated } }),
  openSession: () => set({ sessionOpen: true, targetPaneId: null, mappingSession: null }),
  openSessionInPane: (targetPaneId) => set({ sessionOpen: true, targetPaneId, mappingSession: null }),
  closeSession: () => set({ sessionOpen: false, mappingSession: null }),
  openProject: () => set({ projectOpen: true }),
  closeProject: () => set({ projectOpen: false }),
  openGroup: () => set({ groupOpen: true }),
  closeGroup: () => set({ groupOpen: false }),
  setNotice: (notice) => set({ notice }),
}));
