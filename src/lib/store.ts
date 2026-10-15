import { create } from "zustand";
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from "@xyflow/react";
import type {
  AppData,
  BlockConfig,
  BlockDef,
  EnvValues,
  Flow,
  FlowColor,
  FlowEdge,
  FlowNode,
  RunOn,
  RunState,
  RunSummary,
  Settings,
} from "../../shared/types";
import { cloneFlow, newFlow } from "../../shared/flows";
import { api, ApiError, subscribeData, subscribeRun, type TriggersInfo } from "./api";
import { pickFlowId, saveFlowId, savedFlowIds } from "./activeFlow";
import { mergeRun, runToShow } from "./runSelection";

type Section = "blocks" | "flows" | "settings" | "env";
export type SaveStatus = "saved" | "pending" | "saving" | "error";
export type SideTab = "inputs" | "block" | "run";
/** Builder = the flow canvas; Agent = prompt-and-run chat over flows. */
export type View = "builder" | "agent";
/** Block editor target: an existing block id, or a new block/template. */
export type EditorTarget = { id: string } | { create: "block" | "template" } | null;

interface State {
  data: AppData | null;
  loadError?: string;
  currentFlowId: string | null;
  selectedNodeId: string | null;
  editor: EditorTarget;
  settingsOpen: boolean;
  /** Packs dialog open. */
  packsOpen: boolean;
  sideTab: SideTab;
  /** The run shown on the canvas and in the Run tab (several may be going; see `runs`). */
  run?: RunState;
  /** A warning the server gave when starting a run (e.g. it shares a branch with another run). */
  runWarning?: { runId: string; message: string };
  /** Recent runs (manual + triggered), newest first. */
  runs: RunSummary[];
  triggers?: TriggersInfo;
  runError?: string;
  saveStatus: SaveStatus;
  saveError?: string;
  /** One-off message about a save (e.g. an edit replaced by the assistant's newer version). */
  saveNotice?: string;
  /** Node id → when the assistant last touched it (drives the canvas glow). */
  highlight: Record<string, number>;
  view: View;

  load(): Promise<void>;
  /** Re-read flows/blocks from the server, keeping unsaved settings/env. */
  reload(): Promise<void>;
  /** Write pending edits now (the server runs what is saved). Resolves false if saving failed. */
  flushSaves(): Promise<boolean>;
  setView(view: View): void;
  // blocks
  upsertBlock(block: BlockDef): void;
  deleteBlock(id: string): void;
  // flows
  setCurrentFlow(id: string): void;
  /** New empty flow, or a copy of `fromFlowId` (any flow, including a pack's). */
  createFlow(name: string, fromFlowId?: string): void;
  renameFlow(id: string, name: string): void;
  /** Tag a flow with a palette colour, or clear it (undefined). */
  setFlowColor(id: string, color: FlowColor | undefined): void;
  /** Turn a flow's triggers on/off. */
  setFlowActive(id: string, active: boolean): void;
  /** Where the flow's agents run by default (undefined = Settings → Sandbox). */
  setFlowRunOn(id: string, runOn: RunOn | undefined): void;
  deleteFlow(id: string): void;
  // nodes / edges (current flow)
  addNode(blockId: string, position: { x: number; y: number }, data?: Partial<FlowNode["data"]>): void;
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
  setPacksOpen(open: boolean): void;
  setSideTab(tab: SideTab): void;
  // runs
  /** Start a run of the current flow — also while other runs (of this or other flows) are going. */
  startRun(): Promise<void>;
  /** Show this run in the Run tab (and on the canvas if it belongs to the current flow). */
  watch(runId: string): Promise<void>;
  /** Refresh the runs list + trigger status (polled while the app is open). */
  refreshActivity(): Promise<void>;
  /** Stop a run (default: the one shown). */
  cancelRun(runId?: string): Promise<void>;
  answer(text: string): Promise<void>;
}

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

let dirty = new Set<Section>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** A save is scheduled (debounce running) — it will write `dirty`, or get a 409 and reload. */
let saveScheduled = false;
let unsubscribeRun: (() => void) | undefined;
let unsubscribeData: (() => void) | undefined;
/** Server revision of flows + blocks this client last saw. */
let rev = 0;
/** The reload in flight (reloads run one at a time), and whether another change arrived meanwhile. */
let reloading: Promise<void> | undefined;
let reloadAgain = false;

