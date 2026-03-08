import { useState, useEffect } from 'react';
import type { Orchestrator, CerebellumStatus, TaskAction } from '@cereworker/core';

export function useCerebellum(orchestrator: Orchestrator) {
  const [status, setStatus] = useState<CerebellumStatus | null>(null);
  const [lastActions, setLastActions] = useState<TaskAction[]>([]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      orchestrator.on('cerebellum:status', ({ status: s }) => {
        setStatus(s);
      }),
    );

    unsubs.push(
      orchestrator.on('heartbeat:tick', ({ actions }) => {
        setLastActions(actions);
      }),
    );

    return () => unsubs.forEach((u) => u());
  }, [orchestrator]);

  return { status, lastActions };
}
