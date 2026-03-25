import { useState, useEffect } from 'react';
import type { Orchestrator, CerebellumStatus, TaskAction } from '@cereworker/core';

export interface FineTuneInfo {
  active: boolean;
  jobId: string;
  progress: number;
  loss: number;
}

export interface CerebellumLoading {
  phase: string;
  attempt?: number;
  maxAttempts?: number;
}

export function useCerebellum(orchestrator: Orchestrator) {
  const [status, setStatus] = useState<CerebellumStatus | null>(null);
  const [loading, setLoading] = useState<CerebellumLoading | null>(null);
  const [lastActions, setLastActions] = useState<TaskAction[]>([]);
  const [finetune, setFinetune] = useState<FineTuneInfo>({
    active: false,
    jobId: '',
    progress: 0,
    loss: 0,
  });
  const [taskRunningCount, setTaskRunningCount] = useState(0);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      orchestrator.on('cerebellum:loading', (event) => {
        setLoading({ phase: event.phase, attempt: event.attempt, maxAttempts: event.maxAttempts });
      }),
    );

    unsubs.push(
      orchestrator.on('cerebellum:status', ({ status: s }) => {
        setLoading(null);
        setStatus(s);
      }),
    );

    unsubs.push(
      orchestrator.on('heartbeat:tick', ({ actions }) => {
        setLastActions(actions);
      }),
    );

    unsubs.push(
      orchestrator.on('finetune:start', ({ jobId }) => {
        setFinetune({ active: true, jobId, progress: 0, loss: 0 });
      }),
    );

    unsubs.push(
      orchestrator.on('finetune:progress', ({ jobId, progress, loss }) => {
        setFinetune({ active: true, jobId, progress, loss });
      }),
    );

    unsubs.push(
      orchestrator.on('finetune:complete', () => {
        setFinetune((prev) => ({ ...prev, active: false, progress: 1 }));
      }),
    );

    unsubs.push(
      orchestrator.on('finetune:error', () => {
        setFinetune((prev) => ({ ...prev, active: false }));
      }),
    );

    unsubs.push(
      orchestrator.on('task:start', () => {
        setTaskRunningCount((c) => c + 1);
      }),
    );

    unsubs.push(
      orchestrator.on('task:complete', () => {
        setTaskRunningCount((c) => Math.max(0, c - 1));
      }),
    );

    unsubs.push(
      orchestrator.on('task:error', () => {
        setTaskRunningCount((c) => Math.max(0, c - 1));
      }),
    );

    return () => unsubs.forEach((u) => u());
  }, [orchestrator]);

  return { status, loading, lastActions, finetune, taskRunningCount };
}
