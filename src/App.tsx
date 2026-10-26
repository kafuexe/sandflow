import { useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { BotMessageSquare, Check, CloudUpload, Info, Loader2, MessagesSquare, Pencil, Play, Plus, Settings, Trash2, TriangleAlert, Waves, Workflow } from "lucide-react";
import { ChatPanel } from "@/components/ChatPanel";
import { useChatStore } from "@/lib/chatStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BlockEditor } from "@/components/BlockEditor";
import { QuestionDialog, SettingsDialog } from "@/components/Dialogs";
import { FlagAlerts } from "@/components/FlagAlerts";
import { FlowCanvas } from "@/components/FlowCanvas";
import { FlowSwitcher } from "@/components/FlowSwitcher";
import { useMissingInputs, useTriggerMissingInputs } from "@/components/InputsPanel";
import { NewFlowDialog } from "@/components/NewFlowDialog";
import { IntegrationsDialog } from "@/components/IntegrationsDialog";
import { PacksDialog } from "@/components/PacksDialog";
import { Palette } from "@/components/Palette";
import { RunsIndicator } from "@/components/RunsIndicator";
import { SidePanel } from "@/components/SidePanel";
import { Switch } from "@/components/ui/switch";
import { startsItself } from "../shared/resolve";
import { AgentScreen } from "@/components/agent/AgentScreen";
import { useWaitingCount } from "@/lib/agent";
import { useCurrentFlow, useStore, type View } from "@/lib/store";
import { activeRunsOf } from "@/lib/runSelection";
import { cn } from "@/lib/utils";

function SaveIndicator() {
  const status = useStore((s) => s.saveStatus);
  const error = useStore((s) => s.saveError);
  const notice = useStore((s) => s.saveNotice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => useStore.setState({ saveNotice: undefined }), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  if (notice && status === "saved")
    return (
      <span className="flex max-w-md items-center gap-1 text-xs text-amber-300" title={notice}>
        <Info className="size-3.5 shrink-0" /> <span className="truncate">{notice}</span>
      </span>
    );
  if (status === "error")
    return (
      <span className="flex items-center gap-1 text-xs text-red-400" title={error}>
        <TriangleAlert className="size-3.5" /> Save failed: {error}
      </span>
    );
  if (status === "saved")
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3.5" /> Saved
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      {status === "saving" ? <Loader2 className="size-3.5 animate-spin" /> : <CloudUpload className="size-3.5" />} Saving…
    </span>
  );
}

function EditWithAiButton() {
  const flow = useCurrentFlow();
  const open = useChatStore((s) => s.open);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!flow}
      aria-pressed={open}
      title="Describe a flow or a change and let the assistant build it"
      className={cn("ml-1", open && "border-violet-500/60 bg-violet-500/10 dark:bg-violet-500/10")}
      onClick={() => {
        const chat = useChatStore.getState();
        if (open) chat.close();
        else if (flow) void chat.openPanel(flow.id);
      }}
    >
      <BotMessageSquare className="text-violet-400" /> Edit with AI
    </Button>
  );
}

/**
 * Arms the flow's schedule / GitHub / GitLab triggers. Shown only when the flow has such a trigger. Needs no prior
 * run: what triggered runs still need (env vars, webhook secret) is shown here and opens the Inputs tab.
 */
function ActiveSwitch({ flowId }: { flowId: string }) {
  const flow = useStore((s) => s.data?.flows.find((f) => f.id === flowId));
  const blocks = useStore((s) => s.data?.blocks);
  const triggers = useStore((s) => s.triggers?.triggers);
  const { setFlowActive, setSideTab, setView } = useStore.getState();
  const openInputs = () => (setSideTab("inputs"), setView("builder"));
  const missing = useTriggerMissingInputs(flowId);
  const hasTriggers = !!flow && startsItself(flow, blocks ?? []);
  if (!flow || !hasTriggers || flow.pack) return null;
  const armed = (triggers ?? []).filter((t) => t.flowId === flowId);
  const errors = armed.filter((t) => t.lastError);
  const needs = missing.length ? `Triggered runs need: ${missing.join(", ")} (set in Inputs)` : "";
  const title = flow.active
    ? [`${armed.length} trigger(s) listening`, needs, ...errors.map((t) => `${t.label}: ${t.lastError}`)].filter(Boolean).join("\n")
    : ["Triggers are off — switch on to start this flow on its triggers (no run needed first)", needs].filter(Boolean).join("\n");
  const warn = missing.length > 0 || errors.length > 0;
  return (
    <div className="flex items-center gap-2 text-xs" title={title}>
      <label className="flex items-center gap-2">
        <Switch
          checked={!!flow.active}
          onCheckedChange={(v) => {
            setFlowActive(flowId, v);
            if (v && missing.length) openInputs();
          }}
        />
        <span className={flow.active ? (warn ? "text-amber-400" : "text-emerald-400") : "text-muted-foreground"}>
          {flow.active ? (missing.length ? "Active (needs inputs)" : errors.length ? "Active (errors)" : "Active") : "Inactive"}
        </span>
      </label>
      {missing.length > 0 && (
        <button type="button" className="max-w-48 truncate text-amber-400 underline-offset-2 hover:underline" onClick={openInputs}>
          Missing: {missing.join(", ")}
        </button>
      )}
    </div>
  );
}

