import { create } from 'zustand';
import type { ResearchNode, ResearchTree } from './types';

interface TreeStoreState {
  tree: ResearchTree | null;
  selectedNodeId: string | null;
  reshapeOpInFlight: boolean;

  initTree: (rootQuery: string) => string;
  upsertNode: (node: ResearchNode) => void;
  updateNode: (id: string, partial: Partial<ResearchNode>) => void;
  deleteSubtree: (nodeId: string) => void;
  setSettled: () => void;
  selectNode: (id: string | null) => void;
  setReshapeOpInFlight: (val: boolean) => void;
  reset: () => void;
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
    findingsEdited: false,
    rollup: '',
    claims: [],
    rollupStale: false,
    rollupIncomplete: false,
    childIds: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

export const useTreeStore = create<TreeStoreState>((set) => ({
  tree: null,
  selectedNodeId: null,
  reshapeOpInFlight: false,

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

  setReshapeOpInFlight(val) {
    set({ reshapeOpInFlight: val });
  },

  reset() {
    set({ tree: null, selectedNodeId: null, reshapeOpInFlight: false });
  },
}));
