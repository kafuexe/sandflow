import { create } from "zustand";
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from "@xyflow/react";
import type {
  AppData,
  BlockConfig,
  BlockDef,
  EnvValues,
  Flow,
  FlowEdge,
  FlowNode,
  RunState,
  RunSummary,
  Settings,
} from "../../shared/types";
import { cloneFlow, newFlow } from "../../shared/flows";
import { EXAMPLE_FLOWS } from "../../shared/library";
import { api, ApiError, subscribeRun, type TriggersInfo } from "./api";

type Section = "blocks" | "flows" | "settings" | "env";
export type SaveStatus = "saved" | "pending" | "saving" | "error";
export type SideTab = "inputs" | "block" | "run";
/** Block editor target: an existing block id, or a new block/template. */
export type EditorTarget = { id: string } | { create: "block" | "template" } | null;

interface State {
  data: AppData | null;
  loadError?: string;
  currentFlowId: string | null;
  selectedNodeId: string | null;
  editor: EditorTarget;
  settingsOpen: boolean;
  sideTab: SideTab;
  run?: RunState;
  /** Recent runs (manual + triggered), newest first. */
  runs: RunSummary[];
  triggers?: TriggersInfo;
  runError?: string;
  saveStatus: SaveStatus;
  saveError?: string;

  load(): Promise<void>;
  // blocks
  upsertBlock(block: BlockDef): void;
  deleteBlock(id: string): void;
  // flows
  setCurrentFlow(id: string): void;
  /** New empty flow, or a copy of `fromFlowId`. */
  createFlow(name: string, fromFlowId?: string): void;
  renameFlow(id: string, name: string): void;
  /** Turn a flow's triggers on/off. */
  setFlowActive(id: string, active: boolean): void;
  deleteFlow(id: string): void;
  // nodes / edges (current flow)
  addNode(blockId: string, position: { x: number; y: number }): void;
  updateNodeData(id: string, patch: Partial<FlowNode["data"]>): void;
  updateNodeOverrides(id: string, patch: BlockConfig): void;
  removeNode(id: string): void;
  onNodesChange(changes: NodeChange[]): void;
  onEdgesChange(changes: EdgeChange[]): void;
  addEdge(edge: Omit<FlowEdge, "id">): void;
  // settings / env
  updateSettings(patch: Partial<Settings>): void;
  setEnv(name: string, value: string): void;
  removeEnv(name: string): void;
  // ui
  selectNode(id: string | null): void;
  openEditor(target: EditorTarget): void;
  setSettingsOpen(open: boolean): void;
  setSideTab(tab: SideTab): void;
  // runs
  startRun(): Promise<void>;
  /** Show this run in the Run tab (and on the canvas if it belongs to the current flow). */
  watch(runId: string): Promise<void>;
  /** Refresh the runs list + trigger status (polled while the app is open). */
  refreshActivity(): Promise<void>;
  cancelRun(): Promise<void>;
  answer(text: string): Promise<void>;
}

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

let dirty = new Set<Section>();
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeRun: (() => void) | undefined;

