'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTreeStore } from '@/lib/store';
import { callPlanAgent } from '@/lib/agents';
import {
  deepenNode,
  markChainStale,
  recomputeChain,
  resetAndRebuild,
} from '@/lib/orchestrator';
import type { Claim, ResearchNode, SearchResult } from '@/lib/types';
import DeepenPopover from './DeepenPopover';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  searching: 'Searching…',
  synthesizing: 'Synthesizing…',
  'rolling-up': 'Rolling up…',
  done: 'Done',
  'depth-limit': 'Done (max auto-depth)',
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

function ClaimRow({ claim, ownerNode }: { claim: Claim; ownerNode: ResearchNode }) {
  const childIds = ownerNode.childIds;
  const branchNumber = (childId: string | null): string => {
    if (!childId) return 'this node';
    const idx = childIds.indexOf(childId);
    return idx >= 0 ? `Branch ${idx + 1}` : 'unknown branch';
  };

  if (claim.opposing.length > 0) {
    const branches = claim.opposing.map((s) => branchNumber(s.childId));
    const uniq = Array.from(new Set(branches));
    return (
      <li className="text-sm">
        <span className="font-medium">{claim.topic}.</span>{' '}
        <span>{claim.statement}</span>{' '}
        <span className="text-amber-600 dark:text-amber-400">
          (⚠ contradicted by {uniq.join(', ')})
        </span>
      </li>
    );
  }

  return (
    <li className="text-sm">
      <span className="font-medium">{claim.topic}.</span>{' '}
      <span>{claim.statement}</span>{' '}
      <span className="text-emerald-600 dark:text-emerald-400">
        (✓ supported by {claim.supporting.length})
      </span>
    </li>
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
  const reshapeOpInFlight = useTreeStore((s) => s.reshapeOpInFlight);
  const setReshapeOpInFlight = useTreeStore((s) => s.setReshapeOpInFlight);

  const [editingQuery, setEditingQuery] = useState(false);
  const [queryDraft, setQueryDraft] = useState('');
  const [editingFindings, setEditingFindings] = useState(false);
  const [findingsDraft, setFindingsDraft] = useState('');
  const [highlightedSource, setHighlightedSource] = useState<number | null>(null);
  const [deepenSuggestions, setDeepenSuggestions] = useState<string[] | null>(null);
  const [deepenLoading, setDeepenLoading] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);

  // Reset edit state when the selected node changes
  useEffect(() => {
    setEditingQuery(false);
    setEditingFindings(false);
    setDeepenSuggestions(null);
    setDeepenLoading(false);
  }, [selectedNodeId]);

  // Abort any in-flight reshape op when the panel unmounts
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  if (!tree || !selectedNodeId) return null;
  const node = tree.nodes[selectedNodeId];
  if (!node) return null;

  const isError = node.status === 'error';
  const isRoot = node.parentId === null;
  const hasChildren = node.childIds.length > 0;
  const isFinishedNode = node.status === 'done' || node.status === 'depth-limit';
  const initialBuildSettled = tree.initialBuildSettled;

  // Reshape buttons disabled when the tree hasn't settled or another reshape op is in flight.
  const reshapeDisabled = !initialBuildSettled || reshapeOpInFlight;

  // Per the action contract:
  // - error nodes: Edit query + Delete only
  // - leaf done/depth-limit: Edit findings+Recompute, Edit query, Deepen, Delete
  // - internal done: Edit findings+Recompute, Edit query, Delete (no Deepen)
  // - in-flight (searching/synthesizing/rolling-up/pending): no actions
  const showFindingsBlock = !isError;
  const showRecomputeButton = isFinishedNode;
  const showDeepenButton = isFinishedNode && !hasChildren;
  const showDeleteButton = !isRoot;
  const showQueryEdit = isFinishedNode || isError;
  const showFindingsEdit = isFinishedNode;

  function newSignal(): AbortSignal {
    controllerRef.current?.abort();
    const c = new AbortController();
    controllerRef.current = c;
    return c.signal;
  }

  function handleCitationClick(n: number) {
    const el = document.getElementById(sourceRowId(node.id, n));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedSource(n);
    window.setTimeout(
      () => setHighlightedSource((cur) => (cur === n ? null : cur)),
      1000
    );
  }

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
    const signal = newSignal();
    setReshapeOpInFlight(true);
    try {
      await resetAndRebuild(node.id, next, signal);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        console.error('resetAndRebuild failed:', e);
      }
    } finally {
      setReshapeOpInFlight(false);
    }
  }

  // === Edit findings ===
  function startEditFindings() {
    setFindingsDraft(node.findings);
    setEditingFindings(true);
  }
  function saveEditFindings() {
    useTreeStore.getState().updateNode(node.id, {
      findings: findingsDraft,
      findingsEdited: true,
    });
    setEditingFindings(false);
  }

  // === Recompute ===
  async function recompute() {
    if (!node.findingsEdited) return;
    const signal = newSignal();
    setReshapeOpInFlight(true);
    try {
      markChainStale(node.id);
      await recomputeChain(node.id, signal);
      // Only clear the dirty flag if recompute actually completed.
      // recomputeChain swallows AbortError, so signal.aborted is the source of truth.
      if (!signal.aborted) {
        useTreeStore.getState().updateNode(node.id, { findingsEdited: false });
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        console.error('recompute failed:', e);
      }
    } finally {
      setReshapeOpInFlight(false);
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
    const signal = newSignal();
    setReshapeOpInFlight(true);
    try {
      useTreeStore.getState().deleteSubtree(node.id);
      // Move selection to parent so SidePanel stays mounted while recompute runs.
      // Unmounting (selectNode(null)) would abort the controller.
      if (parentId) {
        useTreeStore.getState().selectNode(parentId);
        await recomputeChain(parentId, signal);
      } else {
        useTreeStore.getState().selectNode(null);
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        console.error('delete failed:', e);
      }
    } finally {
      setReshapeOpInFlight(false);
    }
  }

  // === Deepen ===
  async function startDeepen() {
    const startNodeId = node.id;
    setDeepenLoading(true);
    const rootQuery = tree?.nodes[tree.rootId]?.query ?? node.query;
    const signal = newSignal();
    const isStillCurrent = () =>
      useTreeStore.getState().selectedNodeId === startNodeId;
    try {
      const result = await callPlanAgent(node.query, node.findings, rootQuery, signal);
      if (!isStillCurrent()) return;
      const subs = result.subquestions.length > 0 ? result.subquestions : [''];
      setDeepenSuggestions(subs);
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (!isStillCurrent()) return;
      console.error('planner call failed:', e);
      setDeepenSuggestions(['']);
    } finally {
      if (isStillCurrent()) setDeepenLoading(false);
    }
  }
  async function confirmDeepen(rows: string[]) {
    const filtered = rows.map((s) => s.trim()).filter(Boolean);
    setDeepenSuggestions(null);
    if (filtered.length === 0) return;
    const signal = newSignal();
    setReshapeOpInFlight(true);
    try {
      await deepenNode(node.id, filtered, signal);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        console.error('deepenNode failed:', e);
      }
    } finally {
      setReshapeOpInFlight(false);
    }
  }

  const sources = node.searchResults;
  const popoverActive = deepenSuggestions !== null;

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
            <Section
              label="Findings"
              right={
                showFindingsEdit && !editingFindings ? (
                  <EditButton onClick={startEditFindings} disabled={reshapeDisabled} />
                ) : undefined
              }
            >
              {editingFindings ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={findingsDraft}
                    onChange={(e) => setFindingsDraft(e.target.value)}
                    rows={10}
                    autoFocus
                    className="w-full resize-y rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <div className="flex justify-end gap-2">
                    <SecondaryButton onClick={() => setEditingFindings(false)}>
                      Cancel
                    </SecondaryButton>
                    <PrimaryButton
                      onClick={saveEditFindings}
                      disabled={findingsDraft === node.findings}
                    >
                      Save
                    </PrimaryButton>
                  </div>
                </div>
              ) : (
                <div className="text-sm leading-relaxed whitespace-pre-wrap">
                  {renderFindings(node.findings, sources, handleCitationClick)}
                </div>
              )}
            </Section>

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

            {node.claims.length > 0 && (
              <Section label="Claims">
                <ul className="space-y-1.5 list-disc pl-5">
                  {node.claims.map((c, i) => (
                    <ClaimRow key={`${c.topic}-${i}`} claim={c} ownerNode={node} />
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>

      {/* Bottom action area: button row OR DeepenPopover */}
      <div className="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800">
        {popoverActive ? (
          <DeepenPopover
            initialSuggestions={deepenSuggestions ?? []}
            disabled={reshapeOpInFlight}
            onCancel={() => setDeepenSuggestions(null)}
            onConfirm={confirmDeepen}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {showRecomputeButton && (
              <SecondaryButton
                onClick={recompute}
                disabled={reshapeDisabled || !node.findingsEdited}
                title={
                  node.findingsEdited
                    ? 'Recompute rollups upward from this node'
                    : 'Edit findings first to enable recompute'
                }
              >
                Recompute
              </SecondaryButton>
            )}
            {showDeepenButton && (
              <SecondaryButton
                onClick={startDeepen}
                disabled={reshapeDisabled || deepenLoading}
              >
                {deepenLoading ? 'Planning…' : 'Deepen'}
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
