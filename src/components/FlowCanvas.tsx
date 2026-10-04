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
import { Copy, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantEditing, useChatStore } from "@/lib/chatStore";
import { useCurrentFlow, useStore } from "@/lib/store";
import { SUBFLOW_BLOCK } from "../../shared/core";
import { isExitHandle, resolveNodeIn, subflowCycle } from "../../shared/subflow";
import type { EdgeInputKind, FlowNode, FlowNodeData, SourceHandle } from "../../shared/types";
import { edgeAllowed } from "../../shared/validate";
import { BlockNode } from "./BlockNode";

export const DRAG_MIME = "application/sandflow-block";
/** Dragging a flow from the Flows tab: dropped on the canvas it becomes a subflow node. */
export const DRAG_FLOW_MIME = "application/sandflow-flow";

const nodeTypes = { block: BlockNode };

export function FlowCanvas() {
  const flow = useCurrentFlow();
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const flows = useStore((s) => s.data?.flows ?? []);
  const packs = useStore((s) => s.data?.packs ?? []);
  const run = useStore((s) => (s.run?.flowId === flow?.id ? s.run : undefined));
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const { onNodesChange, onEdgesChange, addEdge, addNode, selectNode, createFlow } = useStore.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const assistantEditing = useAssistantEditing(flow?.id);
  // Pack flows are view-only (duplicate to edit); so is a flow the assistant is editing.
  const readOnly = assistantEditing || !!flow?.pack;

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
      const steer = e.sourceHandle === "steer" || (isExitHandle(e.sourceHandle) && e.targetHandle === "steer");
      const branch = e.sourceHandle === "true" || e.sourceHandle === "false";
      const exit = isExitHandle(e.sourceHandle);
      const src = run?.nodes[e.source];
      const routed = src?.routedTo === e.target || (branch && src?.branch === e.sourceHandle) || (exit && `exit:${src?.exit}` === e.sourceHandle);
      const color = branch
        ? e.sourceHandle === "true" ? "#10b981" : "#ef4444"
        : routed ? "#22c55e" : exit ? "#a855f7" : steer ? "#f59e0b" : "#3b82f6";
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
        const s = resolveNodeIn(source, blocks, flows);
        return edgeAllowed(s, c.sourceHandle as SourceHandle, resolveNodeIn(target, blocks, flows), c.targetHandle as EdgeInputKind, s.exits);
      } catch {
        return false;
      }
    },
    [flow, blocks, flows],
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
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const at = { x: p.x - 120, y: p.y - 40 };
      const childId = ev.dataTransfer.getData(DRAG_FLOW_MIME);
      if (childId && flow) {
        const child = flows.find((f) => f.id === childId);
        if (!child) return;
        // Would the open flow end up containing itself?
        const probe: FlowNode = { id: "_probe", type: "block", position: at, data: { blockId: SUBFLOW_BLOCK, overrides: { subflow: { flowId: childId } } } };
        const trial = flows.map((f) => (f.id === flow.id ? { ...f, nodes: [...f.nodes, probe] } : f));
        const cycle = childId === flow.id ? `${flow.name} › ${flow.name}` : subflowCycle(flow.id, trial, blocks);
        if (cycle) {
          alert(`Can't add "${child.name}" here: ${cycle} — a flow can't contain itself.`);
          return;
        }
        addNode(SUBFLOW_BLOCK, at, { label: child.name, overrides: { subflow: { flowId: childId } } });
        return;
      }
      const blockId = ev.dataTransfer.getData(DRAG_MIME);
      if (blockId) addNode(blockId, at);
    },
    [addNode, screenToFlowPosition, flow, flows, blocks],
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
        onDrop={readOnly ? undefined : onDrop}
        onDragOver={(ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = readOnly ? "none" : ev.dataTransfer.types.includes(DRAG_FLOW_MIME) ? "copy" : "move";
        }}
        // While the assistant edits, the canvas is view-only so the two don't overwrite each other.
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} />
        <Controls />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>
      {flow.pack && !assistantEditing && (
        <div
          role="status"
          className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/90 py-1 pr-1 pl-3 text-xs shadow-lg backdrop-blur"
        >
          <Lock className="size-3.5 text-muted-foreground" />
          <span className="whitespace-nowrap">
            From the <b>{packs.find((p) => p.id === flow.pack)?.name ?? flow.pack}</b> pack, view only
          </span>
          <Button size="sm" variant="secondary" className="h-6 rounded-full px-2 text-xs" onClick={() => createFlow(`${flow.name} (copy)`, flow.id)}>
            <Copy className="size-3" /> Duplicate to edit
          </Button>
        </div>
      )}
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