export const useStore = create<State>((set, get) => {
  async function flush() {
    const data = get().data;
    if (!data || !dirty.size) return;
    const sections = dirty;
    dirty = new Set();
    set({ saveStatus: "saving", saveError: undefined });
    try {
      for (const s of sections) {
        if (s === "blocks") await api.saveBlocks(data.blocks);
        if (s === "flows") await api.saveFlows(data.flows);
        if (s === "settings") await api.saveSettings(data.settings);
        if (s === "env") await api.saveEnv(data.env);
      }
      set({ saveStatus: dirty.size ? "pending" : "saved" });
    } catch (e) {
      sections.forEach((s) => dirty.add(s));
      set({ saveStatus: "error", saveError: (e as Error).message });
    }
  }

  function persist(...sections: Section[]) {
    sections.forEach((s) => dirty.add(s));
    set({ saveStatus: "pending" });
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  }

  function patchData(fn: (d: AppData) => AppData, ...sections: Section[]) {
    const d = get().data;
    if (!d) return;
    set({ data: fn(d) });
    persist(...sections);
  }

  function patchFlow(fn: (f: Flow) => Flow) {
    const id = get().currentFlowId;
    patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? fn(f) : f)) }), "flows");
  }

  function watchRun(runId: string) {
    unsubscribeRun?.();
    unsubscribeRun = subscribeRun(runId, (run) => {
      const prev = get().run;
      set({ run });
      if (run.pendingQuestion && !prev?.pendingQuestion) set({ sideTab: "run" });
    });
  }

  return {
    data: null,
    currentFlowId: null,
    selectedNodeId: null,
    editor: null,
    settingsOpen: false,
    sideTab: "inputs",
    saveStatus: "saved",
    runs: [],

    async load() {
      try {
        const data = await api.getData();
        set({ data, currentFlowId: data.flows[0]?.id ?? null, loadError: undefined });
      } catch (e) {
        set({ loadError: (e as Error).message });
      }
    },

    upsertBlock(block) {
      patchData(
        (d) => ({
          ...d,
          blocks: d.blocks.some((b) => b.id === block.id)
            ? d.blocks.map((b) => (b.id === block.id ? block : b))
            : [...d.blocks, block],
        }),
        "blocks",
      );
    },
    deleteBlock(id) {
      patchData((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }), "blocks");
    },

    setCurrentFlow(id) {
      set({ currentFlowId: id, selectedNodeId: null });
    },
    createFlow(name, fromFlowId) {
      const source = fromFlowId
        ? (get().data?.flows.find((f) => f.id === fromFlowId) ?? EXAMPLE_FLOWS.find((f) => f.id === fromFlowId))
        : undefined;
      const flow: Flow = source ? cloneFlow(source, uid("flow"), name) : newFlow(uid("flow"), name);
      patchData((d) => ({ ...d, flows: [...d.flows, flow] }), "flows");
      set({ currentFlowId: flow.id, selectedNodeId: null });
    },
    setFlowActive(id, active) {
      patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? { ...f, active } : f)) }), "flows");
    },
    async watch(runId) {
      try {
        set({ run: await api.getRun(runId), sideTab: "run" });
        watchRun(runId);
      } catch (e) {
        set({ runError: (e as Error).message });
      }
    },
    async refreshActivity() {
      try {
        const [runs, triggers] = await Promise.all([api.listRuns(), api.triggers()]);
        set({ runs, triggers });
        // Follow a new triggered run of the flow on screen, unless you're watching one that's still going.
        const { run, currentFlowId } = get();
        const fresh = runs.find((r) => r.flowId === currentFlowId && !r.finishedAt && r.id !== run?.id);
        if (fresh && (!run || run.finishedAt) && fresh.startedAt > (run?.startedAt ?? 0)) void get().watch(fresh.id);
      } catch {
        /* server restarting — try again next tick */
      }
    },
    renameFlow(id, name) {
      patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? { ...f, name } : f)) }), "flows");
    },
    deleteFlow(id) {
      patchData((d) => ({ ...d, flows: d.flows.filter((f) => f.id !== id) }), "flows");
      const next = get().data?.flows[0]?.id ?? null;
      set({ currentFlowId: next, selectedNodeId: null });
    },

    addNode(blockId, position) {
      const node: FlowNode = { id: uid("n"), type: "block", position, data: { blockId } };
      patchFlow((f) => ({ ...f, nodes: [...f.nodes, node] }));
      set({ selectedNodeId: node.id, sideTab: "block" });
    },
    updateNodeData(id, patch) {
      patchFlow((f) => ({
        ...f,
        nodes: f.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      }));
    },
    updateNodeOverrides(id, patch) {
      patchFlow((f) => ({
        ...f,
        nodes: f.nodes.map((n) => {
          if (n.id !== id) return n;
          const overrides = { ...n.data.overrides, ...patch };
          for (const k of Object.keys(overrides) as (keyof BlockConfig)[]) {
            if (overrides[k] === undefined) delete overrides[k];
          }
          return { ...n, data: { ...n.data, overrides } };
        }),
      }));
    },
    removeNode(id) {
      patchFlow((f) => ({
        ...f,
        nodes: f.nodes.filter((n) => n.id !== id),
        edges: f.edges.filter((e) => e.source !== id && e.target !== id),
      }));
      if (get().selectedNodeId === id) set({ selectedNodeId: null });
    },
    onNodesChange(changes) {
      const meaningful = changes.filter((c) => c.type !== "select" && c.type !== "dimensions");
      for (const c of changes) {
        if (c.type === "select" && c.selected) set({ selectedNodeId: c.id });
      }
      if (!meaningful.length) return;
      patchFlow((f) => {
        const nodes = applyNodeChanges(meaningful, f.nodes as never) as unknown as FlowNode[];
        const ids = new Set(nodes.map((n) => n.id));
        return {
          ...f,
          nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
          edges: f.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
        };
      });
      const sel = get().selectedNodeId;
      if (sel && !get().data?.flows.find((f) => f.id === get().currentFlowId)?.nodes.some((n) => n.id === sel)) {
        set({ selectedNodeId: null });
      }
    },
    onEdgesChange(changes) {
      const meaningful = changes.filter((c) => c.type === "remove");
      if (!meaningful.length) return;
      patchFlow((f) => ({
        ...f,
        edges: (applyEdgeChanges(meaningful, f.edges as never) as unknown as FlowEdge[]).map(
          ({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }),
        ),
      }));
    },
    addEdge(edge) {
      const id = `e-${edge.source}-${edge.sourceHandle}-${edge.target}-${edge.targetHandle}`;
      patchFlow((f) => (f.edges.some((e) => e.id === id) ? f : { ...f, edges: [...f.edges, { ...edge, id }] }));
    },

    updateSettings(patch) {
      patchData((d) => ({ ...d, settings: { ...d.settings, ...patch } }), "settings");
    },
    setEnv(name, value) {
      patchData((d) => ({ ...d, env: { ...d.env, [name]: value } as EnvValues }), "env");
    },
    removeEnv(name) {
      patchData((d) => {
        const env = { ...d.env };
        delete env[name];
        return { ...d, env };
      }, "env");
    },

    selectNode(id) {
      set({ selectedNodeId: id, ...(id ? { sideTab: "block" as const } : {}) });
    },
    openEditor(editor) {
      set({ editor });
    },
    setSettingsOpen(settingsOpen) {
      set({ settingsOpen });
    },
    setSideTab(sideTab) {
      set({ sideTab });
    },

    async startRun() {
      const flowId = get().currentFlowId;
      if (!flowId) return;
      clearTimeout(timer);
      await flush(); // the server runs what is saved
      if (get().saveStatus === "error") {
        set({ runError: `Can't run: ${get().saveError}` });
        return;
      }
      try {
        set({ runError: undefined });
        const { runId } = await api.startRun(flowId);
        set({ run: await api.getRun(runId), sideTab: "run" });
        watchRun(runId);
      } catch (e) {
        const missing = e instanceof ApiError ? (e.body.missing as string[] | undefined) : undefined;
        set({ runError: missing ? `Missing: ${missing.join(", ")}` : (e as Error).message });
      }
    },
    async cancelRun() {
      const run = get().run;
      if (run && !run.finishedAt) await api.cancel(run.id).catch(() => {});
    },
    async answer(text) {
      const run = get().run;
      if (!run) return;
      try {
        await api.answer(run.id, text);
      } catch (e) {
        set({ runError: (e as Error).message });
      }
    },
  };
});

/** The flow currently shown on the canvas. */
export const useCurrentFlow = () =>
  useStore((s) => s.data?.flows.find((f) => f.id === s.currentFlowId) ?? null);
