import pLimit from 'p-limit';
import { callPlanAgent, callRollupAgent, callSearchAgent } from './agents';
import { createNode, useTreeStore } from './store';
import type { ResearchNode } from './types';

const llmLimit = pLimit(5);
const MAX_CHILDREN_PER_NODE = 3;
const MAX_INITIAL_DEPTH = 2;
const DEEPEN_EXTRA_DEPTH = 3;

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

function getNodeDepth(nodeId: string): number {
  const tree = useTreeStore.getState().tree;
  if (!tree) return 0;
  let depth = 0;
  let cur = tree.nodes[nodeId];
  while (cur?.parentId) {
    depth++;
    cur = tree.nodes[cur.parentId];
  }
  return depth;
}

export async function buildInitialTree(
  rootQuery: string,
  signal?: AbortSignal
): Promise<string> {
  const store = useTreeStore.getState();
  const rootId = store.initTree(rootQuery);
  try {
    await buildNode(rootId, signal, 0);
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

export async function buildNode(
  nodeId: string,
  signal?: AbortSignal,
  depth = 0,
  maxDepth = MAX_INITIAL_DEPTH
): Promise<void> {
  const initialTree = useTreeStore.getState().tree;
  const node = initialTree?.nodes[nodeId];
  if (!node) return;

  const rootQuery =
    useTreeStore.getState().tree?.nodes[
      useTreeStore.getState().tree!.rootId
    ]?.query ?? node.query;

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
    status: 'synthesizing',
    searchResults: searchResult.results,
    findings: searchResult.findings,
  });

  if (depth >= maxDepth) {
    useTreeStore.getState().updateNode(nodeId, {
      status: 'depth-limit',
      rollup: searchResult.findings,
      claims: [],
    });
    return;
  }

  let plan;
  try {
    plan = await llmLimit(() =>
      callPlanAgent(node.query, searchResult.findings, rootQuery, signal)
    );
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

  if (!plan.decompose || plan.subquestions.length === 0) {
    useTreeStore.getState().updateNode(nodeId, {
      status: 'done',
      rollup: searchResult.findings,
      claims: [],
    });
    return;
  }

  const subquestions = plan.subquestions.slice(0, MAX_CHILDREN_PER_NODE);
  const childIds: string[] = [];
  for (const sq of subquestions) {
    const child = createNode(nodeId, sq);
    useTreeStore.getState().upsertNode(child);
    childIds.push(child.id);
  }

  await Promise.allSettled(
    childIds.map((id) => buildNode(id, signal, depth + 1, maxDepth))
  );

  useTreeStore.getState().updateNode(nodeId, { status: 'rolling-up' });

  const tree = useTreeStore.getState().tree;
  // someFailed counts any child not in a settled-leaf state. This catches
  // explicit errors (status === 'error'), abort restorations (status === 'pending'),
  // and any weird in-flight residue. Without this, aborted children silently
  // get excluded from the rollup but the parent looks "clean".
  const someFailed = childIds.some((id) => {
    const c = tree?.nodes[id];
    return !c || (c.status !== 'done' && c.status !== 'depth-limit');
  });
  const survivors = childIds
    .map((id) => tree?.nodes[id])
    .filter(
      (c): c is ResearchNode =>
        !!c && c.status !== 'error' && c.rollup.length > 0
    );

  if (survivors.length === 0) {
    useTreeStore.getState().updateNode(nodeId, {
      status: someFailed ? 'error' : 'done',
      rollup: searchResult.findings,
      claims: [],
      rollupIncomplete: someFailed,
      error: someFailed ? 'all children failed' : null,
    });
    return;
  }

  try {
    const rollup = await llmLimit(() =>
      callRollupAgent(
        searchResult.findings,
        survivors.map((c) => ({
          childId: c.id,
          summary: c.rollup,
          claims: c.claims,
        })),
        signal
      )
    );
    useTreeStore.getState().updateNode(nodeId, {
      status: 'done',
      rollup: rollup.summary,
      claims: rollup.claims,
      rollupIncomplete: someFailed,
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
  while (currentId) {
    store.updateNode(currentId, { rollupStale: true });
    currentId = tree.nodes[currentId]?.parentId ?? null;
  }
}

export async function recomputeChain(
  startNodeId: string,
  signal?: AbortSignal
): Promise<void> {
  const initialStore = useTreeStore.getState();
  const initialTree = initialStore.tree;
  if (!initialTree) return;

  const chain: string[] = [];
  let currentId: string | null = startNodeId;
  while (currentId) {
    const node: ResearchNode | undefined = initialTree.nodes[currentId];
    if (!node) break;
    chain.push(currentId);
    currentId = node.parentId;
  }

  for (const nodeId of chain) {
    const tree = useTreeStore.getState().tree;
    if (!tree) return;
    const node = tree.nodes[nodeId];
    if (!node) continue;

    // depth-limit nodes are treated as leaves for recompute purposes
    if (node.childIds.length === 0 || node.status === 'depth-limit') {
      useTreeStore.getState().updateNode(nodeId, {
        rollup: node.findings,
        claims: [],
        rollupStale: false,
        rollupIncomplete: false,
      });
      continue;
    }

    useTreeStore.getState().updateNode(nodeId, {
      status: 'rolling-up',
      rollupStale: false,
    });

    const children = node.childIds
      .map((id) => tree.nodes[id])
      .filter((c): c is ResearchNode => !!c && c.rollup.length > 0);

    try {
      const result = await llmLimit(() =>
        callRollupAgent(
          node.findings,
          children.map((c) => ({
            childId: c.id,
            summary: c.rollup,
            claims: c.claims,
          })),
          signal
        )
      );

      const rollupIncomplete = node.childIds.some((cid) => {
        const c = tree.nodes[cid];
        if (!c) return true;
        if (c.rollupIncomplete) return true;
        return c.status !== 'done' && c.status !== 'depth-limit';
      });

      useTreeStore.getState().updateNode(nodeId, {
        status: 'done',
        rollup: result.summary,
        claims: result.claims,
        rollupIncomplete,
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
    findingsEdited: false,
    rollup: '',
    claims: [],
    rollupStale: false,
    rollupIncomplete: false,
    error: null,
  });

  const depth = getNodeDepth(nodeId);
  await buildNode(nodeId, signal, depth, MAX_INITIAL_DEPTH);

  const parentId = useTreeStore.getState().tree?.nodes[nodeId]?.parentId ?? null;
  if (parentId) {
    await recomputeChain(parentId, signal);
  }
}

export async function deepenNode(
  nodeId: string,
  customSubquestions: string[],
  signal?: AbortSignal
): Promise<void> {
  const tree = useTreeStore.getState().tree;
  if (!tree) return;
  const node = tree.nodes[nodeId];
  if (!node) return;
  if (customSubquestions.length === 0) return;

  const currentDepth = getNodeDepth(nodeId);
  const childMaxDepth = currentDepth + DEEPEN_EXTRA_DEPTH;

  const childIds: string[] = [];
  for (const sq of customSubquestions) {
    const child = createNode(nodeId, sq);
    useTreeStore.getState().upsertNode(child);
    childIds.push(child.id);
  }

  await Promise.allSettled(
    childIds.map((id) => buildNode(id, signal, currentDepth + 1, childMaxDepth))
  );

  await recomputeChain(nodeId, signal);
}
