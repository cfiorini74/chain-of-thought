import { hierarchy, tree as d3tree } from 'd3-hierarchy';
import type { ResearchTree } from './types';

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
}

export interface LaidOutEdge {
  id: string;
  source: string;
  target: string;
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 110;
const HORIZONTAL_GAP = 40;
const VERTICAL_GAP = 60;

export function computeLayout(tree: ResearchTree): Layout {
  const root = tree.nodes[tree.rootId];
  if (!root) return { nodes: [], edges: [] };

  const root_h = hierarchy(root, (n) =>
    n.childIds.map((id) => tree.nodes[id]).filter((c): c is NonNullable<typeof c> => !!c)
  );

  const layout = d3tree<typeof root>()
    .nodeSize([NODE_WIDTH + HORIZONTAL_GAP, NODE_HEIGHT + VERTICAL_GAP])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.2));

  const positioned = layout(root_h);

  const nodes: LaidOutNode[] = [];
  const edges: LaidOutEdge[] = [];
  positioned.each((n) => {
    nodes.push({ id: n.data.id, x: n.x, y: n.y });
    if (n.parent) {
      edges.push({
        id: `${n.parent.data.id}->${n.data.id}`,
        source: n.parent.data.id,
        target: n.data.id,
      });
    }
  });

  return { nodes, edges };
}
