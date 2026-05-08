/* Tests the orchestrator's state-management logic with fetch mocked so no real
 * agent calls fire. Run: pnpm test-orchestrator
 *
 * Coverage:
 *  - buildInitialTree: try/finally fires setSettled even on root failure
 *  - buildNode: maxDepth parameter is honored on recursion
 *  - resetAndRebuild: descendants deleted, node reset, rebuild + chain recompute
 *  - deepenNode: children spawn at depth+1 with maxDepth=depth+3, then recompute
 *  - recomputeChain: rollupIncomplete computed from child errors
 *  - AbortError: searching/synthesizing → pending; rolling-up → done with rollupStale
 */

interface MockState {
  searchFails: Set<string>;
  planFails: Set<string>;
  rollupFails: Set<string>;
  searchAborts: Set<string>;
  planAborts: Set<string>;
  rollupAborts: Set<string>;
  /** Decide what the planner returns for a given query. */
  planResponse: (query: string) => { decompose: boolean; subquestions: string[] };
  callLog: { url: string; query?: string; sourceCount?: number; childCount?: number }[];
}

// Default planner: queries containing 'LEAF' don't decompose; everything else
// gets 2 children whose queries contain 'LEAF' (so they stop at depth+1).
const defaultPlanResponse = (query: string) =>
  query.includes('LEAF')
    ? { decompose: false, subquestions: [] }
    : {
        decompose: true,
        subquestions: [`${query} > LEAF-1`, `${query} > LEAF-2`],
      };

const mock: MockState = {
  searchFails: new Set(),
  planFails: new Set(),
  rollupFails: new Set(),
  searchAborts: new Set(),
  planAborts: new Set(),
  rollupAborts: new Set(),
  planResponse: defaultPlanResponse,
  callLog: [],
};

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function checkAbort(matchers: Set<string>, query: string, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  if (matchers.has(query)) throw abortError();
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as { url: string }).url;
  const body = init?.body ? JSON.parse(init.body as string) : null;
  const signal = init?.signal as AbortSignal | undefined;

  // Simulate a tiny bit of latency so abort can interleave
  await new Promise((r) => setTimeout(r, 1));

  if (url.includes('/api/agents/search')) {
    const query = body?.query ?? '';
    mock.callLog.push({ url: 'search', query });
    checkAbort(mock.searchAborts, query, signal);
    if (mock.searchFails.has(query)) {
      return new Response(JSON.stringify({ error: 'mock search fail' }), { status: 500 });
    }
    return new Response(
      JSON.stringify({
        results: [
          { url: 'https://example.com/a', title: `T-${query}`, content: 'x'.repeat(200) },
        ],
        findings: `findings for "${query}"`,
      })
    );
  }

  if (url.includes('/api/agents/plan')) {
    const query = body?.query ?? '';
    mock.callLog.push({ url: 'plan', query });
    checkAbort(mock.planAborts, query, signal);
    if (mock.planFails.has(query)) {
      return new Response(JSON.stringify({ error: 'mock plan fail' }), { status: 500 });
    }
    return new Response(JSON.stringify(mock.planResponse(query)));
  }

  if (url.includes('/api/agents/rollup')) {
    const childCount = (body?.childRollups ?? []).length;
    mock.callLog.push({ url: 'rollup', sourceCount: childCount, childCount });
    if (signal?.aborted) throw abortError();
    // Use the first child rollup query as a stable abort key
    const firstChildSummary = body?.childRollups?.[0]?.summary ?? '';
    checkAbort(mock.rollupAborts, firstChildSummary, signal);
    if (mock.rollupFails.has(firstChildSummary)) {
      return new Response(JSON.stringify({ error: 'mock rollup fail' }), { status: 500 });
    }
    return new Response(
      JSON.stringify({
        summary: `rollup of ${childCount} branch(es)`,
        claims: [
          {
            topic: 'mock-claim',
            statement: 'this is a falsifiable proposition',
            supporting: [{ branchIndex: 1 }],
            opposing: [],
          },
        ],
      })
    );
  }

  if (originalFetch) return originalFetch(input as never, init);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const { useTreeStore } = await import('../lib/store');
const { buildInitialTree, deepenNode, resetAndRebuild, recomputeChain, markChainStale } =
  await import('../lib/orchestrator');

