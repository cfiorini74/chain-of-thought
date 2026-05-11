import { create } from 'zustand';
import { normalizeStatement } from './claims';
import type { ResearchNode, ResearchTree } from './types';

interface TreeStoreState {
  tree: ResearchTree | null;
  selectedNodeId: string | null;
  // Keyed by the originating node of each reshape op. See isNodeBusy for gating.
  inFlightOps: Record<string, AbortController>;

  initTree: (rootQuery: string) => string;
  upsertNode: (node: ResearchNode) => void;
  updateNode: (id: string, partial: Partial<ResearchNode>) => void;
  deleteSubtree: (nodeId: string) => void;
  toggleClaimExclusion: (nodeId: string, statement: string) => void;
  setSettled: () => void;
  selectNode: (id: string | null) => void;
  startOp: (originId: string, controller: AbortController) => void;
  endOp: (originId: string) => void;
  reset: () => void;
}

// Busy iff some in-flight origin sits on the same root-to-leaf path as
// nodeId. Disjoint subtrees can run reshape ops concurrently.
export function isNodeBusy(
  nodeId: string,
  tree: ResearchTree | null,
  inFlightOps: Record<string, AbortController>
): boolean {
  if (!tree) return false;
  const origins = Object.keys(inFlightOps);
  if (origins.length === 0) return false;
  for (const originId of origins) {
    if (originId === nodeId) return true;
    if (isAncestor(originId, nodeId, tree)) return true;
    if (isAncestor(nodeId, originId, tree)) return true;
  }
  return false;
}

function isAncestor(
  ancestorId: string,
  descendantId: string,
  tree: ResearchTree
): boolean {
  let cur: string | null = tree.nodes[descendantId]?.parentId ?? null;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = tree.nodes[cur]?.parentId ?? null;
  }
  return false;
}

let nodeCounter = 0;
const newId = () => `node-${++nodeCounter}-${Date.now().toString(36)}`;

