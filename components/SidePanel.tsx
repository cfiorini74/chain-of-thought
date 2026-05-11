'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isNodeBusy, useTreeStore } from '@/lib/store';
import { callPlanAgent } from '@/lib/agents';
import {
  expandNode,
  isAbortError,
  markChainStale,
  MAX_TOTAL_NODES,
  resetAndRebuild,
  summarizeSubtree,
} from '@/lib/orchestrator';
import { corroborationCount, normalizeStatement, truncate } from '@/lib/claims';
import type { Claim, ClaimSource, NodeStatus, ResearchNode, SearchResult } from '@/lib/types';
import DeepenPopover from './DeepenPopover';

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'Pending',
  searching: 'Searching…',
  synthesizing: 'Synthesizing…',
  'rolling-up': 'Summarizing…',
  done: 'Done',
  error: 'Error',
};

function sourceRowId(nodeId: string, n: number): string {
  return `source-${nodeId}-${n}`;
}

function renderFindings(
  findings: string,
  sources: SearchResult[],
  onCitationClick: (n: number) => void
): ReactNode {
  if (!findings) {
    return <span className="text-zinc-500 italic">no findings yet</span>;
  }
  const parts: ReactNode[] = [];
  const re = /\[(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(findings)) !== null) {
    if (match.index > lastIndex) {
      parts.push(findings.slice(lastIndex, match.index));
    }
    const n = Number(match[1]);
    const valid = n >= 1 && n <= sources.length;
    if (valid) {
      parts.push(
        <button
          key={`c-${key++}`}
          type="button"
          onClick={() => onCitationClick(n)}
          className="mx-0.5 rounded bg-zinc-100 px-1 py-0 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          [{n}]
        </button>
      );
    } else {
      parts.push(match[0]);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < findings.length) {
    parts.push(findings.slice(lastIndex));
  }
  return <>{parts}</>;
}

interface ClaimRowProps {
  claim: Claim;
  ownerNode: ResearchNode;
  nodes: Record<string, ResearchNode>;
  excluded: boolean;
  onToggleExclude: (statement: string) => void;
  onOriginClick: (nodeId: string) => void;
  onCitationClick: (n: number) => void;
  sourceCount: number;
}

const ClaimRow = memo(function ClaimRow({
  claim,
  ownerNode,
  nodes,
  excluded,
  onToggleExclude,
  onOriginClick,
  onCitationClick,
  sourceCount,
}: ClaimRowProps) {
  // sourceIndices on a child-scoped source point into the child's findings,
  // not this node's — only own (childId=null) entries yield citations.
  // Take the first quote associated with each index on this side so users
  // can tell apart support vs opposition when the same source backs both.
  const sideCitations = (
    sources: ClaimSource[]
  ): { n: number; quote?: string }[] => {
    const map = new Map<number, string | undefined>();
    for (const s of sources) {
      if (s.childId !== null) continue;
      for (const n of s.sourceIndices ?? []) {
        if (n < 1 || n > sourceCount) continue;
        if (!map.has(n)) map.set(n, s.quote);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([n, quote]) => ({ n, quote }));
  };

  const sideBranches = (
    sources: ClaimSource[]
  ): { childId: string; quote?: string }[] => {
    const seen = new Set<string>();
    const out: { childId: string; quote?: string }[] = [];
    for (const s of sources) {
      if (s.childId === null) continue;
      if (seen.has(s.childId)) continue;
      seen.add(s.childId);
      out.push({ childId: s.childId, quote: s.quote });
    }
    return out;
  };

  const renderCitation = ({
    n,
    quote,
  }: {
    n: number;
    quote?: string;
  }): ReactNode => (
    <span key={`cite-${n}`}>
      <button
        type="button"
        onClick={() => onCitationClick(n)}
        className="rounded bg-zinc-100 px-1 py-0 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
      >
        [{n}]
      </button>
      {quote && (
        <span className="ml-1 italic text-zinc-500 dark:text-zinc-400">
          “{truncate(quote, 80)}”
        </span>
      )}
    </span>
  );

  const renderBranch = (b: { childId: string; quote?: string }): ReactNode => {
    const idx = ownerNode.childIds.indexOf(b.childId);
    const exists = !!nodes[b.childId];
    const label =
      idx >= 0 ? `Branch ${idx + 1}` : exists ? 'unknown branch' : 'deleted branch';
    return (
      <span key={`branch-${b.childId}`}>
        {exists ? (
          <button
            type="button"
            onClick={() => onOriginClick(b.childId)}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
            title={nodes[b.childId]?.query}
          >
            {label}
          </button>
        ) : (
          <span className="italic text-zinc-400 dark:text-zinc-600">{label}</span>
        )}
        {b.quote && (
          <span className="ml-1 italic text-zinc-500 dark:text-zinc-400">
            “{truncate(b.quote, 80)}”
          </span>
        )}
      </span>
    );
  };

  const supportItems: ReactNode[] = [
    ...sideCitations(claim.supporting).map(renderCitation),
    ...sideBranches(claim.supporting).map(renderBranch),
  ];
  const opposeItems: ReactNode[] = [
    ...sideBranches(claim.opposing).map(renderBranch),
    ...sideCitations(claim.opposing).map(renderCitation),
  ];

  const hasSupport = claim.supporting.length > 0;
  const hasOppose = claim.opposing.length > 0;
  const corroboration = corroborationCount(claim);

  const bodyClass = excluded
    ? 'text-zinc-400 line-through dark:text-zinc-600'
    : '';

  return (
    <li className="text-sm">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => onToggleExclude(claim.statement)}
          aria-label={excluded ? 'Re-include this claim' : 'Exclude this claim from bubbling up'}
          title={
            excluded
              ? 'Re-include this claim (will be sent up on next Summarize)'
              : 'Exclude this claim from bubbling up (takes effect on next Summarize)'
          }
          className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-xs leading-none text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          {excluded ? '↶' : '×'}
        </button>
        <div className={`flex-1 ${bodyClass}`}>
          <span className="font-medium">{claim.topic}.</span>{' '}
          {claim.statement}
          {corroboration > 1 && (
            <span className="ml-1.5 inline-block rounded bg-emerald-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              ✓ in {corroboration} branches
            </span>
          )}
          {hasSupport && (
            <div className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400">
              ✓ Supported by{' '}
              {supportItems.length > 0
                ? joinWithComma(supportItems)
                : `${claim.supporting.length} source${claim.supporting.length === 1 ? '' : 's'}`}
            </div>
          )}
          {hasOppose && (
            <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
              ⚠ Contradicted by{' '}
              {opposeItems.length > 0
                ? joinWithComma(opposeItems)
                : `${claim.opposing.length} source${claim.opposing.length === 1 ? '' : 's'}`}
            </div>
          )}
          {claim.originNodeIds.length > 0 && (
            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              From:{' '}
              {claim.originNodeIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  {renderOrigin(id, ownerNode.id, nodes, onOriginClick)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
});

function joinWithComma(items: ReactNode[]): ReactNode {
  return items.map((item, i) => (
    <span key={i}>
      {i > 0 ? ', ' : ''}
      {item}
    </span>
  ));
}

function renderOrigin(
  id: string,
  ownerId: string,
  nodes: Record<string, ResearchNode>,
  onClick: (nodeId: string) => void
): ReactNode {
  if (id === ownerId) return <span className="italic">this node</span>;
  const target = nodes[id];
  if (!target) {
    return (
      <span className="italic text-zinc-400 dark:text-zinc-600">
        deleted node
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className="text-blue-600 hover:underline dark:text-blue-400"
      title={target.query}
    >
      “{truncate(target.query, 50)}”
    </button>
  );
}

function countDescendants(
  nodeId: string,
  nodes: Record<string, ResearchNode>
): number {
  let count = 0;
  const walk = (id: string) => {
    const n = nodes[id];
    if (!n) return;
    for (const cid of n.childIds) {
      count++;
      walk(cid);
    }
  };
  walk(nodeId);
  return count;
}

export default function SidePanel() {
  const tree = useTreeStore((s) => s.tree);
  const selectedNodeId = useTreeStore((s) => s.selectedNodeId);
  const selectNode = useTreeStore((s) => s.selectNode);
  const inFlightOps = useTreeStore((s) => s.inFlightOps);
  const startOp = useTreeStore((s) => s.startOp);
  const endOp = useTreeStore((s) => s.endOp);

  const [editingQuery, setEditingQuery] = useState(false);
  const [queryDraft, setQueryDraft] = useState('');
  const [highlightedSource, setHighlightedSource] = useState<number | null>(null);
  const [expandRows, setExpandRows] = useState<string[] | null>(null);
  const [plannerLoading, setPlannerLoading] = useState(false);

  // Planner fetch outlives node switches; the resolve handler in startExpand
  // gates on controller identity + selected node so stale results are dropped.
  const plannerControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setEditingQuery(false);
    setExpandRows(null);
    setPlannerLoading(false);
  }, [selectedNodeId]);

  useEffect(() => {
    return () => {
      plannerControllerRef.current?.abort();
    };
  }, []);

  if (!tree || !selectedNodeId) return null;
  const node = tree.nodes[selectedNodeId];
  if (!node) return null;

  const isError = node.status === 'error';
  const isRoot = node.parentId === null;
  const hasChildren = node.childIds.length > 0;
  const isFinishedNode = node.status === 'done';
  const initialBuildSettled = tree.initialBuildSettled;

  const nodeBusy = isNodeBusy(node.id, tree, inFlightOps);
  const reshapeDisabled = !initialBuildSettled || nodeBusy;
  const totalNodes = Object.keys(tree.nodes).length;
  const atCapacity = totalNodes >= MAX_TOTAL_NODES;

  const sortedClaims = useMemo(
    () =>
      [...node.claims].sort(
        (a, b) => corroborationCount(b) - corroborationCount(a)
      ),
    [node.claims]
  );

  const showFindingsBlock = !isError;
  // Leaves usually hide Summarize, but expose it when the leaf is stale or
  // has no claims so the user has a retry path after a rollup abort or
  // empty model output.
  const showSummarizeButton =
    isFinishedNode &&
    (hasChildren || node.rollupStale || node.claims.length === 0);
  const showExpandButton = isFinishedNode;
  const showDeleteButton = !isRoot;
  const showQueryEdit = isFinishedNode || isError;

  const handleCitationClick = useCallback(
    (n: number) => {
      const el = document.getElementById(sourceRowId(node.id, n));
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedSource(n);
      window.setTimeout(
        () => setHighlightedSource((cur) => (cur === n ? null : cur)),
        1000
      );
    },
    [node.id]
  );

  // === Edit query ===
  function startEditQuery() {
    setQueryDraft(node.query);
    setEditingQuery(true);
  }
  async function saveEditQuery() {
    const next = queryDraft.trim();
    if (!next) return;
    if (next === node.query) {
      setEditingQuery(false);
      return;
    }
    const desc = countDescendants(node.id, tree!.nodes);
    if (
      desc > 0 &&
      !window.confirm(`This will wipe ${desc} descendant${desc === 1 ? '' : 's'}. Continue?`)
    ) {
      return;
    }
    setEditingQuery(false);
    const originId = node.id;
    const controller = new AbortController();
    startOp(originId, controller);
    try {
      await resetAndRebuild(originId, next, controller.signal);
    } catch (e) {
      if (!isAbortError(e)) {
        console.error('resetAndRebuild failed:', e);
      }
    } finally {
      endOp(originId);
    }
  }

  // === Toggle claim exclusion ===
  const handleToggleExclude = useCallback(
    (statement: string) => {
      useTreeStore.getState().toggleClaimExclusion(node.id, statement);
    },
    [node.id]
  );

  // === Summarize ===
  async function summarize() {
    const originId = node.id;
    const controller = new AbortController();
    startOp(originId, controller);
    try {
      await summarizeSubtree(originId, controller.signal);
    } catch (e) {
      if (!isAbortError(e)) {
        console.error('summarize failed:', e);
      }
    } finally {
      endOp(originId);
    }
  }

  // === Delete subtree ===
  async function deleteSubtreeAction() {
    const desc = countDescendants(node.id, tree!.nodes);
    const message =
      desc > 0
        ? `Delete this node and ${desc} descendant${desc === 1 ? '' : 's'}?`
        : 'Delete this node?';
    if (!window.confirm(message)) return;

    const parentId = node.parentId;
    if (!parentId) {
      useTreeStore.getState().deleteSubtree(node.id);
      useTreeStore.getState().selectNode(null);
      return;
    }
    useTreeStore.getState().deleteSubtree(node.id);
    useTreeStore.getState().selectNode(parentId);
    markChainStale(parentId);
  }

  // === Expand ===
  async function startExpand() {
    // Re-expansion (children exist): skip the planner so user-added
    // sub-questions are fully custom and not duplicates of prior suggestions.
    if (hasChildren) {
      setExpandRows(['']);
      return;
    }

    // Initial expansion: seed with planner suggestions the user can edit.
    const startNodeId = node.id;
    setPlannerLoading(true);
    const rootQuery = tree?.nodes[tree.rootId]?.query ?? node.query;
    plannerControllerRef.current?.abort();
    const controller = new AbortController();
    plannerControllerRef.current = controller;
    const isCurrent = () =>
      plannerControllerRef.current === controller &&
      useTreeStore.getState().selectedNodeId === startNodeId;
    try {
      const result = await callPlanAgent(
        node.query,
        node.findings,
        rootQuery,
        controller.signal
      );
      if (!isCurrent()) return;
      const subs = result.subquestions.length > 0 ? result.subquestions : [''];
      setExpandRows(subs);
    } catch (e) {
      if (isAbortError(e)) return;
      if (!isCurrent()) return;
      console.error('planner call failed:', e);
      setExpandRows(['']);
    } finally {
      if (isCurrent()) setPlannerLoading(false);
    }
  }
  async function confirmExpand(rows: string[]) {
    const filtered = rows.map((s) => s.trim()).filter(Boolean);
    setExpandRows(null);
    if (filtered.length === 0) return;
    const originId = node.id;
    const controller = new AbortController();
    startOp(originId, controller);
    try {
      await expandNode(originId, filtered, controller.signal);
    } catch (e) {
      if (!isAbortError(e)) {
        console.error('expandNode failed:', e);
      }
    } finally {
      endOp(originId);
    }
  }

  const sources = node.searchResults;
  const popoverActive = expandRows !== null;

  return (
    <aside className="flex h-full w-[420px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {isRoot ? 'Root' : 'Node'}
        </h2>
        <button
          type="button"
          onClick={() => selectNode(null)}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 text-zinc-800 dark:text-zinc-200">
        <Section
          label="Query"
          right={
            showQueryEdit && !editingQuery ? (
              <EditButton onClick={startEditQuery} disabled={reshapeDisabled} />
            ) : undefined
          }
        >
          {editingQuery ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={queryDraft}
                onChange={(e) => setQueryDraft(e.target.value)}
                rows={3}
                autoFocus
                className="w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <div className="flex justify-end gap-2">
                <SecondaryButton onClick={() => setEditingQuery(false)}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton
                  onClick={saveEditQuery}
                  disabled={
                    reshapeDisabled ||
                    queryDraft.trim().length === 0 ||
                    queryDraft.trim() === node.query
                  }
                >
                  Save
                </PrimaryButton>
              </div>
            </div>
          ) : (
            <p className="text-sm leading-snug">{node.query}</p>
          )}
        </Section>

        <Section label="Status">
          <p className={`text-sm ${isError ? 'text-red-600 dark:text-red-400' : ''}`}>
            {STATUS_LABEL[node.status] ?? node.status}
          </p>
          {isError && node.error && (
            <p className="mt-1 whitespace-pre-wrap rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {node.error}
            </p>
          )}
        </Section>

        {showFindingsBlock && (
          <>
            <Section label="Findings">
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {renderFindings(node.findings, sources, handleCitationClick)}
              </div>
            </Section>

            {isFinishedNode && (
              <Section label="Claims">
                {node.claims.length === 0 ? (
                  <p className="text-sm text-zinc-500 italic">
                    no claims extracted{hasChildren ? ' — try Summarize to retry' : ''}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {sortedClaims.map((c, i) => (
                      <ClaimRow
                        key={`${c.topic}-${i}`}
                        claim={c}
                        ownerNode={node}
                        nodes={tree.nodes}
                        excluded={node.excludedStatements.includes(
                          normalizeStatement(c.statement)
                        )}
                        onToggleExclude={handleToggleExclude}
                        onOriginClick={selectNode}
                        onCitationClick={handleCitationClick}
                        sourceCount={sources.length}
                      />
                    ))}
                  </ul>
                )}
              </Section>
            )}

            <Section label="Sources">
              {sources.length === 0 ? (
                <p className="text-sm text-zinc-500 italic">no sources</p>
              ) : (
                <ul className="space-y-3">
                  {sources.map((src, i) => {
                    const n = i + 1;
                    const isHighlighted = highlightedSource === n;
                    return (
                      <li
                        key={src.url + i}
                        id={sourceRowId(node.id, n)}
                        className={`rounded border p-2 transition-colors ${
                          isHighlighted
                            ? 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950'
                            : 'border-zinc-200 dark:border-zinc-800'
                        }`}
                      >
                        <div className="flex items-baseline gap-1.5 text-sm">
                          <span className="font-mono text-xs text-zinc-500">[{n}]</span>
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {src.title || src.url}
                          </a>
                        </div>
                        <div className="ml-6 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {src.url}
                        </div>
                        <p className="mt-1 ml-6 line-clamp-3 text-xs text-zinc-600 dark:text-zinc-400">
                          {src.content?.slice(0, 200)}
                          {src.content && src.content.length > 200 ? '…' : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>

      {/* Bottom action area: button row OR DeepenPopover */}
      <div className="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800">
        {popoverActive ? (
          <DeepenPopover
            initialSuggestions={expandRows ?? []}
            disabled={nodeBusy}
            onCancel={() => setExpandRows(null)}
            onConfirm={confirmExpand}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {showSummarizeButton && (
              <SecondaryButton
                onClick={summarize}
                disabled={reshapeDisabled}
                title="Roll up this node and its descendants"
              >
                Summarize
              </SecondaryButton>
            )}
            {showExpandButton && (
              <SecondaryButton
                onClick={startExpand}
                disabled={reshapeDisabled || plannerLoading || atCapacity}
                title={
                  atCapacity
                    ? `Tree is at the ${MAX_TOTAL_NODES}-node cap`
                    : undefined
                }
              >
                {plannerLoading ? 'Planning…' : 'Expand'}
              </SecondaryButton>
            )}
            {showDeleteButton && (
              <SecondaryButton
                onClick={deleteSubtreeAction}
                disabled={reshapeDisabled}
                tone="danger"
              >
                Delete subtree
              </SecondaryButton>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({
  label,
  children,
  right,
}: {
  label: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="mb-4 border-b border-zinc-200 pb-3 last:border-b-0 dark:border-zinc-800">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {label}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function EditButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-xs text-blue-600 hover:underline disabled:opacity-40 disabled:hover:no-underline dark:text-blue-400"
    >
      Edit
    </button>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded bg-zinc-900 px-3 py-1 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  disabled,
  tone = 'normal',
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'danger';
  title?: string;
  children: ReactNode;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950'
      : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-3 py-1 text-sm disabled:opacity-50 disabled:hover:bg-transparent ${toneClass}`}
    >
      {children}
    </button>
  );
}
