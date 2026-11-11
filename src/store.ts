import { create } from 'zustand';

export type Agent = 'Claude Code' | 'Codex' | 'Shell';
export type Mode = 'Normal' | 'Plan' | 'Auto-aceitar';
export type SessionInfo = { id: string; agent: Agent; folder: string; command: string; resumeId: string | null; status: string };

type AppState = {
  sessionOpen: boolean;
  projectOpen: boolean;
  groupOpen: boolean;
  notice: string | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
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
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (session) => set((state) => ({ sessions: [...state.sessions.filter((item) => item.id !== session.id), session] })),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  openSession: () => set({ sessionOpen: true }),
  closeSession: () => set({ sessionOpen: false }),
  openProject: () => set({ projectOpen: true }),
  closeProject: () => set({ projectOpen: false }),
  openGroup: () => set({ groupOpen: true }),
  closeGroup: () => set({ groupOpen: false }),
  setNotice: (notice) => set({ notice }),
}));
