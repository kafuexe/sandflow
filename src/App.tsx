import { useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Check, CloudUpload, Loader2, MessagesSquare, Pencil, Play, Plus, Settings, Square, Trash2, TriangleAlert, Waves, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BlockEditor } from "@/components/BlockEditor";
import { QuestionDialog, SettingsDialog } from "@/components/Dialogs";
import { FlowCanvas } from "@/components/FlowCanvas";
import { useMissingInputs } from "@/components/InputsPanel";
import { NewFlowDialog } from "@/components/NewFlowDialog";
import { Palette } from "@/components/Palette";
import { SidePanel } from "@/components/SidePanel";
import { Switch } from "@/components/ui/switch";
import { resolveNode } from "../shared/resolve";
import { AgentScreen } from "@/components/agent/AgentScreen";
import { useWaitingCount } from "@/lib/agent";
import { useCurrentFlow, useStore, type View } from "@/lib/store";
import { cn } from "@/lib/utils";

function SaveIndicator() {
  const status = useStore((s) => s.saveStatus);
  const error = useStore((s) => s.saveError);
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

/** Arms the flow's schedule / GitHub / GitLab triggers. Shown only when the flow has such a trigger. */
function ActiveSwitch({ flowId }: { flowId: string }) {
  const flow = useStore((s) => s.data?.flows.find((f) => f.id === flowId));
  const blocks = useStore((s) => s.data?.blocks);
  const triggers = useStore((s) => s.triggers?.triggers);
  const setFlowActive = useStore((s) => s.setFlowActive);
  const hasTriggers = !!flow?.nodes.some((n) => {
    try {
      const cfg = resolveNode(n, blocks ?? []);
      return cfg.kind === "trigger" && cfg.trigger.type !== "manual";
    } catch {
      return false;
    }
  });
  if (!flow || !hasTriggers) return null;
  const armed = (triggers ?? []).filter((t) => t.flowId === flowId);
  const errors = armed.filter((t) => t.lastError).length;
  return (
    <label
      className="flex items-center gap-2 text-xs"
      title={flow.active ? `${armed.length} trigger(s) listening${errors ? `, ${errors} with errors` : ""}` : "Triggers are off"}
    >
      <Switch checked={!!flow.active} onCheckedChange={(v) => setFlowActive(flowId, v)} />
      <span className={flow.active ? (errors ? "text-amber-400" : "text-emerald-400") : "text-muted-foreground"}>
        {flow.active ? (errors ? "Active (errors)" : "Active") : "Inactive"}
      </span>
    </label>
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
  const flows = useStore((s) => s.data?.flows ?? []);
  const flow = useCurrentFlow();
  const run = useStore((s) => s.run);
  const view = useStore((s) => s.view);
  const { setCurrentFlow, renameFlow, deleteFlow, setSettingsOpen, startRun, cancelRun, setSideTab } = useStore.getState();
  const missing = useMissingInputs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const active = run && !run.finishedAt;
  const canRun = !!flow && flow.nodes.length > 0 && missing.length === 0 && !active && !starting;

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
          <Input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={() => setRenaming(null)} className="h-8 w-56" />
        </form>
      ) : (
        <Select value={flow?.id ?? ""} onValueChange={setCurrentFlow}>
          <SelectTrigger size="sm" className="w-56">
            <SelectValue placeholder="No flows" />
          </SelectTrigger>
          <SelectContent>
            {flows.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {view === "builder" && (
        <>
          <Button size="sm" variant="ghost" title="New pipeline (empty or cloned)" onClick={() => setNewOpen(true)}>
            <Plus /> New
          </Button>
          <Button size="sm" variant="ghost" title="Rename flow" disabled={!flow} onClick={() => setRenaming(flow?.name ?? "")}>
            <Pencil />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Delete flow"
            disabled={!flow}
            onClick={() => flow && confirm(`Delete flow "${flow.name}"?`) && deleteFlow(flow.id)}
          >
            <Trash2 />
          </Button>
        </>
      )}

      <div className="ml-auto flex items-center gap-3">
        {flow && <ActiveSwitch flowId={flow.id} />}
        <SaveIndicator />
        <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
          <Settings /> Settings
        </Button>
        {view === "agent" ? null : active ? (
          <Button size="sm" variant="destructive" onClick={() => void cancelRun()}>
            <Square /> Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canRun}
            title={missing.length ? `Missing: ${missing.join(", ")}` : undefined}
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
  const view = useStore((s) => s.view);

  useEffect(() => {
    void useStore.getState().load();
    // Runs can start on their own (triggers), so keep the runs list + trigger status fresh.
    const tick = () => void useStore.getState().refreshActivity();
    tick();
    const timer = setInterval(tick, 4000);
    return () => clearInterval(timer);
  }, []);

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
            <Palette />
            <main className="min-w-0 flex-1">
              <FlowCanvas />
            </main>
            <SidePanel />
          </div>
        )}
      </div>
      {editor && <BlockEditor />}
      <SettingsDialog />
      {view === "builder" && <QuestionDialog />}
    </ReactFlowProvider>
  );
}
