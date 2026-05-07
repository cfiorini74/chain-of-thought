import pLimit from 'p-limit';
import { callPlanAgent, callRollupAgent, callSearchAgent } from './agents';
import { createNode, useTreeStore } from './store';
import type { ResearchNode } from './types';

const llmLimit = pLimit(5);

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

export async function buildInitialTree(
  rootQuery: string,
  signal?: AbortSignal
): Promise<string> {
  const store = useTreeStore.getState();
  const rootId = store.initTree(rootQuery);
  await buildNode(rootId, signal, 0);
  useTreeStore.getState().setSettled();
  return rootId;
}

export async function buildNode(
  nodeId: string,
  signal?: AbortSignal,
  depth = 0
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
    if (isAbortError(err)) return;
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

  if (depth >= 5) {
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
    if (isAbortError(err)) return;
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

  const childIds: string[] = [];
  for (const sq of plan.subquestions) {
    const child = createNode(nodeId, sq);
    useTreeStore.getState().upsertNode(child);
    childIds.push(child.id);
  }

  const settledChildren = await Promise.allSettled(
    childIds.map((id) => buildNode(id, signal, depth + 1))
  );
  const someFailed = settledChildren.some((r) => r.status === 'rejected');

  useTreeStore.getState().updateNode(nodeId, { status: 'rolling-up' });

  const tree = useTreeStore.getState().tree;
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
    if (isAbortError(err)) return;
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
      useTreeStore.getState().updateNode(nodeId, {
        status: 'done',
        rollup: result.summary,
        claims: result.claims,
      });
    } catch (err) {
      if (isAbortError(err)) return;
      useTreeStore.getState().updateNode(nodeId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
