'use client';

import { useEffect, useRef } from 'react';
import { useTreeStore } from '@/lib/store';
import { buildInitialTree } from '@/lib/orchestrator';
import Landing from './Landing';
import Canvas from './Canvas';

export default function ResearchApp() {
  const tree = useTreeStore((s) => s.tree);
  const reset = useTreeStore((s) => s.reset);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  function handleSubmit(query: string) {
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    buildInitialTree(query, ctrl.signal).catch((err) => {
      if ((err as { name?: string })?.name === 'AbortError') return;
      console.error('buildInitialTree failed:', err);
    });
  }

  function handleNewQuery() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    reset();
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {tree === null ? (
        <Landing onSubmit={handleSubmit} />
      ) : (
        <Canvas onNewQuery={handleNewQuery} />
      )}
    </div>
  );
}