function ViewSwitch() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const waiting = useWaitingCount();
  const tab = (v: View, icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => setView(v)}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4",
        view === v ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon} {label} {extra}
    </button>
  );
  return (
    <div role="tablist" aria-label="Screen" className="flex items-center gap-0.5 rounded-lg bg-secondary/70 p-0.5">
      {tab("builder", <Workflow />, "Builder")}
      {tab(
        "agent",
        <MessagesSquare />,
        "Agent",
        waiting > 0 && (
          <span
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[11px] font-semibold text-black tabular-nums"
            title={`${waiting} ${waiting === 1 ? "run needs" : "runs need"} your answer`}
          >
            {waiting}
          </span>
        ),
      )}
    </div>
  );
}

function TopBar() {
  const flow = useCurrentFlow();
  const view = useStore((s) => s.view);
  const anyActive = useStore((s) => !!flow && activeRunsOf(s.runs, flow.id, s.run).length > 0);
  const { renameFlow, deleteFlow, setSettingsOpen, startRun, setSideTab } = useStore.getState();
  const missing = useMissingInputs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // Runs don't block each other: Run stays available while earlier runs (of this or other flows) are going.
  const canRun = !!flow && flow.nodes.length > 0 && missing.length === 0 && !starting;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <div className="mr-2 flex items-center gap-1.5 font-semibold">
        <Waves className="size-5 text-amber-400" /> Sandflow
      </div>
      <ViewSwitch />

      {view === "agent" ? null : renaming !== null && flow ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming.trim()) renameFlow(flow.id, renaming.trim());
            setRenaming(null);
          }}
        >
          <Input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={() => setRenaming(null)} className="h-8 w-60" />
        </form>
      ) : (
        <FlowSwitcher onNewFlow={() => setNewOpen(true)} />
      )}
      {view === "builder" && (
        <>
          <Button size="sm" variant="ghost" title="New pipeline (empty or cloned)" onClick={() => setNewOpen(true)}>
            <Plus /> New
          </Button>
          <Button size="sm" variant="ghost" title={flow?.pack ? "Pack flows can't be renamed — duplicate it first" : "Rename flow"} disabled={!flow || !!flow.pack} onClick={() => setRenaming(flow?.name ?? "")}>
            <Pencil />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={flow?.pack ? "Pack flows are removed with their pack (Packs)" : "Delete flow"}
            disabled={!flow || !!flow.pack}
            onClick={() => flow && confirm(`Delete flow "${flow.name}"?`) && deleteFlow(flow.id)}
          >
            <Trash2 />
          </Button>
          <EditWithAiButton />
        </>
      )}

      <div className="ml-auto flex items-center gap-3">
        {flow && <ActiveSwitch flowId={flow.id} />}
        <SaveIndicator />
        <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
          <Settings /> Settings
        </Button>
        {view !== "agent" && flow && <RunsIndicator flowId={flow.id} />}
        {view === "agent" ? null : (
          <Button
            size="sm"
            disabled={!canRun}
            title={missing.length ? `Missing: ${missing.join(", ")}` : anyActive ? "Start another run of this flow" : undefined}
            onClick={async () => {
              setStarting(true);
              await startRun();
              setStarting(false);
            }}
            onMouseEnter={() => missing.length && setSideTab("inputs")}
          >
            {starting ? <Loader2 className="animate-spin" /> : <Play />} Run
          </Button>
        )}
      </div>
      <NewFlowDialog open={newOpen} onOpenChange={setNewOpen} />
    </header>
  );
}

export default function App() {
  const data = useStore((s) => s.data);
  const loadError = useStore((s) => s.loadError);
  const editor = useStore((s) => s.editor);
  const currentFlowId = useStore((s) => s.currentFlowId);
  const chatOpen = useChatStore((s) => s.open);
  const view = useStore((s) => s.view);

  useEffect(() => {
    void useStore.getState().load();
    // Runs can start on their own (triggers), so keep the runs list + trigger status fresh.
    const tick = () => void useStore.getState().refreshActivity();
    tick();
    const timer = setInterval(tick, 4000);
    return () => clearInterval(timer);
  }, []);

  // The assistant panel always talks about the flow on the canvas.
  useEffect(() => {
    if (chatOpen) void useChatStore.getState().flowChanged(currentFlowId);
  }, [chatOpen, currentFlowId]);

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {loadError ? <span className="text-red-400">Failed to load: {loadError}</span> : <Loader2 className="animate-spin" />}
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        {view === "agent" ? (
          <main className="min-h-0 flex-1">
            <AgentScreen />
          </main>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* The palette stays visible next to the chat; the canvas shrinks to make room. */}
            <Palette />
            {/* Keeps room for the canvas: the side panels shrink (to their minimums) before it does. */}
            <main className="min-w-[min(360px,30vw)] flex-1">
              <FlowCanvas />
            </main>
            {chatOpen && <ChatPanel />}
            <SidePanel />
          </div>
        )}
      </div>
      {editor && <BlockEditor />}
      <SettingsDialog />
      <PacksDialog />
      <IntegrationsDialog />
      {view === "builder" && <QuestionDialog />}
      <FlagAlerts />
    </ReactFlowProvider>
  );
}
