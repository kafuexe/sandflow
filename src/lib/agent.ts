// State for the Agent screen: every run (manual, agent or triggered), live-updated, plus the new-run draft.

import { create } from "zustand";
import { summarize as toSummary } from "../../shared/runs";
import type { RunState, RunSummary } from "../../shared/types";
import { api, ApiError, subscribeFlags, subscribeRun, type FlagEvent } from "./api";
import { useStore } from "./store";

interface AgentState {
  /** Newest first. */
  list: RunSummary[];
  /** Full state of runs we've subscribed to or opened. */
  detail: Record<string, RunState>;
  /** Selected run, or null for "new run". */
  selectedId: string | null;
  draft: string;
  draftFlowId: string | null;
  starting: boolean;
  error?: string;
  /** Run ids whose answer is being sent. */
  answering: Record<string, boolean>;
  /** Flag popups on screen, newest first. */
  alerts: FlagEvent[];

  /** Merge a fresh runs list (the app polls it — see `refreshActivity` in the main store). */
  ingest(runs: RunSummary[]): void;
  select(id: string | null): void;
  setDraft(text: string): void;
  setDraftFlow(id: string): void;
  start(): Promise<void>;
  stop(id: string): Promise<void>;
  answer(id: string, text: string): Promise<boolean>;
  /** Close a popup (the flag stays on the run). */
  closeAlert(flagId: string): void;
  /** Clear a flag on the run: it leaves the Flagged list once none are left. */
  dismissFlag(runId: string, flagId: string): Promise<void>;
  /** Show the run on the Agent screen. */
  openRun(id: string): void;
}

const subs = new Map<string, () => void>();

export const useAgent = create<AgentState>((set, get) => {
  function apply(run: RunState) {
    const summary = toSummary(run);
    const list = get().list;
    const next = list.some((r) => r.id === run.id)
      ? list.map((r) => (r.id === run.id ? summary : r))
      : [summary, ...list].sort((a, b) => b.startedAt - a.startedAt);
    set({ list: next, detail: { ...get().detail, [run.id]: run } });
  }

  function watch(id: string) {
    if (subs.has(id)) return;
    subs.set(
      id,
      subscribeRun(id, (run) => {
        apply(run);
        if (run.finishedAt) subs.delete(id);
      }),
    );
  }

  async function open(id: string) {
    if (get().detail[id]) return;
    try {
      apply(await api.getRun(id));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  }

  return {
    list: [],
    detail: {},
    selectedId: null,
    draft: "",
    draftFlowId: null,
    starting: false,
    answering: {},
    alerts: [],

    ingest(fresh) {
      // Live subscriptions are fresher than the list for the runs they cover.
      const detail = get().detail;
      set({ list: fresh.map((r) => (subs.has(r.id) && detail[r.id] ? toSummary(detail[r.id]) : r)) });
      for (const r of fresh) if (!r.finishedAt) watch(r.id);
    },
    select(id) {
      set({ selectedId: id, error: undefined });
      if (id) void open(id);
    },
    setDraft(draft) {
      set({ draft });
    },
    setDraftFlow(draftFlowId) {
      set({ draftFlowId });
    },

    async start() {
      const { draft, draftFlowId } = get();
      const flowId = draftFlowId ?? useStore.getState().currentFlowId;
      if (!flowId || !draft.trim()) return;
      set({ starting: true, error: undefined });
      try {
        if (!(await useStore.getState().flushSaves())) {
          throw new Error(`Couldn't save your latest edits: ${useStore.getState().saveError}`);
        }
        const { runId } = await api.startRun(flowId, draft.trim());
        apply(await api.getRun(runId));
        watch(runId);
        set({ selectedId: runId, draft: "" });
      } catch (e) {
        const missing = e instanceof ApiError ? (e.body.missing as string[] | undefined) : undefined;
        set({ error: missing ? `Missing inputs: ${missing.join(", ")}` : (e as Error).message });
      } finally {
        set({ starting: false });
      }
    },
    async stop(id) {
      try {
        await api.cancel(id);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
    closeAlert(flagId) {
      set({ alerts: get().alerts.filter((a) => a.flag.id !== flagId) });
    },
    async dismissFlag(runId, flagId) {
      try {
        await api.dismissFlag(runId, flagId);
        const run = get().detail[runId];
        if (run) apply({ ...run, flags: run.flags?.map((f) => (f.id === flagId ? { ...f, dismissed: true } : f)) });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
    openRun(id) {
      useStore.getState().setView("agent");
      get().select(id);
    },
    async answer(id, text) {
      set({ answering: { ...get().answering, [id]: true }, error: undefined });
      try {
        await api.answer(id, text);
        return true;
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      } finally {
        set({ answering: { ...get().answering, [id]: false } });
      }
    },
  };
});

/** Runs paused on a question — shown as a badge on the Agent tab. */
export const useWaitingCount = () => useAgent((s) => s.list.filter((r) => r.pendingQuestion && !r.finishedAt).length);


// The main store polls the runs list app-wide; keep ours in step with it.
useStore.subscribe((s, prev) => {
  if (s.runs !== prev.runs) useAgent.getState().ingest(s.runs);
});

// Flags from every run, app-wide: a popup per flag, and the run list / open run kept in step.
subscribeFlags(
  (e) => {
    const s = useAgent.getState();
    useAgent.setState({ alerts: [e, ...s.alerts.filter((a) => a.flag.id !== e.flag.id)] });
    const run = s.detail[e.runId];
    if (run && !run.flags?.some((f) => f.id === e.flag.id)) useAgent.setState({ detail: { ...s.detail, [e.runId]: { ...run, flags: [...(run.flags ?? []), e.flag] } } });
    void useStore.getState().refreshActivity();
  },
  (e) => {
    useAgent.getState().closeAlert(e.flagId);
    void useStore.getState().refreshActivity();
  },
);

