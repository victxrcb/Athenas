import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useAppStore } from './store';

/** Polls orchestrator workers across all projects so navigation can show live and pending counts. */
export function useWorkerSummaryPolling() {
  const setWorkerSummary = useAppStore((state) => state.setWorkerSummary);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const refresh = () => {
      void invoke<{ status: string }[]>('orchestration_list', { project: null }).then((workers) => {
        if (!alive) return;
        setWorkerSummary({
          active: workers.filter((worker) => worker.status === 'running' || worker.status === 'queued').length,
          waiting: workers.filter((worker) => worker.status === 'awaiting_permission' || worker.status === 'interrupted').length,
        });
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [setWorkerSummary]);
}