export function createNode(parentId: string | null, query: string): ResearchNode {
  const now = Date.now();
  return {
    id: newId(),
    parentId,
    query,
    status: 'pending',
    searchResults: [],
    findings: '',
    rollup: '',
    claims: [],
    rollupStale: false,
    rollupIncomplete: false,
    excludedStatements: [],
    pendingExclusions: [],
    childIds: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

export const useTreeStore = create<TreeStoreState>((set) => ({
  tree: null,
  selectedNodeId: null,
  inFlightOps: {},

  initTree(rootQuery) {
    const root = createNode(null, rootQuery);
    set({
      tree: {
        rootId: root.id,
        nodes: { [root.id]: root },
        initialBuildSettled: false,
      },
    });
    return root.id;
  },

  upsertNode(node) {
    set((state) => {
      if (!state.tree) return state;
      const updates: Record<string, ResearchNode> = { [node.id]: node };
      if (node.parentId) {
        const parent = state.tree.nodes[node.parentId];
        if (parent && !parent.childIds.includes(node.id)) {
          updates[node.parentId] = {
            ...parent,
            childIds: [...parent.childIds, node.id],
            updatedAt: Date.now(),
          };
        }
      }
      return {
        tree: {
          ...state.tree,
          nodes: { ...state.tree.nodes, ...updates },
        },
      };
    });
  },

  updateNode(id, partial) {
    set((state) => {
      if (!state.tree) return state;
      const existing = state.tree.nodes[id];
      if (!existing) return state;
      return {
        tree: {
          ...state.tree,
          nodes: {
            ...state.tree.nodes,
            [id]: { ...existing, ...partial, updatedAt: Date.now() },
          },
        },
      };
    });
  },

  deleteSubtree(nodeId) {
    set((state) => {
      if (!state.tree) return state;
      const toDelete = new Set<string>();
      const collect = (id: string) => {
        toDelete.add(id);
        state.tree!.nodes[id]?.childIds.forEach(collect);
      };
      collect(nodeId);

      const newNodes = { ...state.tree.nodes };
      toDelete.forEach((id) => delete newNodes[id]);

      const target = state.tree.nodes[nodeId];
      if (target?.parentId && newNodes[target.parentId]) {
        newNodes[target.parentId] = {
          ...newNodes[target.parentId],
          childIds: newNodes[target.parentId].childIds.filter((cid) => cid !== nodeId),
          updatedAt: Date.now(),
        };

        // Removing a child changes the parent's rollup inputs, so the
        // parent (and every ancestor) needs Summarize to refresh.
        let curId: string | null = target.parentId;
        while (curId !== null) {
          const anc: ResearchNode | undefined = newNodes[curId];
          if (!anc) break;
          if (!anc.rollupStale) {
            newNodes[curId] = { ...anc, rollupStale: true };
          }
          curId = anc.parentId;
        }
      }

      // Sweep pendingExclusions on every remaining node, dropping refs to
      // any deleted source. Without this, ancestors retain dangling refs
      // that can never be cleared by Summarize or un-X.
      for (const id of Object.keys(newNodes)) {
        const n = newNodes[id];
        const cleaned = n.pendingExclusions.filter(
          (e) => !toDelete.has(e.sourceId)
        );
        if (cleaned.length !== n.pendingExclusions.length) {
          newNodes[id] = { ...n, pendingExclusions: cleaned };
        }
      }

      return { tree: { ...state.tree, nodes: newNodes } };
    });
  },

  toggleClaimExclusion(nodeId, statement) {
    set((state) => {
      if (!state.tree) return state;
      const node = state.tree.nodes[nodeId];
      if (!node) return state;
      const norm = normalizeStatement(statement);
      if (!norm) return state;

      const wasExcluded = node.excludedStatements.includes(norm);
      const newExcluded = wasExcluded
        ? node.excludedStatements.filter((s) => s !== norm)
        : [...node.excludedStatements, norm];

      const newNodes = { ...state.tree.nodes };
      newNodes[nodeId] = {
        ...node,
        excludedStatements: newExcluded,
        updatedAt: Date.now(),
      };

      // Walk ancestors and update pendingExclusions symmetrically.
      // Add-then-remove (before any Summarize) cancels out cleanly.
      let curId = node.parentId;
      while (curId) {
        const anc = newNodes[curId];
        if (!anc) break;
        const existingIdx = anc.pendingExclusions.findIndex(
          (e) => e.sourceId === nodeId && e.statement === norm
        );
        let nextPending: typeof anc.pendingExclusions;
        if (wasExcluded) {
          // Un-excluding: remove the pending entry if present.
          if (existingIdx === -1) {
            curId = anc.parentId;
            continue;
          }
          nextPending = [
            ...anc.pendingExclusions.slice(0, existingIdx),
            ...anc.pendingExclusions.slice(existingIdx + 1),
          ];
        } else {
          // Excluding: add a pending entry (idempotent — skip if already there).
          if (existingIdx !== -1) {
            curId = anc.parentId;
            continue;
          }
          nextPending = [
            ...anc.pendingExclusions,
            { sourceId: nodeId, statement: norm },
          ];
        }
        newNodes[curId] = { ...anc, pendingExclusions: nextPending };
        curId = anc.parentId;
      }

      return { tree: { ...state.tree, nodes: newNodes } };
    });
  },

  setSettled() {
    set((state) => {
      if (!state.tree) return state;
      return { tree: { ...state.tree, initialBuildSettled: true } };
    });
  },

  selectNode(id) {
    set({ selectedNodeId: id });
  },

  startOp(originId, controller) {
    set((state) => ({
      inFlightOps: { ...state.inFlightOps, [originId]: controller },
    }));
  },

  endOp(originId) {
    set((state) => {
      if (!(originId in state.inFlightOps)) return state;
      const next = { ...state.inFlightOps };
      delete next[originId];
      return { inFlightOps: next };
    });
  },

  reset() {
    set((state) => {
      for (const c of Object.values(state.inFlightOps)) {
        c.abort();
      }
      return { tree: null, selectedNodeId: null, inFlightOps: {} };
    });
  },
}));
