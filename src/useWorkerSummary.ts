import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useAppStore } from './store';
import { notifyWorkers, workerTransitions, type WorkerLike } from './notifications';

/** Polls orchestrator workers across all projects so navigation can show live and pending counts. */
export function useWorkerSummaryPolling() {
  const setWorkerSummary = useAppStore((state) => state.setWorkerSummary);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let previous: Map<string, string> | null = null;
    const refresh = () => {
      void invoke<WorkerLike[]>('orchestration_list', { project: null }).then((workers) => {
        if (!alive) return;
        setWorkerSummary({
          active: workers.filter((worker) => worker.status === 'running' || worker.status === 'queued').length,
          waiting: workers.filter((worker) => worker.status === 'awaiting_permission' || worker.status === 'interrupted').length,
        });
        notifyWorkers(workerTransitions(previous, workers));
        previous = new Map(workers.map((worker) => [worker.id, worker.status]));
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [setWorkerSummary]);
}
