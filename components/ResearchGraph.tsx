'use client';

import { useCallback, useMemo } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTreeStore } from '@/lib/store';
import { computeLayout } from '@/lib/layout';
import NodeCard from './NodeCard';
import type { ResearchNode } from '@/lib/types';

const nodeTypes = { research: NodeCard };

export default function ResearchGraph() {
  const tree = useTreeStore((s) => s.tree);
  const selectNode = useTreeStore((s) => s.selectNode);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!tree) return { rfNodes: [] as Node[], rfEdges: [] as Edge[] };
    const layout = computeLayout(tree);
    const rfNodes: Node[] = layout.nodes.map((p) => {
      const node: ResearchNode | undefined = tree.nodes[p.id];
      return {
        id: p.id,
        type: 'research',
        position: { x: p.x, y: p.y },
        data: { node: node! },
        draggable: false,
        connectable: false,
      };
    });
    const rfEdges: Edge[] = layout.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: false,
      style: { stroke: '#a1a1aa', strokeWidth: 1.5 },
    }));
    return { rfNodes, rfEdges };
  }, [tree]);

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => selectNode(node.id),
    [selectNode]
  );

  if (!tree) return null;

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 0.9, minZoom: 0.1 }}
        minZoom={0.1}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={onNodeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
