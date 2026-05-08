'use client';

import { useEffect } from 'react';
import { useTreeStore } from '@/lib/store';
import ResearchGraph from './ResearchGraph';
import SidePanel from './SidePanel';

interface CanvasProps {
  onNewQuery: () => void;
}

export default function Canvas({ onNewQuery }: CanvasProps) {
  const tree = useTreeStore((s) => s.tree);
  const selectedNodeId = useTreeStore((s) => s.selectedNodeId);
  const selectNode = useTreeStore((s) => s.selectNode);

  const initialBuildSettled = tree?.initialBuildSettled ?? false;
  const rootId = tree?.rootId;

  useEffect(() => {
    // Only auto-select root on settle if the user hasn't already selected something.
    if (initialBuildSettled && rootId && useTreeStore.getState().selectedNodeId === null) {
      selectNode(rootId);
    }
  }, [initialBuildSettled, rootId, selectNode]);

  if (!tree || !rootId) return null;

  const rootQuery = tree.nodes[rootId]?.query ?? '';

  return (
    <div className="flex h-full w-full min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {rootQuery}
        </h1>
        <button
          type="button"
          onClick={onNewQuery}
          className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          New query
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1">
          <ResearchGraph />
        </div>
        {selectedNodeId !== null && <SidePanel />}
      </div>
    </div>
  );
}
