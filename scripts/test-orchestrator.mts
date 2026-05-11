/* Tests the orchestrator's state-management logic with fetch mocked so no real
 * agent calls fire. Run: pnpm test-orchestrator
 *
 * Coverage:
 *  - buildInitialTree: root-only build extracts own claims via rollup (empty children)
 *  - expandNode: adds one layer of children (each with own claims), marks ancestor stale, honors MAX_TOTAL_NODES cap
 *  - summarizeSubtree: post-order rollup that merges children's claims into ancestors
 *  - resetAndRebuild: descendants deleted, node reset and rebuilt, ancestors stale
 *  - AbortError: searching → pending; rolling-up → done with rollupStale
 */

interface MockState {
  searchFails: Set<string>;
  rollupFails: Set<string>;
  searchAborts: Set<string>;
  rollupAborts: Set<string>;
  callLog: { url: string; query?: string; sourceCount?: number; childCount?: number }[];
}

const mock: MockState = {
  searchFails: new Set(),
  rollupFails: new Set(),
  searchAborts: new Set(),
  rollupAborts: new Set(),
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
    // Planner is only called from UI (popover suggestion fetch), not the orchestrator.
    // If we somehow get here, return a benign response.
    return new Response(JSON.stringify({ decompose: false, subquestions: [] }));
  }

  if (url.includes('/api/agents/rollup')) {
    const childCount = (body?.childRollups ?? []).length;
    mock.callLog.push({ url: 'rollup', sourceCount: childCount, childCount });
    if (signal?.aborted) throw abortError();
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
            supporting: [{ childId: null }],
            opposing: [],
            originNodeIds: [],
          },
        ],
      })
    );
  }

  if (originalFetch) return originalFetch(input as never, init);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const { useTreeStore } = await import('../lib/store');
const {
  buildInitialTree,
  expandNode,
  resetAndRebuild,
  summarizeSubtree,
  markChainStale,
  MAX_TOTAL_NODES,
} = await import('../lib/orchestrator');

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
  mock.rollupFails.clear();
  mock.searchAborts.clear();
  mock.rollupAborts.clear();
  mock.callLog.length = 0;
}

