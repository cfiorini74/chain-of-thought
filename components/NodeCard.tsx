'use client';

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useTreeStore } from '@/lib/store';
import { truncate } from '@/lib/claims';
import type { ResearchNode } from '@/lib/types';

type ResearchFlowNode = Node<{ node: ResearchNode }, 'research'>;

const STATUS_LABEL: Record<string, string> = {
  pending: 'pending…',
  searching: 'searching…',
  synthesizing: 'synthesizing…',
  'rolling-up': 'rolling up…',
};

function firstLine(s: string): string {
  return s.split(/\r?\n/, 1)[0] ?? s;
}

export default function NodeCard({ data }: NodeProps<ResearchFlowNode>) {
  const node = data.node;
  const selectedNodeId = useTreeStore((s) => s.selectedNodeId);
  const tree = useTreeStore((s) => s.tree);

  const isSelected = selectedNodeId === node.id;
  const inProgress = node.status in STATUS_LABEL;
  const isError = node.status === 'error';
  const isDone = node.status === 'done';
  const isStale =
    isDone && (node.rollupStale || node.pendingExclusions.length > 0);

  const claimCount = node.claims.length;
  const contradictedCount = node.claims.filter((c) => c.opposing.length > 0).length;

  let rolledUpTag: string | null = null;
  if (node.rollupIncomplete && tree && node.childIds.length > 0) {
    const total = node.childIds.length;
    const survivors = node.childIds.filter((id) => {
      const c = tree.nodes[id];
      return !!c && c.status !== 'error' && c.rollup.length > 0;
    }).length;
    rolledUpTag = `rolled up from ${survivors} of ${total} branches`;
  }

  const borderClass = isError
    ? 'border-red-500'
    : isSelected
      ? 'border-zinc-900 dark:border-zinc-100'
      : 'border-zinc-300 dark:border-zinc-700';

  return (
    <div
      className={`w-[280px] cursor-pointer rounded-md border-2 ${borderClass} bg-white p-3 text-left text-zinc-900 shadow-sm transition-colors dark:bg-zinc-900 dark:text-zinc-100`}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-400" />
      <div className="line-clamp-2 text-sm font-medium leading-snug">
        {truncate(node.query, 80)}
      </div>

      {inProgress && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent"
            aria-hidden="true"
          />
          <span>{STATUS_LABEL[node.status]}</span>
        </div>
      )}

      {isError && node.error && (
        <div className="mt-2 line-clamp-1 text-xs text-red-600 dark:text-red-400">
          {firstLine(node.error)}
        </div>
      )}

      {claimCount > 0 && (
        <div className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">
          {claimCount} claim{claimCount === 1 ? '' : 's'}
          {contradictedCount > 0 && (
            <span className="ml-1 text-amber-600 dark:text-amber-400">
              · ⚠ {contradictedCount} contradicted
            </span>
          )}
        </div>
      )}

      {(isStale || rolledUpTag) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {isStale && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              summary stale
            </span>
          )}
          {rolledUpTag && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              {rolledUpTag}
            </span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-zinc-400" />
    </div>
  );
}