export const useStore = create<State>((set, get) => {
  async function flush() {
    saveScheduled = false;
    const data = get().data;
    if (!data || !dirty.size) return;
    const sections = dirty;
    dirty = new Set();
    set({ saveStatus: "saving", saveError: undefined });
    try {
      for (const s of sections) {
        // Never step back: a reload may already have seen a newer (assistant) revision.
        if (s === "blocks") rev = Math.max(rev, (await api.saveBlocks(data.blocks, rev)).rev);
        if (s === "flows") rev = Math.max(rev, (await api.saveFlows(data.flows, rev)).rev);
        if (s === "settings") await api.saveSettings(data.settings);
        if (s === "env") await api.saveEnv(data.env);
      }
      set({ saveStatus: dirty.size ? "pending" : "saved" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The assistant saved in between: its version wins, the local flow/block edit is dropped.
        sections.forEach((s) => s !== "flows" && s !== "blocks" && dirty.add(s));
        await get().reload();
        set({ saveStatus: "saved", saveNotice: "The assistant changed this flow while you were editing, so your last edit was replaced." });
        if (dirty.size) persist();
        return;
      }
      sections.forEach((s) => dirty.add(s));
      set({ saveStatus: "error", saveError: (e as Error).message });
    }
  }

  function flash(ids: string[]) {
    if (!ids.length) return;
    const now = Date.now();
    set({ highlight: { ...get().highlight, ...Object.fromEntries(ids.map((id) => [id, now])) } });
    setTimeout(() => {
      const h = { ...get().highlight };
      for (const id of ids) if (h[id] === now) delete h[id];
      set({ highlight: h });
    }, 2600);
  }

  /** Read flows/blocks from the server, keeping unsaved settings/env. */
  async function fetchData() {
    try {
      const { rev: r, ...server } = await api.getData();
      // Flow/block edits made while this was loading: leave them (and the old rev) alone — their save gets a 409 and
      // reloads, saying the edit was replaced. Applying the server's copy here would drop them without a word.
      if (saveScheduled && (dirty.has("flows") || dirty.has("blocks"))) return;
      rev = r;
      const local = get().data;
      const data: AppData = {
        ...server,
        settings: local && dirty.has("settings") ? local.settings : server.settings,
        env: local && dirty.has("env") ? local.env : server.env,
      };
      const cur = get().currentFlowId;
      const sel = get().selectedNodeId;
      const flow = data.flows.find((f) => f.id === cur) ?? data.flows[0];
      set({
        data,
        currentFlowId: flow?.id ?? null,
        selectedNodeId: flow?.nodes.some((n) => n.id === sel) ? sel : null,
      });
      if (!saveScheduled && (dirty.has("flows") || dirty.has("blocks"))) {
        // Flow/block edits whose save failed were just replaced by the server's version: nothing left to retry.
        dirty.delete("flows");
        dirty.delete("blocks");
        if (!dirty.size && get().saveStatus === "error") set({ saveStatus: "saved", saveError: undefined });
      }
    } catch {
      /* keep what we have; the next change event retries */
    }
  }

  function watchData() {
    unsubscribeData?.();
    unsubscribeData = subscribeData((c, initial) => {
      // On (re)connect the server says where it is: any other revision means we missed changes, or the server
      // restarted (its revisions start over, so later changes would look old and be skipped).
      if (initial ? c.rev === rev : c.rev <= rev) return; // our own save, or already loaded
      // A scheduled save of local flow/block edits will get a 409 and reload. Without one (e.g. the last
      // save failed) nothing else would pick the change up, so reload now — the server's version wins.
      if (saveScheduled && (dirty.has("flows") || dirty.has("blocks"))) return;
      void get().reload().then(() => {
        if (c.source === "assistant" && c.flowId === get().currentFlowId) flash(c.touched ?? []);
      });
    });
  }

  function persist(...sections: Section[]) {
    sections.forEach((s) => dirty.add(s));
    set({ saveStatus: "pending" });
    clearTimeout(timer);
    saveScheduled = true;
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
    // Pack flows are read-only (duplicate them to edit).
    if (get().data?.flows.find((f) => f.id === id)?.pack) return;
    patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? fn(f) : f)) }), "flows");
  }

  function watchRun(runId: string) {
    unsubscribeRun?.();
    unsubscribeRun = subscribeRun(runId, (run) => {
      const prev = get().run;
      // Ignore a late event of a run we've since switched away from.
      if (prev && prev.id !== run.id) return;
      set({ run, runs: mergeRun(get().runs, run) });
      if (run.pendingQuestion && !prev?.pendingQuestion) set({ sideTab: "run" });
    });
  }

  return {
    data: null,
    currentFlowId: null,
    selectedNodeId: null,
    editor: null,
    settingsOpen: false,
    packsOpen: false,
    sideTab: "inputs",
    saveStatus: "saved",
    highlight: {},
    runs: [],
    view: "builder",

    async load() {
      try {
        const { rev: r, ...data } = await api.getData();
        rev = r;
        // Reopen the flow that was open before the refresh (first flow only if it's gone).
        set({ data, currentFlowId: pickFlowId(data.flows, savedFlowIds()), loadError: undefined });
        watchData();
      } catch (e) {
        set({ loadError: (e as Error).message });
      }
    },
    reload() {
      // One at a time: overlapping reloads could land out of order and put an older version back.
      // A change that arrives meanwhile gets one more pass once the current one is done.
      if (reloading) {
        reloadAgain = true;
        return reloading;
      }
      reloading = (async () => {
        do {
          reloadAgain = false;
          await fetchData();
        } while (reloadAgain);
      })().finally(() => (reloading = undefined));
      return reloading;
    },

    async flushSaves() {
      clearTimeout(timer);
      await flush();
      return get().saveStatus !== "error";
    },
    setView(view) {
      set({ view });
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
      // Show that flow's latest active run on the canvas (without pulling the side panel to the Run tab).
      const { runs, run } = get();
      const show = runToShow(runs, id, run);
      if (show && show !== run?.id) {
        void api.getRun(show).then(
          (r) => {
            if (get().currentFlowId !== id) return;
            set({ run: r });
            watchRun(r.id);
          },
          () => {},
        );
      }
    },
    createFlow(name, fromFlowId) {
      const source = fromFlowId ? get().data?.flows.find((f) => f.id === fromFlowId) : undefined;
      const flow: Flow = source ? cloneFlow(source, uid("flow"), name) : newFlow(uid("flow"), name);
      patchData((d) => ({ ...d, flows: [...d.flows, flow] }), "flows");
      set({ currentFlowId: flow.id, selectedNodeId: null });
    },
    setFlowActive(id, active) {
      if (get().data?.flows.find((f) => f.id === id)?.pack) return;
      patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? { ...f, active } : f)) }), "flows");
    },
    setFlowRunOn(id, runOn) {
      if (get().data?.flows.find((f) => f.id === id)?.pack) return;
      patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id !== id ? f : runOn ? { ...f, runOn } : (({ runOn: _, ...rest }) => rest)(f))) }), "flows");
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
      if (get().data?.flows.find((f) => f.id === id)?.pack) return;
      patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? { ...f, name } : f)) }), "flows");
    },
    setFlowColor(id, color) {
      if (get().data?.flows.find((f) => f.id === id)?.pack) return;
      const recolor = (f: Flow): Flow => {
        const { color: _old, ...rest } = f;
        return color ? { ...rest, color } : rest;
      };
      patchData((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? recolor(f) : f)) }), "flows");
    },
    deleteFlow(id) {
      if (get().data?.flows.find((f) => f.id === id)?.pack) return;
      patchData((d) => ({ ...d, flows: d.flows.filter((f) => f.id !== id) }), "flows");
      const next = get().data?.flows[0]?.id ?? null;
      set({ currentFlowId: next, selectedNodeId: null });
    },

    addNode(blockId, position, data) {
      const node: FlowNode = { id: uid("n"), type: "block", position, data: { ...data, blockId } };
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
    setPacksOpen(packsOpen) {
      set({ packsOpen });
    },
    setSideTab(sideTab) {
      set({ sideTab });
    },

    async startRun() {
      const flowId = get().currentFlowId;
      if (!flowId) return;
      if (!(await get().flushSaves())) {
        set({ runError: `Can't run: ${get().saveError}` });
        return;
      }
      try {
        set({ runError: undefined });
        const { runId, warning } = await api.startRun(flowId);
        const run = await api.getRun(runId);
        // The new run becomes the one shown; runs already going carry on (top bar → "N running" to switch back).
        set({ run, runs: mergeRun(get().runs, run), sideTab: "run", runWarning: warning ? { runId, message: warning } : undefined });
        watchRun(runId);
      } catch (e) {
        const missing = e instanceof ApiError ? (e.body.missing as string[] | undefined) : undefined;
        set({ runError: missing ? `Missing: ${missing.join(", ")}` : (e as Error).message });
      }
    },
    async cancelRun(runId) {
      const run = get().run;
      const id = runId ?? (run && !run.finishedAt ? run.id : undefined);
      if (!id) return;
      try {
        await api.cancel(id);
      } catch (e) {
        // Already finished (404) is fine; anything else is worth showing.
        if (!(e instanceof ApiError && e.status === 404)) set({ runError: (e as Error).message });
      }
      void get().refreshActivity();
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
// Keep the open flow in the URL + localStorage so a refresh comes back to it. Only after data has
// loaded, so the initial null doesn't wipe what load() is about to restore.
useStore.subscribe((s, prev) => {
  if (s.data && (s.currentFlowId !== prev.currentFlowId || !prev.data)) saveFlowId(s.currentFlowId);
});

export const useCurrentFlow = () =>
  useStore((s) => s.data?.flows.find((f) => f.id === s.currentFlowId) ?? null);