async function test_buildInitialTree_rootOnly() {
  describe('buildInitialTree builds root with own claims, no children');
  reset();
  const rootId = await buildInitialTree('root query');
  const tree = useTreeStore.getState().tree!;
  ok(!!tree, 'tree set');
  ok(tree.initialBuildSettled === true, 'initialBuildSettled = true');
  const root = tree.nodes[rootId];
  eq(root.status, 'done', 'root status');
  eq(root.childIds.length, 0, 'root has NO children (no auto-decompose)');
  ok(root.rollup.length > 0, 'root has rollup populated from own findings');
  ok(root.claims.length > 0, 'root has claims extracted at build time');
  eq(Object.keys(tree.nodes).length, 1, 'tree has 1 node total');
  const rollupCalls = mock.callLog.filter((c) => c.url === 'rollup').length;
  eq(rollupCalls, 1, 'rollup endpoint called once for own-claim extraction');
  const rollupBody = mock.callLog.find((c) => c.url === 'rollup')!;
  eq(rollupBody.childCount, 0, 'rollup called with 0 children (leaf-style)');
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

async function test_expandNode_singleLayer() {
  describe('expandNode adds one layer; children built with own claims');
  reset();
  await buildInitialTree('root');
  const tree1 = useTreeStore.getState().tree!;
  const rootId = tree1.rootId;

  await expandNode(rootId, ['child A', 'child B']);

  const tree2 = useTreeStore.getState().tree!;
  const root = tree2.nodes[rootId];
  eq(root.childIds.length, 2, 'root gained 2 children');
  for (const cid of root.childIds) {
    const c = tree2.nodes[cid];
    eq(c.status, 'done', `child(${c.query}) status`);
    eq(c.childIds.length, 0, `child(${c.query}) has no grandchildren (no recursion)`);
    ok(c.rollup.length > 0, `child(${c.query}) has own rollup`);
    ok(c.claims.length > 0, `child(${c.query}) has own claims`);
  }
  ok(root.rollupStale === true, 'root marked stale after adding children');
}

async function test_expandNode_respectsCap() {
  describe('expandNode respects MAX_TOTAL_NODES cap');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  // Try to add many more than the cap. Expect truncation.
  const subs = Array.from({ length: 30 }, (_, i) => `sub-${i}`);
  await expandNode(rootId, subs);
  const total = Object.keys(useTreeStore.getState().tree!.nodes).length;
  ok(total <= MAX_TOTAL_NODES, `tree size <= cap (${total} <= ${MAX_TOTAL_NODES})`);
  eq(total, MAX_TOTAL_NODES, 'tree filled exactly to cap');

  // Further expand should be a no-op.
  const child0 = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  await expandNode(child0, ['extra-1', 'extra-2']);
  const totalAfter = Object.keys(useTreeStore.getState().tree!.nodes).length;
  eq(totalAfter, MAX_TOTAL_NODES, 'no further nodes added past cap');
}

async function test_summarizeSubtree_postOrder() {
  describe('summarizeSubtree rolls up internal nodes only; parent gets children-merged claims');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A', 'child B']);
  const root = useTreeStore.getState().tree!.nodes[rootId];
  const [childA] = root.childIds;

  ok(useTreeStore.getState().tree!.nodes[rootId].rollup.length > 0, 'pre-summarize root has own rollup');
  ok(useTreeStore.getState().tree!.nodes[childA].claims.length > 0, 'pre-summarize childA has own claims');

  mock.callLog.length = 0;
  await summarizeSubtree(rootId);
  const rollupCalls = mock.callLog.filter((c) => c.url === 'rollup');
  eq(rollupCalls.length, 1, 'summarize calls rollup 1x (root only; leaves skipped)');
  eq(rollupCalls[0].childCount, 2, 'root rollup includes both children');

  const tree = useTreeStore.getState().tree!;
  ok(tree.nodes[rootId].claims.length > 0, 'root.claims populated');
  ok(tree.nodes[rootId].rollupStale === false, 'root.rollupStale cleared');
}

async function test_summarizeSubtree_skipsErroredChildren() {
  describe('summarizeSubtree skips errored children; root flagged incomplete');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A', 'child B']);
  const childB = useTreeStore.getState().tree!.nodes[rootId].childIds[1];
  useTreeStore.getState().updateNode(childB, { status: 'error', error: 'mock' });

  mock.callLog.length = 0;
  await summarizeSubtree(rootId);
  const rollupCalls = mock.callLog.filter((c) => c.url === 'rollup');
  eq(rollupCalls.length, 1, 'summarize called rollup 1x (root only; leaves skipped)');
  eq(rollupCalls[0].childCount, 1, 'root rollup excluded errored child');
  ok(useTreeStore.getState().tree!.nodes[rootId].rollupIncomplete === true, 'root flagged rollupIncomplete');
}

async function test_toggleClaimExclusion_lazyFilter() {
  describe('toggleClaimExclusion: ancestor pending → Summarize filters child claim → pending cleared');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A']);
  await summarizeSubtree(rootId);

  const childAId = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  const childAClaim = useTreeStore.getState().tree!.nodes[childAId].claims[0];
  ok(!!childAClaim, 'child has a claim from build (precondition)');

  // X the claim on the child
  useTreeStore.getState().toggleClaimExclusion(childAId, childAClaim.statement);

  const child = useTreeStore.getState().tree!.nodes[childAId];
  ok(child.excludedStatements.length === 1, 'child excludedStatements has 1 entry');
  const rootPending = useTreeStore.getState().tree!.nodes[rootId].pendingExclusions;
  eq(rootPending.length, 1, 'root pendingExclusions has 1 entry');
  eq(rootPending[0].sourceId, childAId, 'pending entry references child');

  // Summarize parent — child's excluded claim must not appear in childRollups
  mock.callLog.length = 0;
  await summarizeSubtree(rootId);
  const rollupCalls = mock.callLog.filter((c) => c.url === 'rollup');
  ok(rollupCalls.length > 0, 'rollup endpoint called');

  // Parent's pending list is cleared by the successful Summarize
  const rootAfter = useTreeStore.getState().tree!.nodes[rootId];
  eq(rootAfter.pendingExclusions.length, 0, 'root pendingExclusions cleared by Summarize');
}

async function test_toggleClaimExclusion_symmetric() {
  describe('toggleClaimExclusion: X then X-off (before Summarize) cancels pending entry');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A']);
  const childAId = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  const childAClaim = useTreeStore.getState().tree!.nodes[childAId].claims[0];

  useTreeStore.getState().toggleClaimExclusion(childAId, childAClaim.statement);
  ok(useTreeStore.getState().tree!.nodes[rootId].pendingExclusions.length === 1, 'pending after X-on');
  useTreeStore.getState().toggleClaimExclusion(childAId, childAClaim.statement);
  eq(
    useTreeStore.getState().tree!.nodes[rootId].pendingExclusions.length,
    0,
    'pending cleared after X-off (symmetric)'
  );
  eq(
    useTreeStore.getState().tree!.nodes[childAId].excludedStatements.length,
    0,
    'child excludedStatements cleared after toggle off'
  );
}

async function test_summarizeSubtree_skipsLeaves() {
  describe('summarizeSubtree no-ops on leaves; only internal nodes re-roll');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A', 'child B']);

  const childA = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  const leafRollupBefore = useTreeStore.getState().tree!.nodes[childA].rollup;

  mock.callLog.length = 0;
  await summarizeSubtree(rootId);
  const rollupCalls = mock.callLog.filter((c) => c.url === 'rollup');
  eq(rollupCalls.length, 1, 'rollup called once (root only; leaves skipped)');

  const leafRollupAfter = useTreeStore.getState().tree!.nodes[childA].rollup;
  eq(leafRollupAfter, leafRollupBefore, 'leaf rollup unchanged');
}

async function test_resetAndRebuild_marksAncestorsStale() {
  describe('resetAndRebuild rebuilds single node with own claims, marks ancestors stale');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A', 'child B']);
  await summarizeSubtree(rootId);
  // root is now summarized
  ok(useTreeStore.getState().tree!.nodes[rootId].rollupStale === false, 'pre-reset root not stale');

  const childA = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  await resetAndRebuild(childA, 'new query');

  const tree = useTreeStore.getState().tree!;
  const newChildA = tree.nodes[childA];
  eq(newChildA.query, 'new query', 'child query updated');
  eq(newChildA.status, 'done', 'child rebuilt to done');
  ok(newChildA.rollup.length > 0, 'rebuilt child has fresh rollup with own claims');
  ok(newChildA.claims.length > 0, 'rebuilt child has own claims');
  ok(tree.nodes[rootId].rollupStale === true, 'root marked stale after descendant rebuild');
}

async function test_markChainStale_walksUp() {
  describe('markChainStale marks node + all ancestors stale');
  reset();
  await buildInitialTree('root');
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A', 'child B']);
  const childA = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  await expandNode(childA, ['grandchild A1']);
  const grandchildA1 = useTreeStore.getState().tree!.nodes[childA].childIds[0];

  // Clear stale (from prior expands)
  for (const id of [rootId, childA, grandchildA1]) {
    useTreeStore.getState().updateNode(id, { rollupStale: false });
  }

  markChainStale(grandchildA1);
  const tree = useTreeStore.getState().tree!;
  ok(tree.nodes[grandchildA1].rollupStale === true, 'grandchild stale');
  ok(tree.nodes[childA].rollupStale === true, 'parent stale');
  ok(tree.nodes[rootId].rollupStale === true, 'root stale');
}

async function test_abortError_search_restoresPending() {
  describe('AbortError during search: status restores to pending');
  reset();
  mock.searchAborts.add('aborts-immediately');
  let threw = false;
  try {
    await buildInitialTree('aborts-immediately');
  } catch (e) {
    threw = true;
    console.log(`    (got error: ${(e as Error).message})`);
  }
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
  const rootId = useTreeStore.getState().tree!.rootId;
  await expandNode(rootId, ['child A']);
  await summarizeSubtree(rootId);  // populate rollups
  // Now trigger an abort on next summarize. The root rollup call sees
  // childRollups[0].summary === childA.rollup.
  const childA = useTreeStore.getState().tree!.nodes[rootId].childIds[0];
  const childARollup = useTreeStore.getState().tree!.nodes[childA].rollup;
  mock.rollupAborts.add(childARollup);

  await summarizeSubtree(rootId);

  const root = useTreeStore.getState().tree!.nodes[rootId];
  eq(root.status, 'done', 'root status restored to done after rollup abort');
  ok(root.rollupStale === true, 'root rollupStale === true');
}

async function main() {
  await test_buildInitialTree_rootOnly();
  await test_buildInitialTree_settledOnFailure();
  await test_expandNode_singleLayer();
  await test_expandNode_respectsCap();
  await test_summarizeSubtree_postOrder();
  await test_summarizeSubtree_skipsErroredChildren();
  await test_toggleClaimExclusion_lazyFilter();
  await test_toggleClaimExclusion_symmetric();
  await test_summarizeSubtree_skipsLeaves();
  await test_resetAndRebuild_marksAncestorsStale();
  await test_markChainStale_walksUp();
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
