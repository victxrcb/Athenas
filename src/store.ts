import { create } from 'zustand';

export type Agent = 'Claude Code' | 'Codex' | 'Shell';
export type Mode = 'Normal' | 'Plan' | 'Auto-aceitar';

type AppState = {
  sessionOpen: boolean;
  projectOpen: boolean;
  groupOpen: boolean;
  notice: string | null;
  openSession: () => void;
  closeSession: () => void;
  openProject: () => void;
  closeProject: () => void;
  openGroup: () => void;
  closeGroup: () => void;
  setNotice: (message: string | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  sessionOpen: false, projectOpen: false, groupOpen: false, notice: null,
  openSession: () => set({ sessionOpen: true }),
  closeSession: () => set({ sessionOpen: false }),
  openProject: () => set({ projectOpen: true }),
  closeProject: () => set({ projectOpen: false }),
  openGroup: () => set({ groupOpen: true }),
  closeGroup: () => set({ groupOpen: false }),
  setNotice: (notice) => set({ notice }),
}));
