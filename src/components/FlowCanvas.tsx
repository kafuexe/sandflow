import { useCallback, useEffect, useMemo, type DragEvent } from "react";
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
import { useAssistantEditing, useChatStore } from "@/lib/chatStore";
import { useCurrentFlow, useStore } from "@/lib/store";
import { resolveNode } from "../../shared/resolve";
import type { EdgeInputKind, FlowNodeData, OutputKind } from "../../shared/types";
import { BlockNode } from "./BlockNode";

export const DRAG_MIME = "application/sandflow-block";

const nodeTypes = { block: BlockNode };

export function FlowCanvas() {
  const flow = useCurrentFlow();
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const run = useStore((s) => (s.run?.flowId === flow?.id ? s.run : undefined));
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const { onNodesChange, onEdgesChange, addEdge, addNode, selectNode } = useStore.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const assistantEditing = useAssistantEditing(flow?.id);

  // Keep the assistant's new nodes in view as it adds them.
  const nodeCount = flow?.nodes.length ?? 0;
  useEffect(() => {
    if (!assistantEditing || !nodeCount) return;
    const t = setTimeout(() => void fitView({ padding: 0.2, duration: 400 }), 60);
    return () => clearTimeout(t);
  }, [assistantEditing, nodeCount, fitView]);

  // Opening/closing the assistant panel resizes the canvas — refit so the flow stays in view.
  const chatOpen = useChatStore((s) => s.open);
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.2, duration: 250 }), 60);
    return () => clearTimeout(t);
  }, [chatOpen, fitView]);

  const nodes = useMemo<Node<FlowNodeData, "block">[]>(
    () => (flow?.nodes ?? []).map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [flow?.nodes, selectedNodeId],
  );

  const edges = useMemo<Edge[]>(() => {
    if (!flow) return [];
    return flow.edges.map((e) => {
      const steer = e.sourceHandle === "steer";
      const src = run?.nodes[e.source];
      const routed = src?.routedTo === e.target;
      const color = routed ? "#22c55e" : steer ? "#f59e0b" : "#3b82f6";
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
      const target = flow.nodes.find((n) => n.id === c.target);
      if (!target || !c.targetHandle) return false;
      try {
        return resolveNode(target, blocks).inputs[c.targetHandle as EdgeInputKind] === true;
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
        sourceHandle: c.sourceHandle as OutputKind,
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
    <div className="relative h-full">
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
        onDrop={assistantEditing ? undefined : onDrop}
        onDragOver={(ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = assistantEditing ? "none" : "move";
        }}
        // While the assistant edits, the canvas is view-only so the two don't overwrite each other.
        nodesDraggable={!assistantEditing}
        nodesConnectable={!assistantEditing}
        deleteKeyCode={assistantEditing ? null : ["Backspace", "Delete"]}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} />
        <Controls />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>
      {assistantEditing && (
        <div
          role="status"
          title="The canvas is view-only until the assistant finishes, so your edits and its edits don't overwrite each other."
          className="pointer-events-none absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-violet-500/40 bg-background/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur"
        >
          <span className="size-2 animate-pulse rounded-full bg-violet-400 motion-reduce:animate-none" />
          Assistant is editing, view only
        </div>
      )}
    </div>
  );
}
