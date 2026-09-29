import { useMemo } from "react";
import { ChevronRight, Loader2, Play, TriangleAlert, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAgent } from "@/lib/agent";
import { BlockIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { flowSteps } from "@/lib/timeline";
import { flowRequirements, resolveNode } from "../../../shared/resolve";
import { missingInputs } from "../../../shared/validate";
import { ComposerInput } from "./Composer";

/** Write a task, pick the flow that should carry it out, start it. */
export function NewRun() {
  const data = useStore((s) => s.data!);
  const currentFlowId = useStore((s) => s.currentFlowId);
  const { draft, draftFlowId, starting, error } = useAgent();
  const { setDraft, setDraftFlow, start } = useAgent.getState();

  const flow = data.flows.find((f) => f.id === (draftFlowId ?? currentFlowId)) ?? data.flows[0];
  const steps = useMemo(() => {
    if (!flow) return [];
    return flowSteps(flow, data.blocks).map((s) => {
      const node = flow.nodes.find((n) => n.id === s.id)!;
      let icon = "box";
      let color = "#71717a";
      try {
        ({ icon, color } = resolveNode(node, data.blocks));
      } catch {
        /* unknown block */
      }
      return { ...s, icon, color };
    });
  }, [flow, data.blocks]);

  // The prompt is typed here, so only env vars can be missing.
  const missing = flow ? missingInputs(flow, data.blocks, data.env, "-") : [];
  const readsPrompt = flow ? flowRequirements(flow, data.blocks).startingPromptNodes.length > 0 : false;
  const canStart = !!flow && flow.nodes.length > 0 && !!draft.trim() && !missing.length && !starting;

  const openInputs = () => {
    const s = useStore.getState();
    if (flow) s.setCurrentFlow(flow.id);
    s.setSideTab("inputs");
    s.setView("builder");
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-y-auto" aria-label="New run">
      <div className="mx-auto w-full max-w-2xl space-y-4 px-6 pt-[12vh] pb-10">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">What should the flow work on?</h2>
          <p className="text-sm text-muted-foreground">
            Describe the task like you would to a teammate. The flow runs it block by block and asks you here when it needs
            a decision.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canStart) void start();
          }}
          className="rounded-xl border bg-card/60 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
        >
          <label htmlFor="task" className="sr-only">
            Task
          </label>
          <ComposerInput
            id="task"
            autoFocus
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canStart) {
                e.preventDefault();
                void start();
              }
            }}
            placeholder="e.g. Add a dark mode toggle to the settings page and remember the choice per user"
            className="min-h-28"
          />
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
            <Select value={flow?.id ?? ""} onValueChange={setDraftFlow}>
              <SelectTrigger size="sm" className="max-w-64 border-transparent bg-secondary/60" aria-label="Flow to run">
                <Workflow className="size-4" />
                <SelectValue placeholder="No flows yet" />
              </SelectTrigger>
              <SelectContent>
                {data.flows.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Ctrl+Enter to start</span>
            <Button type="submit" size="sm" disabled={!canStart}>
              {starting ? <Loader2 className="animate-spin" /> : <Play />} Start run
            </Button>
          </div>
        </form>

        {steps.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{flow!.name} runs these blocks, in order:</p>
            <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label={`${flow!.name} steps`}>
              {steps.map((s, i) => (
                <li key={s.id} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 text-muted-foreground/40" aria-hidden />}
                  <span className="flex h-6 items-center gap-1.5 rounded-full border px-2 text-muted-foreground">
                    <span style={{ color: s.color }}>
                      <BlockIcon name={s.icon} className="size-3.5" />
                    </span>
                    {s.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {flow && !flow.nodes.length && <p className="text-sm text-muted-foreground">{flow.name} has no blocks yet. Add some in the builder first.</p>}
        {flow && flow.nodes.length > 0 && !readsPrompt && (
          <p className="text-xs text-muted-foreground">
            No block in {flow.name} reads the task text. It's kept with the run for reference only.
          </p>
        )}

        {missing.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-amber-300" />
            <span className="min-w-0 flex-1">
              {flow!.name} needs values for <span className="font-mono text-xs">{missing.join(", ")}</span> before it can run.
            </span>
            <Button size="sm" variant="outline" onClick={openInputs}>
              Fill in inputs
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
