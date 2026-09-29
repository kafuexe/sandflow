import { useCallback, useMemo, type DragEvent } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
} from "@xyflow/react";
import { useCurrentFlow, useStore } from "@/lib/store";
import { resolveNode } from "../../shared/resolve";
import type { EdgeInputKind, FlowNodeData, SourceHandle } from "../../shared/types";
import { edgeAllowed } from "../../shared/validate";
import { BlockNode } from "./BlockNode";

export const DRAG_MIME = "application/sandflow-block";

const nodeTypes = { block: BlockNode };

export function FlowCanvas() {
  const flow = useCurrentFlow();
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const run = useStore((s) => (s.run?.flowId === flow?.id ? s.run : undefined));
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const { onNodesChange, onEdgesChange, addEdge, addNode, selectNode } = useStore.getState();
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useMemo<Node<FlowNodeData, "block">[]>(
    () => (flow?.nodes ?? []).map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [flow?.nodes, selectedNodeId],
  );

  const edges = useMemo<Edge[]>(() => {
    if (!flow) return [];
    return flow.edges.map((e) => {
      const steer = e.sourceHandle === "steer";
      const branch = e.sourceHandle === "true" || e.sourceHandle === "false";
      const src = run?.nodes[e.source];
      const routed = src?.routedTo === e.target || (branch && src?.branch === e.sourceHandle);
      const color = branch
        ? e.sourceHandle === "true" ? "#10b981" : "#ef4444"
        : routed ? "#22c55e" : steer ? "#f59e0b" : "#3b82f6";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        animated: src?.status === "running",
        style: { stroke: color, strokeWidth: routed ? 3 : 2, strokeDasharray: steer ? "6 4" : undefined },
      };
    });
  }, [flow, run]);

  const isValidConnection = useCallback<IsValidConnection>(
    (c) => {
      if (!flow || c.source === c.target) return false;
      const source = flow.nodes.find((n) => n.id === c.source);
      const target = flow.nodes.find((n) => n.id === c.target);
      if (!source || !target || !c.sourceHandle || !c.targetHandle) return false;
      try {
        return edgeAllowed(
          resolveNode(source, blocks),
          c.sourceHandle as SourceHandle,
          resolveNode(target, blocks),
          c.targetHandle as EdgeInputKind,
        );
      } catch {
        return false;
      }
    },
    [flow, blocks],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.targetHandle) return;
      addEdge({
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle as SourceHandle,
        targetHandle: c.targetHandle as EdgeInputKind,
      });
    },
    [addEdge],
  );

  const onDrop = useCallback(
    (ev: DragEvent) => {
      ev.preventDefault();
      const blockId = ev.dataTransfer.getData(DRAG_MIME);
      if (!blockId) return;
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      addNode(blockId, { x: p.x - 120, y: p.y - 40 });
    },
    [addNode, screenToFlowPosition],
  );

  if (!flow) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No flow selected — create one from the top bar.
      </div>
    );
  }

  return (
    <ReactFlow
      key={flow.id}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeClick={(_, n) => selectNode(n.id)}
      onPaneClick={() => selectNode(null)}
      onDrop={onDrop}
      onDragOver={(ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
      }}
      deleteKeyCode={["Backspace", "Delete"]}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} />
      <Controls />
      <MiniMap pannable zoomable className="!bg-card" />
    </ReactFlow>
  );
}
