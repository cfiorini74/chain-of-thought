import pLimit from 'p-limit';
import { callRollupAgent, callSearchAgent } from './agents';
import { normalizeStatement } from './claims';
import { createNode, useTreeStore } from './store';
import type { Claim, ResearchNode } from './types';

const llmLimit = pLimit(5);
export const MAX_TOTAL_NODES = 20;

export function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

// Origin should be the deepest node(s) where the claim first appeared, not
// every level it bubbled through — so only stamp this node when the route
// resolved no origin at all.
function attachOwnOrigin(claims: Claim[], nodeId: string): Claim[] {
  return claims.map((c) =>
    c.originNodeIds.length > 0 ? c : { ...c, originNodeIds: [nodeId] }
  );
}

export function getRemainingNodeCapacity(): number {
  const tree = useTreeStore.getState().tree;
  if (!tree) return MAX_TOTAL_NODES;
  return Math.max(0, MAX_TOTAL_NODES - Object.keys(tree.nodes).length);
}

// Single-node research: search → synthesize → extract own claims → done.
// Own-claim extraction runs the rollup agent with an empty children array so
// every node has structured claims from its own findings without needing
// Summarize. Summarize is reserved for folding children's claims upward.
export async function buildNode(
  nodeId: string,
  signal?: AbortSignal
): Promise<void> {
  const node = useTreeStore.getState().tree?.nodes[nodeId];
  if (!node) return;

  useTreeStore.getState().updateNode(nodeId, { status: 'searching' });

  let searchResult;
  try {
    searchResult = await llmLimit(() => callSearchAgent(node.query, signal));
  } catch (err) {
    if (isAbortError(err)) {
      useTreeStore.getState().updateNode(nodeId, { status: 'pending' });
      return;
    }
    useTreeStore.getState().updateNode(nodeId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  useTreeStore.getState().updateNode(nodeId, {
    status: 'rolling-up',
    searchResults: searchResult.results,
    findings: searchResult.findings,
  });

  try {
    const rollup = await llmLimit(() =>
      callRollupAgent(searchResult.findings, [], signal)
    );
    useTreeStore.getState().updateNode(nodeId, {
      status: 'done',
      rollup: rollup.summary || searchResult.findings,
      claims: attachOwnOrigin(rollup.claims, nodeId),
      rollupStale: false,
      rollupIncomplete: false,
    });
  } catch (err) {
    if (isAbortError(err)) {
      // Findings are intact; mark stale so a later Summarize can fill claims.
      useTreeStore.getState().updateNode(nodeId, {
        status: 'done',
        rollupStale: true,
      });
      return;
    }
    useTreeStore.getState().updateNode(nodeId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function buildInitialTree(
  rootQuery: string,
  signal?: AbortSignal
): Promise<string> {
  const rootId = useTreeStore.getState().initTree(rootQuery);
  try {
    await buildNode(rootId, signal);
  } finally {
    // Guard against the race where this build was aborted+replaced: only flip
    // settled if the current tree is still the one we created.
    const currentTree = useTreeStore.getState().tree;
    if (currentTree?.rootId === rootId) {
      useTreeStore.getState().setSettled();
    }
  }
  return rootId;
}

// Add one layer of children to nodeId, then build each. Caller supplies
// subquestions (typically planner-suggested + user-edited). Truncates to the
// remaining global capacity. Marks ancestor rollups stale.
export async function expandNode(
  nodeId: string,
  customSubquestions: string[],
  signal?: AbortSignal
): Promise<void> {
  const tree = useTreeStore.getState().tree;
  if (!tree) return;
  const node = tree.nodes[nodeId];
  if (!node) return;

  const filtered = customSubquestions.map((s) => s.trim()).filter(Boolean);
  if (filtered.length === 0) return;

  const remaining = MAX_TOTAL_NODES - Object.keys(tree.nodes).length;
  if (remaining <= 0) return;
  const subs = filtered.slice(0, remaining);

  markChainStale(nodeId);

  const childIds: string[] = [];
  for (const sq of subs) {
    const child = createNode(nodeId, sq);
    useTreeStore.getState().upsertNode(child);
    childIds.push(child.id);
  }

  await Promise.allSettled(childIds.map((id) => buildNode(id, signal)));
}

// Walks the subtree rooted at nodeId in post-order. Leaves keep their build-
// time own-claims unchanged; only internal nodes re-roll, merging current
// children's (exclusion-filtered) claims into the parent.
export async function summarizeSubtree(
  nodeId: string,
  signal?: AbortSignal
): Promise<void> {
  const tree = useTreeStore.getState().tree;
  if (!tree?.nodes[nodeId]) return;

  const postOrder: string[] = [];
  const walk = (id: string) => {
    const n = useTreeStore.getState().tree?.nodes[id];
    if (!n) return;
    for (const cid of n.childIds) walk(cid);
    postOrder.push(id);
  };
  walk(nodeId);

  for (const id of postOrder) {
    if (signal?.aborted) return;
    await summarizeNode(id, signal);
  }
}

async function summarizeNode(
  nodeId: string,
  signal?: AbortSignal
): Promise<void> {
  const tree = useTreeStore.getState().tree;
  if (!tree) return;
  const node = tree.nodes[nodeId];
  if (!node || node.status === 'error') return;
  // Happy-path leaves are immutable under Summarize — own-claims came from
  // build. But a stale or zero-claim leaf has nowhere else to recover from
  // (Summarize button is the only retry surface for leaves), so let those
  // through to re-run extraction with empty children.
  if (
    node.childIds.length === 0 &&
    !node.rollupStale &&
    node.claims.length > 0
  ) {
    return;
  }
  if (node.status !== 'done' && node.status !== 'rolling-up') return;

  useTreeStore.getState().updateNode(nodeId, {
    status: 'rolling-up',
    rollupStale: false,
  });

  const children = node.childIds
    .map((id) => tree.nodes[id])
    .filter(
      (c): c is ResearchNode =>
        !!c && c.status !== 'error' && c.rollup.length > 0
    );

  try {
    const result = await llmLimit(() =>
      callRollupAgent(
        node.findings,
        children.map((c) => ({
          childId: c.id,
          summary: c.rollup,
          // Drop X'd claims before they flow up — that's the whole point of
          // the exclusion mechanic. Match by normalized statement.
          claims: c.claims.filter(
            (cl) =>
              !c.excludedStatements.includes(normalizeStatement(cl.statement))
          ),
        })),
        signal
      )
    );

    const rollupIncomplete = node.childIds.some((cid) => {
      const c = tree.nodes[cid];
      if (!c) return true;
      if (c.rollupIncomplete) return true;
      return c.status !== 'done';
    });

    const merged = result.summary || node.findings;
    useTreeStore.getState().updateNode(nodeId, {
      status: 'done',
      // Update findings as well so the Findings section reflects the merged
      // content after Summarize. The next Summarize will feed this back as
      // input, which is acceptable — the structured claims still come from
      // children's claim arrays, not the prose.
      findings: merged,
      rollup: merged,
      claims: attachOwnOrigin(result.claims, nodeId),
      rollupIncomplete,
      // This Summarize has now accounted for all exclusions in the subtree
      // up to this point — clear the pending-tracking.
      pendingExclusions: [],
    });
  } catch (err) {
    if (isAbortError(err)) {
      useTreeStore.getState().updateNode(nodeId, {
        status: 'done',
        rollupStale: true,
      });
      return;
    }
    useTreeStore.getState().updateNode(nodeId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function markChainStale(startNodeId: string): void {
  const store = useTreeStore.getState();
  const tree = store.tree;
  if (!tree) return;

  let currentId: string | null = startNodeId;
  while (currentId !== null) {
    const n: ResearchNode | undefined = tree.nodes[currentId];
    if (!n) break;
    if (!n.rollupStale) store.updateNode(currentId, { rollupStale: true });
    currentId = n.parentId;
  }
}

export async function resetAndRebuild(
  nodeId: string,
  newQuery: string,
  signal?: AbortSignal
): Promise<void> {
  const tree = useTreeStore.getState().tree;
  if (!tree) return;
  const node = tree.nodes[nodeId];
  if (!node) return;

  const childIdsSnapshot = [...node.childIds];
  for (const childId of childIdsSnapshot) {
    useTreeStore.getState().deleteSubtree(childId);
  }

  useTreeStore.getState().updateNode(nodeId, {
    query: newQuery,
    status: 'pending',
    searchResults: [],
    findings: '',
    rollup: '',
    claims: [],
    rollupStale: false,
    rollupIncomplete: false,
    excludedStatements: [],
    pendingExclusions: [],
    error: null,
  });

  // Mark ancestors stale BEFORE the rebuild attempt. The descendant has
  // already been wiped, so the parent's rollup is genuinely stale regardless
  // of whether buildNode succeeds, aborts, or throws.
  const parentId = node.parentId;
  if (parentId) markChainStale(parentId);

  await buildNode(nodeId, signal);
}