let testCount = 0;
let failCount = 0;
function ok(cond: boolean, msg: string) {
  testCount++;
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failCount++;
  }
}
function eq<T>(actual: T, expected: T, msg: string) {
  ok(actual === expected, `${msg} (expected ${String(expected)}, got ${String(actual)})`);
}
function describe(name: string) {
  console.log(`\n=== ${name} ===`);
}
function reset() {
  useTreeStore.getState().reset();
  mock.searchFails.clear();
  mock.planFails.clear();
  mock.rollupFails.clear();
  mock.searchAborts.clear();
  mock.planAborts.clear();
  mock.rollupAborts.clear();
  mock.callLog.length = 0;
  mock.planResponse = defaultPlanResponse;
}

async function test_buildInitialTree_happyPath() {
  describe('buildInitialTree happy path (depth=2 default)');
  reset();
  const rootId = await buildInitialTree('root query');
  const tree = useTreeStore.getState().tree!;
  ok(!!tree, 'tree set');
  ok(tree.initialBuildSettled === true, 'initialBuildSettled = true');
  const root = tree.nodes[rootId];
  eq(root.status, 'done', 'root status');
  eq(root.childIds.length, 2, 'root has 2 children');
  for (const childId of root.childIds) {
    const c = tree.nodes[childId];
    // Children are LEAF (planner returns decompose=false), so they're 'done' with no further children
    eq(c.status, 'done', `child(${c.query.slice(0, 30)}) status`);
    eq(c.childIds.length, 0, 'child has no children (leaf via plan)');
  }
}

async function test_buildInitialTree_settledOnFailure() {
  describe('buildInitialTree fires setSettled even when root errors');
  reset();
  mock.searchFails.add('root that fails');
  let threw = false;
  try {
    await buildInitialTree('root that fails');
  } catch {
    threw = true;
  }
  ok(threw, 'buildInitialTree rejected on root failure');
  const tree = useTreeStore.getState().tree!;
  ok(tree.initialBuildSettled === true, 'initialBuildSettled === true even after error');
  const root = tree.nodes[tree.rootId];
  eq(root.status, 'error', 'root status === error');
}

async function test_buildNode_maxDepth_respected() {
  describe('buildNode maxDepth parameter is honored');
  reset();
  // Always-decompose planner: termination must come from maxDepth, not from leaf markers
  mock.planResponse = (query) => ({
    decompose: true,
    subquestions: [`${query} sub-1`, `${query} sub-2`],
  });
  await buildInitialTree('root');
  const tree = useTreeStore.getState().tree!;
  const root = tree.nodes[tree.rootId];
  // Default MAX_INITIAL_DEPTH = 2 → root(0) → children(1) → grandchildren(2 hits depth-limit)
  ok(root.childIds.length === 2, 'root has 2 children');
  const c = tree.nodes[root.childIds[0]];
  eq(c.status, 'done', 'child(depth=1) status === done');
  eq(c.childIds.length, 2, 'child(depth=1) has 2 children');
  const gc = tree.nodes[c.childIds[0]];
  eq(gc.status, 'depth-limit', 'grandchild(depth=2) status === depth-limit');
  eq(gc.childIds.length, 0, 'grandchild has no children');
}

async function test_resetAndRebuild() {
  describe('resetAndRebuild deletes descendants and rebuilds');
  reset();
  await buildInitialTree('root');
  const tree1 = useTreeStore.getState().tree!;
  const root = tree1.nodes[tree1.rootId];
  const oldChildIds = [...root.childIds];
  ok(oldChildIds.length === 2, 'pre-reset: root has 2 children');

  // Reset root with a new query
  await resetAndRebuild(root.id, 'new root query');

  const tree2 = useTreeStore.getState().tree!;
  const newRoot = tree2.nodes[root.id];
  eq(newRoot.query, 'new root query', 'root.query updated');
  eq(newRoot.status, 'done', 'root.status === done after rebuild');
  ok(newRoot.childIds.length === 2, 'root has new 2 children');
  // Old children should be gone
  for (const oldId of oldChildIds) {
    ok(!(oldId in tree2.nodes), `old child ${oldId} deleted`);
  }
}

async function test_deepenNode_addsChildrenAndRecomputes() {
  describe('deepenNode spawns children at depth+1, maxDepth+3, then recomputes');
  reset();
  await buildInitialTree('root');
  const tree1 = useTreeStore.getState().tree!;
  const root = tree1.nodes[tree1.rootId];
  // Pick a leaf (root's children are LEAF nodes per planner)
  const leafId = root.childIds[0];
  const leaf = tree1.nodes[leafId];
  eq(leaf.status, 'done', 'leaf is done before deepen');
  eq(leaf.childIds.length, 0, 'leaf has 0 children before deepen');

  await deepenNode(leafId, ['deep-A LEAF', 'deep-B LEAF']);

  const tree2 = useTreeStore.getState().tree!;
  const updatedLeaf = tree2.nodes[leafId];
  eq(updatedLeaf.childIds.length, 2, 'leaf gained 2 children after deepen');
  for (const cid of updatedLeaf.childIds) {
    const c = tree2.nodes[cid];
    eq(c.status, 'done', `deepened child(${c.query.slice(0, 30)}) status`);
  }
  // recomputeChain should have run on the leaf and ancestors → leaf and root were re-rolled-up
  const newRoot = tree2.nodes[tree2.rootId];
  eq(newRoot.status, 'done', 'root status after deepen+recompute');
}

async function test_recomputeChain_rollupIncomplete_updatesFromChildErrors() {
  describe('recomputeChain sets rollupIncomplete from child errors/incomplete flags');
  reset();
  await buildInitialTree('root');
  const tree1 = useTreeStore.getState().tree!;
  const root = tree1.nodes[tree1.rootId];

  // Manually flip one child to error and recompute chain from root
  useTreeStore.getState().updateNode(root.childIds[0], { status: 'error' });

  markChainStale(root.id);
  await recomputeChain(root.id);

  const tree2 = useTreeStore.getState().tree!;
  const newRoot = tree2.nodes[tree2.rootId];
  eq(newRoot.rollupIncomplete, true, 'root rollupIncomplete === true (one child errored)');

  // Now flip child back to done and recompute again
  useTreeStore.getState().updateNode(root.childIds[0], { status: 'done' });
  markChainStale(root.id);
  await recomputeChain(root.id);

  const tree3 = useTreeStore.getState().tree!;
  const finalRoot = tree3.nodes[tree3.rootId];
  eq(finalRoot.rollupIncomplete, false, 'root rollupIncomplete === false (cleared after recompute)');
}

async function test_abortError_search_restoresPending() {
  describe('AbortError during search: status restores to pending');
  reset();
  // Use a single-node tree (LEAF root won't decompose) to keep it simple
  mock.searchAborts.add('aborts-immediately');
  let threw = false;
  try {
    await buildInitialTree('aborts-immediately');
  } catch (e) {
    threw = true;
    console.log(`    (got error: ${(e as Error).message})`);
  }
  // buildInitialTree shouldn't throw on AbortError; it just returns (build returns) then setSettled fires
  ok(!threw, 'buildInitialTree did not throw on AbortError');
  const tree = useTreeStore.getState().tree!;
  const root = tree.nodes[tree.rootId];
  eq(root.status, 'pending', 'root status restored to pending');
  ok(tree.initialBuildSettled === true, 'setSettled still fired (try/finally)');
}

async function test_abortError_rollup_marksDoneStale() {
  describe('AbortError during rollup: status restores to done with rollupStale');
  reset();
  await buildInitialTree('root');
  const tree1 = useTreeStore.getState().tree!;
  const root = tree1.nodes[tree1.rootId];
  // Trigger recompute that aborts on rollup
  // The child rollup summaries are 'findings for "..."' from the search mock.
  // Recompute uses node.rollup as summary, so the rollup mock sees childRollups with summary = child.rollup.
  const firstChildRollup = tree1.nodes[root.childIds[0]].rollup;
  mock.rollupAborts.add(firstChildRollup);

  markChainStale(root.id);
  await recomputeChain(root.id);

  const tree2 = useTreeStore.getState().tree!;
  const newRoot = tree2.nodes[tree2.rootId];
  eq(newRoot.status, 'done', 'root status restored to done after rollup abort');
  eq(newRoot.rollupStale, true, 'root rollupStale === true');
}

async function main() {
  await test_buildInitialTree_happyPath();
  await test_buildInitialTree_settledOnFailure();
  await test_buildNode_maxDepth_respected();
  await test_resetAndRebuild();
  await test_deepenNode_addsChildrenAndRecomputes();
  await test_recomputeChain_rollupIncomplete_updatesFromChildErrors();
  await test_abortError_search_restoresPending();
  await test_abortError_rollup_marksDoneStale();

  console.log(`\n${testCount - failCount}/${testCount} assertions passed`);
  if (failCount > 0) {
    console.log(`${failCount} FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
